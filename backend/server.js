// VocalBridge backend V1. Menyimpan kunci API di server, memotong kredit, membatasi biaya.
// Dasar kode: backend tanpa dependensi dari sesi sebelumnya (kode akses ber-hash, kredit, endpoint admin),
// kini dengan tahan/kembalikan kredit, idempotensi, batas anggaran, validasi audio, dan kontrak provider.
// Butuh Node.js 20 ke atas. Tanpa dependensi luar.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const { buildProviders } = require('./lib/providers');
const { HttpError, redact, parseWav, RateLimiter, makeLogger } = require('./lib/util');

const VERSION = '1.0.0';

function createApp(cfg, { logSink } = {}) {
  const store = new Store(cfg.dataDir, { monthlyBudgetUsd: cfg.monthlyBudgetUsd, dailyCalls: cfg.dailyCallsPerCode });
  const providers = buildProviders(cfg);
  const log = makeLogger(logSink);
  const ipLimit = new RateLimiter(cfg.ipRatePerMin), failLimit = new RateLimiter(cfg.ipAuthFailPerMin), codeLimit = new RateLimiter(cfg.ratePerMin);
  const IDEM = new Map();

  store.sweep(0); // tahanan dari proses sebelumnya pasti yatim: kembalikan
  const sweeper = setInterval(() => { try { store.sweep(cfg.holdTtlMs); } catch (_) {} }, 30000); sweeper.unref();

  const clientIp = req => (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'x';

  function cors(req, res) {
    res.setHeader('Vary', 'Origin');
    const o = req.headers.origin;
    if (!o) return true;
    if (!(cfg.allowAnyOrigin || cfg.origins.includes(o))) return false;
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Admin-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Credits-Left, Idempotent-Replay');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  function sendRaw(res, status, headers, body) {
    res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }, headers));
    res.end(body);
  }
  const sendJson = (res, status, obj, extra) => sendRaw(res, status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}), JSON.stringify(obj));

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = +req.headers['content-length'];
      if (declared > limit) { req.resume(); return reject(new HttpError(413, 'berkas terlalu besar', 'too_large')); }
      const chunks = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'berkas terlalu besar', 'too_large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req, limit = 20000) {
    const b = await readBody(req, limit);
    try { const j = JSON.parse(b.toString('utf8') || '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (_) {}
    throw new HttpError(400, 'JSON tidak valid', 'bad_json');
  }

  function auth(req, ip) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const a = m ? store.authenticate(m[1].trim()) : null;
    if (!a) { if (!failLimit.hit(ip)) throw new HttpError(429, 'terlalu banyak percobaan', 'rate_limited'); throw new HttpError(401, 'kode akses diperlukan atau salah', 'unauthorized'); }
    if (!codeLimit.hit(a.id)) throw new HttpError(429, 'terlalu banyak permintaan', 'rate_limited');
    return a;
  }
  function admin(req) {
    const t = String(req.headers['x-admin-token'] || '');
    const ok = cfg.adminToken && t.length === cfg.adminToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(cfg.adminToken));
    if (!ok) throw new HttpError(401, 'token admin salah', 'unauthorized');
  }

  // ---------- jalur berbayar: validasi gratis -> tahan kredit -> panggil provider -> konfirmasi atau kembalikan ----------
  async function paid(a, req, kind, prep) {
    if (!cfg.paidEnabled || store.killed) throw new HttpError(503, 'layanan berbayar sedang dinonaktifkan oleh administrator', 'paid_disabled');
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9_\-]{8,64}$/.test(key)) throw new HttpError(400, 'header Idempotency-Key wajib (8-64 karakter huruf, angka, - atau _)', 'idem_required');
    const provider = providers.pick(kind);
    const p = await prep(provider);
    const now = Date.now();
    for (const [k, v] of IDEM) if (now - v.ts > cfg.idempotencyTtlMs) IDEM.delete(k);
    while (IDEM.size > 64) IDEM.delete(IDEM.keys().next().value);
    const mk = a.id + ':' + key;
    const hit = IDEM.get(mk);
    if (hit) { const out = await hit.promise; return { out, replay: true }; }
    const promise = (async () => {
      const hold = store.reserve(a.id, { credits: p.credits, usd: p.usd, key });
      try { const out = await p.run(provider); store.capture(hold); return out; }
      catch (e) { store.release(hold); throw e; }
    })();
    IDEM.set(mk, { promise, ts: now });
    try { return { out: await promise, replay: false }; }
    catch (e) { IDEM.delete(mk); throw e; }
  }
  const jsonOut = obj => ({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(obj)) });

  const sttPrep = (req, url) => async () => {
    const lang = url.searchParams.get('lang');
    if (!['id', 'en'].includes(lang)) throw new HttpError(400, 'parameter lang harus id atau en', 'bad_lang');
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['audio/wav', 'audio/x-wav', 'audio/wave'].includes(ct)) throw new HttpError(415, 'Content-Type harus audio/wav', 'bad_type');
    const wav = await readBody(req, cfg.maxAudioBytes);
    const info = parseWav(wav, { maxSeconds: cfg.maxAudioSeconds });
    return { credits: cfg.cost.stt, usd: Math.max(0.0003, info.seconds / 60 * cfg.usd.sttPerMin),
      run: async provider => { const r = await provider.transcribe({ wav, lang }); return jsonOut({ text: r.text, seconds: +info.seconds.toFixed(2) }); } };
  };
  const translatePrep = req => async () => {
    const b = await readJson(req);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > cfg.maxTranslateChars) throw new HttpError(400, 'teks kosong atau lebih dari ' + cfg.maxTranslateChars + ' karakter', 'bad_text');
    if (!['id', 'en'].includes(b.src) || !['id', 'en'].includes(b.tgt) || b.src === b.tgt) throw new HttpError(400, 'arah bahasa tidak valid', 'bad_lang');
    const context = Array.isArray(b.context) ? b.context.slice(-4).map(h => ({ side: h && h.side === 'me' ? 'me' : 'them', text: String((h && h.text) || '').slice(0, 300) })) : [];
    return { credits: cfg.cost.translate, usd: cfg.usd.translatePerCall,
      run: async provider => { const r = await provider.translate({ text, src: b.src, tgt: b.tgt, context }); return jsonOut({ text: r.text, engine: r.engine }); } };
  };
  const ttsPrep = req => async provider => {
    const b = await readJson(req);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > cfg.maxTtsChars) throw new HttpError(400, 'teks kosong atau lebih dari ' + cfg.maxTtsChars + ' karakter', 'bad_text');
    if (!['id', 'en'].includes(b.lang)) throw new HttpError(400, 'lang harus id atau en', 'bad_lang');
    if (b.voice != null && !provider.validVoice(b.voice)) throw new HttpError(400, 'suara tidak dikenal', 'bad_voice');
    const credits = Math.max(1, Math.ceil(text.length / 100)) * cfg.cost.ttsPer100;
    return { credits, usd: Math.max(0.0005, text.length / cfg.usd.ttsCharsPerSec / 60 * cfg.usd.ttsPerMin),
      run: async prov => { const r = await prov.synthesize({ text, lang: b.lang, voice: b.voice }); return { status: 200, headers: { 'Content-Type': r.contentType }, body: r.audio }; } };
  };

  // ---------- router ----------
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now(), rid = crypto.randomBytes(4).toString('hex');
    const url = new URL(req.url, 'http://x');
    const route = req.method + ' ' + url.pathname;
    const ip = clientIp(req);
    let cid = null;
    res.on('finish', () => log({ rid, m: req.method, p: url.pathname, s: res.statusCode, ms: Date.now() - t0, cid }));
    try {
      if (!cors(req, res)) return sendJson(res, 403, { error: 'origin tidak diizinkan', code: 'origin_denied' });
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (!ipLimit.hit(ip)) throw new HttpError(429, 'terlalu banyak permintaan', 'rate_limited');

      if (route === 'GET /' || route === 'GET /api/health')
        return sendJson(res, 200, { ok: true, service: 'vocalbridge-backend', version: VERSION, paid_enabled: cfg.paidEnabled && !store.killed });

      if (route === 'POST /admin/codes') {
        admin(req); const b = await readJson(req); const credits = Math.floor(+b.credits);
        if (!(credits > 0 && credits <= 1e6)) throw new HttpError(400, 'credits harus 1 sampai 1.000.000', 'bad_credits');
        const r = store.createCode({ name: b.name, credits, expiresDays: +b.expires_days || 0, dailyCalls: +b.daily_calls || 0 });
        return sendJson(res, 200, { code: r.code, credits, expires: r.expires, note: 'Simpan kode ini, tidak bisa ditampilkan lagi.' });
      }
      if (route === 'GET /admin/codes') { admin(req); return sendJson(res, 200, store.list()); }
      if (route === 'POST /admin/topup') { admin(req); const b = await readJson(req); return sendJson(res, 200, store.topup(b.id, b.credits, b.disabled)); }
      if (route === 'GET /admin/usage') { admin(req); return sendJson(res, 200, Object.assign(store.usage(), { paid_env_enabled: cfg.paidEnabled })); }
      if (route === 'POST /admin/kill') { admin(req); const b = await readJson(req); return sendJson(res, 200, { killed: store.setKill(b.enabled === false) }); }

      if (url.pathname.startsWith('/api/')) {
        const a = auth(req, ip); cid = a.id.slice(0, 8);
        const left = { 'X-Credits-Left': String(a.rec.credits) };
        if (route === 'GET /api/me')
          return sendJson(res, 200, { name: a.rec.name, credits: a.rec.credits, expires: a.rec.expires || null, paid_enabled: cfg.paidEnabled && !store.killed, providers: providers.status(),
            limits: { max_audio_seconds: cfg.maxAudioSeconds, max_translate_chars: cfg.maxTranslateChars, max_tts_chars: cfg.maxTtsChars },
            ai_notice: 'Audio dan teks dikirim ke OpenAI melalui server VocalBridge. Audio tidak disimpan. Suara terjemahan dihasilkan AI, bukan suara manusia.' }, left);
        if (route === 'POST /api/clone') throw new HttpError(503, 'klon suara dinonaktifkan di V1', 'provider_disabled');
        let kind = null, prep = null;
        if (route === 'POST /api/stt') { kind = 'stt'; prep = sttPrep(req, url); }
        else if (route === 'POST /api/translate') { kind = 'translate'; prep = translatePrep(req); }
        else if (route === 'POST /api/tts') { kind = 'tts'; prep = ttsPrep(req); }
        if (kind) {
          const { out, replay } = await paid(a, req, kind, prep);
          const h = Object.assign({}, out.headers, { 'X-Credits-Left': String(a.rec.credits) }); if (replay) h['Idempotent-Replay'] = 'true';
          return sendRaw(res, out.status, h, out.body);
        }
      }
      throw new HttpError(404, 'tidak ditemukan', 'not_found');
    } catch (e) {
      const status = e.status || 500;
      if (!e.status) log({ rid, err: redact(e && e.message).slice(0, 200) });
      else if (status >= 500) log({ rid, err: redact(e.message).slice(0, 200), code: e.code });
      const extra = e.credits != null ? { 'X-Credits-Left': String(e.credits) } : {};
      if (!res.headersSent) sendJson(res, status, { error: e.status ? e.message : 'kesalahan server', code: e.code || 'server_error' }, extra); else res.end();
    }
  });
  server.on('close', () => clearInterval(sweeper));
  return { server, store, providers, cfg };
}

function warnings(cfg) {
  const w = [];
  if (!cfg.adminToken || cfg.adminToken.length < 24) w.push('ADMIN_TOKEN kosong atau kurang dari 24 karakter');
  if (!cfg.origins.length && !cfg.allowAnyOrigin) w.push('ALLOWED_ORIGINS kosong: tidak ada web yang boleh memanggil server ini');
  if (cfg.allowAnyOrigin) w.push('ALLOW_ANY_ORIGIN aktif: hanya untuk pengembangan lokal');
  if (cfg.paidEnabled && !cfg.openai.key) w.push('PAID_API_ENABLED=true tetapi OPENAI_API_KEY kosong');
  return w;
}

if (require.main === module) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  app.server.listen(cfg.port, () => {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'VocalBridge backend jalan', port: cfg.port, version: VERSION, paid_enabled: cfg.paidEnabled,
      openai_key_set: !!cfg.openai.key, admin_set: !!cfg.adminToken, origins: cfg.origins }));
    warnings(cfg).forEach(m => console.warn(JSON.stringify({ warn: m })));
  });
  const stop = () => app.server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

module.exports = { createApp, warnings, VERSION };
