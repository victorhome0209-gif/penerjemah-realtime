'use strict';
// Server uji: halaman web + backend ASLI + OpenAI PALSU (tanpa kunci asli dan tanpa biaya).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, makeWav } = require('../../backend/test/helpers');

// WAV pengganti mikrofon: periode 7 detik, bising sangat pelan lalu satu "ucapan" nada 1,6 detik.
function fakeMicWav(file) {
  const rate = 48000, secs = 7, n = rate * secs, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate; let v = (Math.random() - 0.5) * 0.004;
    if (t > 1.2 && t < 2.8) v += 0.28 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 880 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, buf); return file;
}

async function startAll({ credits = 100, env = {} } = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'));
  const web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + web.address().port;
  const api = await startApp(Object.assign({ ALLOWED_ORIGINS: origin, OPENAI_TTS_FORMAT: 'wav' }, env));
  const m = api.mock;
  m.sttFor = lang => (lang === 'en' ? 'Could you explain the proposal?' : 'Saya akan menjelaskan rencananya.');
  m.translateFor = (text, sys) => {
    if (sys.includes('from English to Indonesian') && text === 'Could you explain the proposal?') return 'Bisakah Anda menjelaskan proposal tersebut?';
    if (sys.includes('from Indonesian to English') && text === 'Saya akan menjelaskan rencananya.') return 'I will explain the plan.';
    return 'T:' + text;
  };
  m.ttsBody = makeWav(0.4, 16000); m.ttsType = 'audio/wav';
  const code = await api.mkCode(credits);
  const wav = fakeMicWav(path.join(os.tmpdir(), 'vb-fake-mic.wav'));
  return { web, origin, api, code, B: api.B, wav, mock: m, async close() { await new Promise(r => web.close(r)); await api.close(); } };
}
module.exports = { startAll, fakeMicWav };
