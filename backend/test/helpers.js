'use strict';
// Perlengkapan tes: OpenAI palsu (tanpa kunci asli, tanpa biaya) dan pembuat aplikasi uji.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

async function startMock() {
  const m = { calls: { stt: 0, translate: 0, tts: 0 }, seen: [], fail: {}, delay: 0, rejectLanguagesField: false, rejectReasoning: false,
    inflight: { stt: 0, translate: 0, tts: 0 }, maxInflight: { stt: 0, translate: 0, tts: 0 }, sttFor: null, translateFor: null, ttsBody: null, ttsType: 'audio/mpeg', sttDelay: 0 };
  m.server = http.createServer((req, res) => {
    const ch = []; req.on('data', c => ch.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(ch);
      const kind = req.url.startsWith('/v1/audio/transcriptions') ? 'stt' : req.url.startsWith('/v1/chat/completions') ? 'translate' : req.url.startsWith('/v1/audio/speech') ? 'tts' : null;
      if (!kind) { res.statusCode = 404; return res.end('{}'); }
      m.calls[kind]++; m.seen.push({ kind, url: req.url, headers: req.headers, body });
      m.inflight[kind]++; m.maxInflight[kind] = Math.max(m.maxInflight[kind], m.inflight[kind]);
      try {
      if (m.delay) await new Promise(r => setTimeout(r, m.delay));
      if (kind === 'stt' && m.sttDelay) await new Promise(r => setTimeout(r, m.sttDelay));
      const f = m.fail[kind];
      if (f) { res.statusCode = f; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: ' + FAKE_OPENAI_KEY + '.' } })); }
      res.setHeader('content-type', 'application/json');
      if (kind === 'stt') {
        const s = body.toString('latin1');
        if (m.rejectLanguagesField && s.includes('name="languages[]"')) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "Unknown parameter: 'languages[]'. Use 'language'." } })); }
        const lang = (/name="languages?(?:\[\])?"\r\n\r\n([a-z]+)/.exec(s) || [])[1];
        return res.end(JSON.stringify({ text: m.sttFor ? m.sttFor(lang) : ' halo dunia ' }));
      }
      if (kind === 'translate') {
        const j = JSON.parse(body.toString());
        if (m.rejectReasoning && j.reasoning_effort) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } })); }
        const out = m.translateFor ? m.translateFor(j.messages[1].content, j.messages[0].content) : 'T:' + j.messages[1].content;
        return res.end(JSON.stringify({ choices: [{ message: { content: out } }] }));
      }
      res.setHeader('content-type', m.ttsType); res.end(m.ttsBody || Buffer.from('MP3DATA'));
      } finally { m.inflight[kind]--; }
    });
  });
  await new Promise(r => m.server.listen(0, '127.0.0.1', r));
  m.base = 'http://127.0.0.1:' + m.server.address().port;
  return m;
}

// Membuat aplikasi uji lengkap dengan OpenAI palsu. env menimpa bawaan.
async function startApp(env = {}, preSeed) {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-test-'));
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
    adminCall: (p, body, method) => fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
    async mkCode(credits = 50, extra = {}) { const r = await api.adminCall('/admin/codes', Object.assign({ name: 'Tester', credits }, extra)); return (await r.json()).code; },
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
    credits: async code => (await (await api.call(code, '/api/me', { method: 'GET' })).json()).credits,
    async close() { await new Promise(r => app.server.close(r)); await new Promise(r => mock.server.close(r)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  };
  return api;
}

module.exports = { startApp, makeWav, FAKE_OPENAI_KEY, ADMIN, ORIGIN };
