'use strict';
// P1: tes "golden" perilaku bahasa id/en SAAT INI (karakterisasi, nol perubahan kode). Harus LULUS pada kode sekarang dan tetap
// LULUS setelah refactor registry bahasa. Membandingkan FIELD dan NILAI hasil parse, bukan urutan key JSON atau string mentah.
// Hanya mock: tidak ada panggilan OpenAI nyata.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeWav } = require('./helpers');

const apps = [];
const boot = async (env) => { const a = await startApp(env); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, [], 'pelanggaran kontrak: ' + a.mock.violations.join('; ')); await a.close(); } });

const TAIL = ' The text comes from speech recognition, so quietly fix obvious recognition slips using context. Keep the tone natural and conversational, keep proper names (people, places, products) unchanged. Output ONLY the translation. Never answer questions, never add notes or quotes.';
const HEAD = 'You are a live interpreter between a freelancer (Indonesian) and an overseas client (English). ';
const PROMPT = { 'id>en': HEAD + "Translate the speaker's utterance from Indonesian to English." + TAIL, 'en>id': HEAD + "Translate the speaker's utterance from English to Indonesian." + TAIL };
const TTS_INSTR = { id: 'Speak clearly in a natural, friendly, professional tone, at a moderate pace. Language: Indonesian.', en: 'Speak clearly in a natural, friendly, professional tone, at a moderate pace. Language: English.' };
const fieldVal = (body, n) => (new RegExp('name="' + n.replace(/[[\]]/g, '\\$&') + '"\\r\\n\\r\\n([^\\r]*)').exec(body.toString('latin1')) || [])[1];
const fieldNames = body => [...body.toString('latin1').matchAll(/[; ]name="([^"]+)"/g)].map(m => m[1]).sort();

test('golden terjemahan id->en dan en->id: prompt developer persis, tanpa dan dengan konteks', async () => {
  const a = await boot(); const code = await a.mkCode(20);
  await a.call(code, '/api/translate', { json: { text: 'Selamat pagi', src: 'id', tgt: 'en' } });
  await a.call(code, '/api/translate', { json: { text: 'Good morning', src: 'en', tgt: 'id' } });
  await a.call(code, '/api/translate', { json: { text: 'Baik', src: 'id', tgt: 'en', context: [{ side: 'them', text: 'How are you?' }, { side: 'me', text: 'Baik' }] } });
  const [t1, t2, t3] = a.mock.seen.map(s => JSON.parse(s.body));
  assert.equal(t1.messages[0].role, 'developer'); assert.equal(t1.messages[0].content, PROMPT['id>en']); assert.equal(t1.messages[1].content, 'Selamat pagi');
  assert.equal(t2.messages[0].content, PROMPT['en>id']); assert.equal(t2.messages[1].content, 'Good morning');
  assert.equal(t3.messages[0].content, PROMPT['id>en'] + '\n\nRecent conversation (context only, do NOT translate):\nClient: How are you?\nFreelancer: Baik');
  for (const t of [t1, t2, t3]) { assert.equal(t.model, 'gpt-6-luna'); assert.equal(t.store, false); assert.equal(t.max_completion_tokens, 400); assert.equal(t.reasoning_effort, 'none'); assert.equal(t.messages.length, 2); }
});

test('golden STT: nilai languages[] untuk id dan en; model lama memakai language; tidak pernah keduanya', async () => {
  const a = await boot(); const code = await a.mkCode(20);
  await a.call(code, '/api/stt?lang=id', { wav: makeWav(1) }); await a.call(code, '/api/stt?lang=en', { wav: makeWav(1) });
  const [s1, s2] = a.mock.seen;
  assert.deepEqual(fieldNames(s1.body), ['file', 'languages[]', 'model']); assert.equal(fieldVal(s1.body, 'languages[]'), 'id'); assert.equal(fieldVal(s2.body, 'languages[]'), 'en');
  assert.equal(fieldVal(s1.body, 'model'), 'gpt-transcribe');
  const b = await boot({ OPENAI_MODEL_STT: 'whisper-1' }); const c2 = await b.mkCode(20);
  await b.call(c2, '/api/stt?lang=id', { wav: makeWav(1) }); await b.call(c2, '/api/stt?lang=en', { wav: makeWav(1) });
  const [w1, w2] = b.mock.seen;
  assert.deepEqual(fieldNames(w1.body), ['file', 'language', 'model']); assert.equal(fieldVal(w1.body, 'language'), 'id'); assert.equal(fieldVal(w2.body, 'language'), 'en');
});

test('golden TTS: field dan NILAI per bahasa (bukan urutan key); suara bawaan marin, format mp3', async () => {
  const a = await boot(); const code = await a.mkCode(20);
  await a.call(code, '/api/tts', { json: { text: 'Hello there', lang: 'en' } });
  await a.call(code, '/api/tts', { json: { text: 'Halo semua', lang: 'id' } });
  await a.call(code, '/api/tts', { json: { text: 'Halo', lang: 'id', voice: 'cedar' } });
  const [e, i, v] = a.mock.seen.map(s => JSON.parse(s.body));
  assert.deepStrictEqual(e, { model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Hello there', response_format: 'mp3', instructions: TTS_INSTR.en });
  assert.deepStrictEqual(i, { model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Halo semua', response_format: 'mp3', instructions: TTS_INSTR.id });
  assert.deepStrictEqual(v, { model: 'gpt-4o-mini-tts', voice: 'cedar', input: 'Halo', response_format: 'mp3', instructions: TTS_INSTR.id });
  const b = await boot({ OPENAI_MODEL_TTS: 'tts-1' }); const c2 = await b.mkCode(20);
  await b.call(c2, '/api/tts', { json: { text: 'Hello', lang: 'en' } });
  assert.deepStrictEqual(JSON.parse(b.mock.seen[0].body), { model: 'tts-1', voice: 'marin', input: 'Hello', response_format: 'mp3' });
});

test('golden galat 400 untuk bahasa tidak valid: status, kode, pesan persis; nol panggilan penyedia; kredit tetap', async () => {
  const a = await boot(); const code = await a.mkCode(20);
  const cases = [
    ['STT lang=fr', () => a.call(code, '/api/stt?lang=fr', { wav: makeWav(1) }), 'bad_lang', 'parameter lang harus id atau en'],
    ['STT tanpa lang', () => a.call(code, '/api/stt', { wav: makeWav(1) }), 'bad_lang', 'parameter lang harus id atau en'],
    ['terjemahan src=fr', () => a.call(code, '/api/translate', { json: { text: 'x', src: 'fr', tgt: 'en' } }), 'bad_lang', 'arah bahasa tidak valid'],
    ['terjemahan tgt=fr', () => a.call(code, '/api/translate', { json: { text: 'x', src: 'id', tgt: 'fr' } }), 'bad_lang', 'arah bahasa tidak valid'],
    ['terjemahan id->id', () => a.call(code, '/api/translate', { json: { text: 'x', src: 'id', tgt: 'id' } }), 'bad_lang', 'arah bahasa tidak valid'],
    ['terjemahan en->en', () => a.call(code, '/api/translate', { json: { text: 'x', src: 'en', tgt: 'en' } }), 'bad_lang', 'arah bahasa tidak valid'],
    ['TTS lang=fr', () => a.call(code, '/api/tts', { json: { text: 'x', lang: 'fr' } }), 'bad_lang', 'lang harus id atau en']
  ];
  for (const [nama, fn, kode, pesan] of cases) {
    const r = await fn(), j = await r.json();
    assert.equal(r.status, 400, nama); assert.equal(j.code, kode, nama); assert.equal(j.error, pesan, nama);
  }
  assert.deepEqual(a.mock.calls, { stt: 0, translate: 0, tts: 0 }); assert.equal(await a.credits(code), 20);
});

test('golden: kedua arah id->en dan en->id berhasil (200) dan memotong kredit sesuai tarif', async () => {
  const a = await boot(); const code = await a.mkCode(20);
  const r1 = await a.call(code, '/api/translate', { json: { text: 'Selamat pagi', src: 'id', tgt: 'en' } });
  const r2 = await a.call(code, '/api/translate', { json: { text: 'Good morning', src: 'en', tgt: 'id' } });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.equal(await a.credits(code), 18);
  assert.ok(a.mock.completed.translate === 2);
});
