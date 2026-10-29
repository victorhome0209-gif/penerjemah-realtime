'use strict';
// Kontrak permintaan ke OpenAI. Mock KETAT menolak parameter di luar dokumentasi (referensi API dan sumber SDK openai-node, 29 Okt 2026).
// Tes ini memakai mock saja: tidak ada panggilan OpenAI nyata.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeWav } = require('./helpers');
const { loadConfig } = require('../lib/config');
const { modelWarnings, MODELS } = require('../lib/models');

const apps = [];
const boot = async (env) => { const a = await startApp(env); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, [], 'pelanggaran kontrak: ' + a.mock.violations.join('; ')); await a.close(); } });
const fields = body => [...body.toString('latin1').matchAll(/[; ]name="([^"]+)"/g)].map(m => m[1]);
const fieldVal = (body, n) => (new RegExp('name="' + n.replace(/[[\]]/g, '\\$&') + '"\\r\\n\\r\\n([^\\r]*)').exec(body.toString('latin1')) || [])[1];

test('STT gpt-transcribe: persis file, model, languages[] (tanpa language, response_format, temperature)', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  await a.stt(code); await a.call(code, '/api/stt?lang=en', { wav: makeWav(1) });
  const [s1, s2] = a.mock.seen;
  assert.deepEqual(fields(s1.body), ['file', 'model', 'languages[]']); assert.equal(fieldVal(s1.body, 'model'), 'gpt-transcribe');
  assert.equal(fieldVal(s1.body, 'languages[]'), 'id'); assert.equal(fieldVal(s2.body, 'languages[]'), 'en');
  assert.match(s1.headers['content-type'], /^multipart\/form-data; boundary=/); assert.equal(s1.headers.authorization, 'Bearer sk-SECRET-TEST-KEY-1234567890');
});

test('STT model lama (whisper-1): hanya language; override OPENAI_STT_LANG_FIELD; tidak pernah keduanya', async () => {
  const a = await boot({ OPENAI_MODEL_STT: 'whisper-1' }); const code = await a.mkCode(10); await a.stt(code);
  assert.deepEqual(fields(a.mock.seen[0].body), ['file', 'model', 'language']);
  const b = await boot({ OPENAI_STT_LANG_FIELD: 'language' }); const c2 = await b.mkCode(10); await b.stt(c2);
  assert.deepEqual(fields(b.mock.seen[0].body), ['file', 'model', 'language']);
});

test('terjemahan: model gpt-6-luna, peran developer, store:false, max_completion_tokens, reasoning_effort none, safety_identifier; tanpa temperature/max_tokens', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  await a.call(code, '/api/translate', { json: { text: 'Selamat pagi', src: 'id', tgt: 'en', context: [{ side: 'them', text: 'How are you?' }] } });
  const j = JSON.parse(a.mock.seen[0].body);
  assert.deepEqual(Object.keys(j).sort(), ['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'safety_identifier', 'store']);
  assert.equal(j.model, 'gpt-6-luna'); assert.equal(j.store, false); assert.equal(j.reasoning_effort, 'none'); assert.equal(j.max_completion_tokens, 400);
  assert.equal(j.messages[0].role, 'developer'); assert.equal(j.messages[1].role, 'user'); assert.equal(j.messages[1].content, 'Selamat pagi');
  assert.match(j.messages[0].content, /from Indonesian to English/); assert.match(j.messages[0].content, /Client: How are you\?/);
  assert.match(j.safety_identifier, /^vb-[0-9a-f]{32}$/); assert.ok(!j.safety_identifier.includes(code) && j.safety_identifier.length <= 128);
});

test('safety_identifier stabil per kode, berbeda antar kode, tidak memuat kode akses', async () => {
  const a = await boot(); const c1 = await a.mkCode(10), c2 = await a.mkCode(10);
  await a.translate(c1); await a.translate(c1, 'Lagi'); await a.translate(c2);
  const ids = a.mock.seen.map(s => JSON.parse(s.body).safety_identifier);
  assert.equal(ids[0], ids[1]); assert.notEqual(ids[0], ids[2]);
});

test('terjemahan: peran system, reasoning dihilangkan, safety id dimatikan lewat konfigurasi', async () => {
  const a = await boot({ OPENAI_INSTRUCTION_ROLE: 'system', OPENAI_TRANSLATE_REASONING: '', OPENAI_SAFETY_ID: 'false' }); const code = await a.mkCode(10); await a.translate(code);
  const j = JSON.parse(a.mock.seen[0].body); assert.equal(j.messages[0].role, 'system'); assert.ok(!('reasoning_effort' in j)); assert.ok(!('safety_identifier' in j)); assert.equal(j.store, false);
});

test('TTS gpt-4o-mini-tts: model, voice, input, response_format, instructions; tts-1 tanpa instructions', async () => {
  const a = await boot(); const code = await a.mkCode(10); await a.tts(code, 'Hello there'); await a.call(code, '/api/tts', { json: { text: 'Halo', lang: 'id', voice: 'cedar' } });
  const [t1, t2] = a.mock.seen.map(s => JSON.parse(s.body));
  assert.deepEqual(Object.keys(t1).sort(), ['input', 'instructions', 'model', 'response_format', 'voice']); assert.equal(t1.voice, 'marin'); assert.equal(t1.response_format, 'mp3');
  assert.equal(t2.voice, 'cedar'); assert.match(t2.instructions, /Indonesian/);
  const b = await boot({ OPENAI_MODEL_TTS: 'tts-1' }); const c2 = await b.mkCode(10); await b.tts(c2);
  assert.deepEqual(Object.keys(JSON.parse(b.mock.seen[0].body)).sort(), ['input', 'model', 'response_format', 'voice']);
});

test('TTS: suara tak dikenal ditolak backend tanpa menghubungi penyedia; format keluaran menentukan content-type', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  assert.equal((await a.call(code, '/api/tts', { json: { text: 'x', lang: 'en', voice: '../etc' } })).status, 400); assert.equal(a.mock.calls.tts, 0);
  for (const [fmt, type] of [['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['opus', 'audio/ogg'], ['flac', 'audio/flac']]) {
    const b = await boot({ OPENAI_TTS_FORMAT: fmt }); const c2 = await b.mkCode(10); b.mock.ttsType = type; const r = await b.tts(c2); assert.equal(r.headers.get('content-type'), type, fmt);
  }
});

test('X-Client-Request-Id = ID transaksi untuk ketiga endpoint, ID penyedia tersimpan; dapat dimatikan', async () => {
  const a = await boot(); const code = await a.mkCode(20); await a.stt(code); await a.translate(code); await a.tts(code);
  const txns = (await a.adm('/admin/transactions?state=CONFIRMED')).json;
  assert.equal(txns.length, 3);
  for (const s of a.mock.seen) assert.ok(txns.some(t => t.txn === s.headers['x-client-request-id']), s.kind);
  assert.ok(txns.every(t => /^req_mock_\d+$/.test(t.provider_request_id)));
  const b = await boot({ OPENAI_CLIENT_REQUEST_ID: 'false' }); const c2 = await b.mkCode(10); await b.translate(c2); assert.equal(b.mock.seen[0].headers['x-client-request-id'], undefined);
});

test('setiap transaksi = tepat satu permintaan HTTP ke OpenAI (tanpa percobaan ulang) pada semua jenis galat', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '150' }); const code = await a.mkCode(100);
  const cases = [{ fail: { stt: 400 } }, { fail: { stt: 429 } }, { fail: { stt: 500 } }, { chaos: { stt: 'reset' } }, { chaos: { stt: 'badjson' } }, { delay: 400 }];
  for (const c of cases) { a.mock.fail = c.fail || {}; a.mock.chaos = c.chaos || {}; a.mock.delay = c.delay || 0; const before = a.mock.calls.stt; await a.stt(code); assert.equal(a.mock.calls.stt - before, 1, JSON.stringify(c)); }
});

test('peringatan model: TTS dan STT lama deprecated dengan tanggal, model tak dikenal, model salah jenis', () => {
  const w = modelWarnings(loadConfig({}), Date.parse('2026-10-29T00:00:00Z'));
  assert.equal(w.length, 1); assert.match(w[0], /gpt-4o-mini-tts.*2027-01-06.*69 hari lagi/);
  const w2 = modelWarnings(loadConfig({ OPENAI_MODEL_STT: 'gpt-4o-mini-transcribe', OPENAI_MODEL_TRANSLATE: 'model-ajaib', OPENAI_MODEL_TTS: 'tts-1' }), Date.parse('2027-01-10T00:00:00Z'));
  assert.ok(w2.some(x => /gpt-4o-mini-transcribe.*2027-02-26/.test(x))); assert.ok(w2.some(x => /model-ajaib.*tidak ada dalam daftar/.test(x))); assert.ok(w2.some(x => /tts-1.*SUDAH BERHENTI/.test(x)));
  assert.ok(modelWarnings(loadConfig({ OPENAI_MODEL_STT: 'gpt-6-luna' })).some(x => /model chat|bukan stt|translate/.test(x)));
  assert.ok(MODELS['gpt-transcribe'].status === 'current' && MODELS['gpt-6-luna'].status === 'current');
});

test('mock ketat sungguh menolak permintaan yang menyimpang (uji kebalikan agar kontrak tidak ditulis longgar)', async () => {
  const a = await boot(); a.mock.violations = [];
  const post = (p, body, h = {}) => fetch(a.mock.base + p, { method: 'POST', headers: Object.assign({ Authorization: 'Bearer sk-x', 'Content-Type': 'application/json' }, h), body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post('/v1/chat/completions', { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, aneh: 1 })).status, 400);
  assert.equal((await post('/v1/chat/completions', { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], max_tokens: 5, max_completion_tokens: 5 })).status, 400);
  assert.equal((await post('/v1/audio/speech', { model: 'tts-1', voice: 'marin', input: 'x', instructions: 'pelan' })).status, 400);
  assert.equal((await post('/v1/audio/speech', { model: 'gpt-4o-mini-tts', voice: 'suara-x', input: 'x' })).status, 400);
  assert.equal((await post('/v1/chat/completions', { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }] }, { 'X-Client-Request-Id': 'tidak-ascii-é' })).status, 400);
  assert.equal(a.mock.violations.length, 5); a.mock.violations = [];
});
