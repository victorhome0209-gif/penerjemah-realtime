'use strict';
// Tes kredit dan biaya: tahan/kembalikan, idempotensi, benturan, batas harian dan anggaran, validasi input, fallback parameter.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp, makeWav } = require('./helpers');
const { parseWav } = require('../lib/util');

const apps = [];
const boot = async (env, seed) => { const a = await startApp(env, seed); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, [], 'permintaan ke OpenAI melanggar kontrak dokumentasi'); assert.deepEqual(a.audit(), [], 'audit konsistensi saldo'); await a.close(); } });
const wait = ms => new Promise(r => setTimeout(r, ms));

test('terjemahan: hasil benar, kredit -1, konteks dan arah ikut, tanpa parameter temperature', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const r = await a.call(code, '/api/translate', { json: { text: 'Selamat pagi', src: 'id', tgt: 'en', context: [{ side: 'them', text: 'How are you?' }] } });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.text, 'T:Selamat pagi'); assert.equal(r.headers.get('x-credits-left'), '9');
  const sent = JSON.parse(a.mock.seen[0].body.toString());
  assert.equal(sent.model, 'gpt-6-luna'); assert.equal(sent.reasoning_effort, 'none'); assert.ok(!('temperature' in sent));
  assert.ok(sent.messages[0].content.includes('from Indonesian to English')); assert.ok(sent.messages[0].content.includes('Client: How are you?'));
});

test('STT: WAV valid diteruskan multipart ke model gpt-transcribe, kredit -2', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const r = await a.stt(code); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.text, 'halo dunia'); assert.equal(await a.credits(code), 8);
  const body = a.mock.seen[0].body.toString('latin1');
  assert.ok(body.includes('gpt-transcribe')); assert.ok(body.includes('name="languages[]"')); assert.ok(body.includes('RIFF'));
});

test('TTS: audio diteruskan, kredit dihitung per 100 karakter', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const r = await a.tts(code, 'x'.repeat(250)); const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(buf.toString(), 'MP3DATA'); assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await a.credits(code), 7);
  const sent = JSON.parse(a.mock.seen[0].body.toString());
  assert.equal(sent.model, 'gpt-4o-mini-tts'); assert.equal(sent.voice, 'marin'); assert.ok(sent.instructions.includes('English'));
});

test('Idempotency-Key wajib untuk panggilan berbayar', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const r = await a.translate(code, 'Halo', { key: null });
  assert.equal(r.status, 400); assert.equal((await r.json()).code, 'idem_required'); assert.equal(a.mock.calls.translate, 0);
  assert.equal((await a.translate(code, 'Halo', { key: 'pendek' })).status, 400);
});

test('pengulangan request dengan kunci sama: satu panggilan penyedia, satu pemotongan, balasan sama', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const k = 'kunci-ulang-001';
  const r1 = await a.translate(code, 'Halo dunia', { key: k }); const j1 = await r1.json();
  const r2 = await a.translate(code, 'Halo dunia', { key: k }); const j2 = await r2.json();
  assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.deepEqual(j1, j2);
  assert.equal(r2.headers.get('idempotent-replay'), 'true'); assert.equal(a.mock.calls.translate, 1); assert.equal(await a.credits(code), 9);
});

test('dua permintaan kembar bersamaan: hanya satu panggilan dan satu pemotongan', async () => {
  const a = await boot(); const code = await a.mkCode(10); a.mock.delay = 150;
  const k = 'kunci-kembar-001';
  const [r1, r2] = await Promise.all([a.translate(code, 'Halo', { key: k }), a.translate(code, 'Halo', { key: k })]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.equal(a.mock.calls.translate, 1);
  a.mock.delay = 0; assert.equal(await a.credits(code), 9);
});

test('kunci yang sama setelah server restart tidak memotong ganda (409)', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  await a.translate(code, 'Halo', { key: 'kunci-restart-01' });
  a.app.server.emit('close'); // simulasi: cache memori hilang tetapi berkas data tetap
  const { createApp } = require('../server');
  const app2 = createApp(a.cfg, { logSink: () => {} });
  await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
  const B2 = 'http://127.0.0.1:' + app2.server.address().port;
  const r = await fetch(B2 + '/api/translate', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Idempotency-Key': 'kunci-restart-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Halo', src: 'id', tgt: 'en' }) });
  assert.equal(r.status, 409); assert.equal(a.mock.calls.translate, 1);
  assert.equal(app2.store.codes[a.store.hash(code)].credits, 9);
  await new Promise(r => app2.server.close(r));
});

test('benturan saldo: dua permintaan bersamaan dengan kredit untuk satu saja', async () => {
  const a = await boot(); const code = await a.mkCode(1); a.mock.delay = 100;
  const [r1, r2] = await Promise.all([a.translate(code, 'Satu'), a.translate(code, 'Dua')]);
  const s = [r1.status, r2.status].sort(); a.mock.delay = 0;
  assert.deepEqual(s, [200, 402]); assert.equal(a.mock.calls.translate, 1); assert.equal(await a.credits(code), 0);
});

test('kredit habis = 402 dan tidak memanggil penyedia', async () => {
  const a = await boot(); const code = await a.mkCode(1);
  await a.translate(code); const r = await a.translate(code);
  assert.equal(r.status, 402); assert.equal((await r.json()).code, 'no_credit'); assert.equal(a.mock.calls.translate, 1);
});

test('penyedia sibuk (429) dipetakan ke 503 dan kredit kembali', async () => {
  const a = await boot(); const code = await a.mkCode(10); a.mock.fail.tts = 429;
  const r = await a.tts(code); assert.equal(r.status, 503); assert.equal(await a.credits(code), 10);
});

test('429 karena batas biaya OpenAI (hard spend limit) dibedakan dari sibuk: pesan jelas, kredit kembali, tepat satu panggilan', async () => {
  for (const c of ['project_spend_limit_exceeded', 'organization_spend_limit_exceeded', 'credit_balance_exhausted']) {
    const a = await boot(); const code = await a.mkCode(10); a.mock.fail.translate = 429; a.mock.failCode.translate = c;
    const r = await a.translate(code), j = await r.json();
    assert.equal(r.status, 503, c); assert.equal(j.code, 'provider_quota', c); assert.match(j.error, /batas biaya atau kuota/);
    assert.equal(await a.credits(code), 10, c); assert.equal(a.mock.calls.translate, 1, c);
    assert.ok(!JSON.stringify(j).includes('sk-'), 'kunci tidak bocor');
  }
  const b = await boot(); const code2 = await b.mkCode(10); b.mock.fail.tts = 429; // 429 tanpa kode kuota tetap "sibuk"
  assert.equal((await (await b.tts(code2)).json()).code, 'provider_busy');
});

test('batas harian per kode dan pengembalian saat gagal', async () => {
  const a = await boot({ DAILY_CALLS_PER_CODE: '2' }); const code = await a.mkCode(50);
  assert.equal((await a.translate(code)).status, 200); assert.equal((await a.translate(code)).status, 200);
  const r = await a.translate(code); assert.equal(r.status, 429); assert.equal((await r.json()).code, 'daily_limit');
  assert.equal(a.mock.calls.translate, 2);
});

test('batas daily_calls khusus per kode lebih kecil dari bawaan', async () => {
  const a = await boot(); const code = await a.mkCode(50, { daily_calls: 1 });
  assert.equal((await a.translate(code)).status, 200); assert.equal((await a.translate(code)).status, 429);
});

test('validasi input: ditolak gratis tanpa memotong kredit atau memanggil penyedia', async () => {
  const a = await boot({ MAX_AUDIO_SECONDS: '10' }); const code = await a.mkCode(10);
  const cases = [
    ['STT lang salah', () => a.call(code, '/api/stt?lang=fr', { wav: makeWav(1) }), 400],
    ['STT tanpa lang', () => a.call(code, '/api/stt', { wav: makeWav(1) }), 400],
    ['STT bukan WAV (tipe)', () => a.call(code, '/api/stt?lang=id', { wav: makeWav(1), headers: { 'Content-Type': 'audio/mpeg' } }), 415],
    ['STT bukan WAV (isi)', () => a.call(code, '/api/stt?lang=id', { wav: Buffer.alloc(5000, 1) }), 400],
    ['STT terlalu pendek', () => a.call(code, '/api/stt?lang=id', { wav: makeWav(0.1) }), 400],
    ['STT terlalu panjang', () => a.call(code, '/api/stt?lang=id', { wav: makeWav(11) }), 413],
    ['STT terlalu besar', () => a.call(code, '/api/stt?lang=id', { wav: Buffer.alloc(4 * 1024 * 1024, 0) }), 413],
    ['terjemahan kosong', () => a.translate(code, '   '), 400],
    ['terjemahan terlalu panjang', () => a.translate(code, 'x'.repeat(1001)), 400],
    ['terjemahan arah sama', () => a.call(code, '/api/translate', { json: { text: 'a', src: 'id', tgt: 'id' } }), 400],
    ['terjemahan bahasa lain', () => a.call(code, '/api/translate', { json: { text: 'a', src: 'id', tgt: 'fr' } }), 400],
    ['terjemahan JSON rusak', () => a.call(code, '/api/translate', { headers: { 'Content-Type': 'application/json' }, wav: Buffer.from('{bukan json') }), 400],
    ['TTS terlalu panjang', () => a.tts(code, 'x'.repeat(801)), 400],
    ['TTS bahasa salah', () => a.call(code, '/api/tts', { json: { text: 'a', lang: 'fr' } }), 400],
    ['TTS suara tidak dikenal', () => a.call(code, '/api/tts', { json: { text: 'a', lang: 'en', voice: '../../etc' } }), 400]
  ];
  for (const [name, fn, want] of cases) { const r = await fn(); assert.equal(r.status, want, name); }
  assert.equal(a.mock.calls.stt + a.mock.calls.translate + a.mock.calls.tts, 0); assert.equal(await a.credits(code), 10);
});

test('kode akses kedaluwarsa dapat dibuat lewat expires_days', async () => {
  const a = await boot(); await a.mkCode(5, { expires_days: 7 });
  const list = await (await a.adminCall('/admin/codes')).json();
  assert.ok(Date.parse(list[0].expires) > Date.now() + 6 * 86400000);
});

test('parseWav: menolak header palsu dan menghitung durasi', () => {
  assert.throws(() => parseWav(Buffer.alloc(10)), /audio/);
  const w = makeWav(2.5, 16000); const i = parseWav(w); assert.equal(i.rate, 16000); assert.ok(Math.abs(i.seconds - 2.5) < 0.01);
  const stereo = Buffer.from(makeWav(1)); stereo.writeUInt16LE(5, 22); assert.throws(() => parseWav(stereo), /kanal/);
});

test('penyedia MENOLAK (400/401/429): dikembalikan penuh, kunci boleh dicoba lagi, tepat satu panggilan', async () => {
  for (const status of [400, 401, 429]) {
    const a = await boot(); const code = await a.mkCode(10); a.mock.fail.stt = status;
    const k = 'kunci-tolak-' + status;
    const r = await a.stt(code, { key: k }); assert.equal(r.status, status === 429 ? 503 : 502, 'status ' + status);
    assert.equal(a.mock.calls.stt, 1, 'tanpa fallback atau percobaan ulang');
    assert.equal(await a.credits(code), 10); assert.equal((await a.me(code)).held, 0);
    a.mock.fail.stt = null;
    const r2 = await a.stt(code, { key: k }); assert.equal(r2.status, 200); assert.equal(await a.credits(code), 8);
  }
});

test('TANPA fallback: satu permintaan = satu panggilan ke penyedia, bahkan saat ditolak berkali-kali', async () => {
  const a = await boot(); const code = await a.mkCode(30); a.mock.fail.stt = 400; a.mock.fail.translate = 400; a.mock.fail.tts = 400;
  await a.stt(code); await a.translate(code); await a.tts(code);
  assert.deepEqual(a.mock.calls, { stt: 1, translate: 1, tts: 1 });
  assert.equal(await a.credits(code), 30);
});

test('batas anggaran bulanan: layanan berhenti, pengembalian memulihkan anggaran', async () => {
  const a = await boot({ MONTHLY_BUDGET_USD: '0.001', USD_TRANSLATE_PER_CALL: '0.0004' }); const code = await a.mkCode(50);
  assert.equal((await a.translate(code)).status, 200); assert.equal((await a.translate(code)).status, 200);
  const r = await a.translate(code); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'budget_exceeded');
  assert.equal(a.mock.calls.translate, 2);
  const u = await (await a.adminCall('/admin/usage')).json(); assert.ok(u.estimate.spentUsd <= 0.001); assert.match(u.estimate.basis, /perkiraan/);
});

test('anggaran dikembalikan saat penyedia menolak (pasti tidak ditagih)', async () => {
  const a = await boot({ MONTHLY_BUDGET_USD: '0.001', USD_TRANSLATE_PER_CALL: '0.0004' }); const code = await a.mkCode(50);
  a.mock.fail.translate = 429; for (let i = 0; i < 4; i++) assert.equal((await a.translate(code)).status, 503);
  a.mock.fail.translate = null; assert.equal((await a.translate(code)).status, 200);
});

test('kode akses kedaluwarsa dapat dibuat lewat expires_days', async () => {
  const a = await boot(); await a.mkCode(5, { expires_days: 7 });
  const list = await (await a.adminCall('/admin/codes')).json();
  assert.ok(Date.parse(list[list.length - 1].expires) > Date.now() + 6 * 86400000);
});
