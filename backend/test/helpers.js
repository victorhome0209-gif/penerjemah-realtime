'use strict';
// Perlengkapan tes: OpenAI palsu yang KETAT (menolak parameter di luar kontrak dokumentasi), mode kekacauan,
// pembuat aplikasi uji, dan peluncur proses backend terpisah (untuk tes restart/kill sungguhan).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../server');

const FAKE_OPENAI_KEY = 'sk-SECRET-TEST-KEY-1234567890';
const ADMIN = 'admin-token-for-tests-0123456789abcdef';
const ORIGIN = 'https://victorhome0209-gif.github.io';

function makeWav(seconds = 1, rate = 16000) {
  const n = Math.floor(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return buf;
}

// ---- kontrak permintaan OpenAI menurut dokumentasi (diperiksa 29 Okt 2026) ----
const STT_FIELDS = ['file', 'model', 'languages[]', 'language', 'keywords[]', 'prompt', 'response_format', 'temperature', 'stream', 'include[]', 'chunking_strategy', 'timestamp_granularities[]'];
const STT_MODELS = ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
const CHAT_FIELDS = ['model', 'messages', 'reasoning_effort', 'max_completion_tokens', 'max_tokens', 'temperature', 'top_p', 'store', 'user', 'safety_identifier', 'prompt_cache_key'];
const CHAT_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TTS_FIELDS = ['input', 'model', 'voice', 'instructions', 'response_format', 'speed', 'stream_format'];
const TTS_MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'];
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const AUDIO_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];

function validate(kind, req, body) {
  const h = req.headers;
  if (!/^Bearer sk-/.test(h.authorization || '')) return 'Authorization Bearer tidak ada';
  if (h['x-client-request-id'] != null && !(/^[\x20-\x7e]{1,512}$/.test(h['x-client-request-id']))) return 'X-Client-Request-Id tidak valid';
  if (kind === 'stt') {
    const s = body.toString('latin1'), names = [...s.matchAll(/[; ]name="([^"]+)"/g)].map(m => m[1]);
    const bad = names.filter(n => !STT_FIELDS.includes(n)); if (bad.length) return 'kolom STT tidak dikenal: ' + bad.join();
    if (!names.includes('file') || !names.includes('model')) return 'file dan model wajib';
    if (names.includes('languages[]') && names.includes('language')) return 'languages[] dan language tidak boleh bersamaan';
    const model = (/name="model"\r\n\r\n([^\r]+)/.exec(s) || [])[1];
    if (!STT_MODELS.includes(model)) return 'model STT tidak dikenal: ' + model;
    if (names.includes('languages[]') && !/^gpt-transcribe/.test(model)) return 'languages[] hanya didukung gpt-transcribe';
    const langs = [...s.matchAll(/name="languages?(?:\[\])?"\r\n\r\n([^\r]*)/g)].map(m => m[1]); if (langs.some(l => !/^[a-z]{2}$/.test(l))) return 'kode bahasa bukan ISO-639-1';
    return null;
  }
  let j; try { j = JSON.parse(body.toString()); } catch (_) { return 'JSON tidak valid'; }
  if (kind === 'translate') {
    const bad = Object.keys(j).filter(k => !CHAT_FIELDS.includes(k)); if (bad.length) return 'kolom chat tidak dikenal: ' + bad.join();
    if (!CHAT_MODELS.includes(j.model)) return 'model chat tidak dikenal: ' + j.model;
    if (!Array.isArray(j.messages) || !j.messages.length || j.messages.some(m => !['developer', 'system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) return 'messages tidak valid';
    if (j.reasoning_effort != null && !EFFORTS.includes(j.reasoning_effort)) return 'reasoning_effort tidak valid';
    if (j.max_tokens != null && j.max_completion_tokens != null) return 'max_tokens dan max_completion_tokens bersamaan';
    if (j.store != null && typeof j.store !== 'boolean') return 'store harus boolean';
    if (j.safety_identifier != null && (typeof j.safety_identifier !== 'string' || j.safety_identifier.length > 128)) return 'safety_identifier tidak valid';
    return null;
  }
  const bad = Object.keys(j).filter(k => !TTS_FIELDS.includes(k)); if (bad.length) return 'kolom TTS tidak dikenal: ' + bad.join();
  if (!TTS_MODELS.includes(j.model)) return 'model TTS tidak dikenal: ' + j.model;
  if (!VOICES.includes(j.voice)) return 'voice tidak dikenal: ' + j.voice;
  if (typeof j.input !== 'string' || !j.input || j.input.length > 4096) return 'input tidak valid';
  if (j.instructions != null && /^tts-1/.test(j.model)) return 'instructions tidak berlaku untuk tts-1';
  if (j.response_format != null && !AUDIO_FORMATS.includes(j.response_format)) return 'response_format tidak valid';
  return null;
}

async function startMock() {
  const m = { calls: { stt: 0, translate: 0, tts: 0 }, completed: { stt: 0, translate: 0, tts: 0 }, seen: [], fail: {}, chaos: {}, delay: 0, sttDelay: 0, strict: true, violations: [],
    inflight: { stt: 0, translate: 0, tts: 0 }, maxInflight: { stt: 0, translate: 0, tts: 0 }, sttFor: null, translateFor: null, ttsBody: null, ttsType: 'audio/mpeg' };
  m.server = http.createServer((req, res) => {
    const ch = []; req.on('data', c => ch.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(ch);
      const kind = req.url.startsWith('/v1/audio/transcriptions') ? 'stt' : req.url.startsWith('/v1/chat/completions') ? 'translate' : req.url.startsWith('/v1/audio/speech') ? 'tts' : null;
      if (!kind) { res.statusCode = 404; return res.end('{}'); }
      m.calls[kind]++; m.seen.push({ kind, url: req.url, headers: req.headers, body });
      m.inflight[kind]++; m.maxInflight[kind] = Math.max(m.maxInflight[kind], m.inflight[kind]);
      try {
        if (m.strict) {
          const v = validate(kind, req, body);
          if (v) { m.violations.push(kind + ': ' + v); res.statusCode = 400; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: 'strict mock: ' + v } })); }
        }
        if (m.delay) await new Promise(r => setTimeout(r, m.delay));
        if (kind === 'stt' && m.sttDelay) await new Promise(r => setTimeout(r, m.sttDelay));
        const f = m.fail[kind];
        if (f) { res.statusCode = f; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: ' + FAKE_OPENAI_KEY + '.' } })); }
        const chaos = m.chaos[kind];
        if (chaos === 'reset') { m.completed[kind]++; res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' }); res.write('{"te'); return setTimeout(() => res.socket.destroy(), 20); }
        if (chaos === 'badjson') { m.completed[kind]++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{not json'); }
        if (chaos === 'empty') { m.completed[kind]++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
        m.completed[kind]++;
        res.setHeader('x-request-id', 'req_mock_' + m.calls[kind]);
        if (kind === 'stt') {
          const s = body.toString('latin1'), lang = (/name="languages?(?:\[\])?"\r\n\r\n([a-z]+)/.exec(s) || [])[1];
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ text: m.sttFor ? m.sttFor(lang) : ' halo dunia ', usage: { type: 'duration', seconds: 1 } }));
        }
        if (kind === 'translate') {
          const j = JSON.parse(body.toString()); res.setHeader('content-type', 'application/json');
          const out = m.translateFor ? m.translateFor(j.messages[1].content, j.messages[0].content) : 'T:' + j.messages[1].content;
          return res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
        }
        res.setHeader('content-type', m.ttsType); res.end(m.ttsBody || Buffer.from('MP3DATA'));
      } finally { m.inflight[kind]--; }
    });
  });
  await new Promise(r => m.server.listen(0, '127.0.0.1', r));
  m.base = 'http://127.0.0.1:' + m.server.address().port;
  return m;
}

// Aplikasi uji (dalam proses) lengkap dengan OpenAI palsu ketat. env menimpa bawaan.
async function startApp(env = {}, preSeed) {
  const mock = await startMock();
  const dir = env.__DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vb-test-'));
  delete env.__DIR;
  if (preSeed) preSeed(dir);
  const logs = [];
  const E = Object.assign({ OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE: mock.base, ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: ORIGIN,
    DATA_DIR: dir, PAID_API_ENABLED: 'true', MONTHLY_BUDGET_USD: '5' }, env);
  const cfg = loadConfig(E);
  const app = createApp(cfg, { logSink: l => logs.push(l) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + app.server.address().port;
  let n = 0;
  const api = {
    B, mock, logs, dir, cfg, store: app.store, app,
    adminCall: (p, body, method) => fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'application/json' }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }),
    adm: async (p, body) => { const r = await api.adminCall(p, body); return { status: r.status, json: await r.json() }; },
    rid: () => 'req-' + (++n) + '-' + Math.random().toString(36).slice(2, 10),
    async mkCode(credits = 50, extra = {}) { const r = await api.adminCall('/admin/codes', Object.assign({ name: 'Tester', credits }, extra)); return (await r.json()).code; },
    shortId: code => app.store.hash(code).slice(0, 8),
    key: () => 'idem-' + (++n) + '-' + Math.random().toString(36).slice(2, 10),
    call(code, p, { method = 'POST', json, wav, key, headers = {} } = {}) {
      const h = Object.assign({}, headers);
      if (code) h.Authorization = 'Bearer ' + code;
      if (key !== null && method === 'POST') h['Idempotency-Key'] = key || api.key();
      let body;
      if (wav) { h['Content-Type'] = h['Content-Type'] || 'audio/wav'; body = wav; } else if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      return fetch(B + p, { method, headers: h, body });
    },
    translate: (code, text = 'Selamat pagi', o = {}) => api.call(code, '/api/translate', Object.assign({ json: { text, src: 'id', tgt: 'en' } }, o)),
    stt: (code, o = {}) => api.call(code, '/api/stt?lang=id', Object.assign({ wav: makeWav(1) }, o)),
    tts: (code, text = 'Hello there', o = {}) => api.call(code, '/api/tts', Object.assign({ json: { text, lang: 'en' } }, o)),
    me: async code => (await api.call(code, '/api/me', { method: 'GET' })).json(),
    credits: async code => (await api.me(code)).credits,
    audit: () => app.store.audit(),
    async close() { await new Promise(r => app.server.close(r)); await new Promise(r => mock.server.close(r)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  };
  return api;
}

// Proses backend TERPISAH (untuk mematikan paksa dengan SIGKILL). Port dibaca dari log start.
async function spawnBackend(env, dir) {
  const E = Object.assign({}, process.env, { PORT: '0', DATA_DIR: dir, ADMIN_TOKEN: ADMIN, OPENAI_API_KEY: FAKE_OPENAI_KEY, PAID_API_ENABLED: 'true', MONTHLY_BUDGET_USD: '5', ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY: 'false', LOCK_STALE_MS: '400', LOCK_WAIT_MS: '3000' }, env);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: E, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', port = null;
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('backend tidak start: ' + out)), 8000);
    p.stdout.on('data', d => { out += d; const m = /"msg":"VocalBridge backend jalan","port":(\d+)/.exec(out); if (m && !port) { port = +m[1]; clearTimeout(to); resolve(); } });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', c => { if (!port) { clearTimeout(to); reject(new Error('backend berhenti (' + c + '): ' + out)); } });
  });
  await ready;
  const B = 'http://127.0.0.1:' + port;
  const adm = async (pth, body) => { const r = await fetch(B + pth, { method: body ? 'POST' : 'GET', headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  return { p, B, adm, out: () => out, kill: () => new Promise(r => { p.once('exit', r); p.kill('SIGKILL'); }),
    me: async code => (await fetch(B + '/api/me', { headers: { Authorization: 'Bearer ' + code } })).json(),
    translate: (code, key, text = 'Selamat pagi') => fetch(B + '/api/translate', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, src: 'id', tgt: 'en' }) }) };
}

module.exports = { startApp, startMock, spawnBackend, makeWav, FAKE_OPENAI_KEY, ADMIN, ORIGIN };
