'use strict';
// Tes kredit dan biaya: tahan/kembalikan, idempotensi, benturan, batas harian dan anggaran, validasi input, fallback parameter.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp, makeWav } = require('./helpers');
const { parseWav } = require('../lib/util');
const { Store } = require('../lib/store');

const apps = [];
const boot = async (env, seed) => { const a = await startApp(env, seed); apps.push(a); return a; };
after(async () => { for (const a of apps) await a.close(); });
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

test('penyedia gagal: kredit dikembalikan penuh dan kunci boleh dicoba lagi', async () => {
  const a = await boot(); const code = await a.mkCode(10); a.mock.fail.stt = 500;
  const k = 'kunci-gagal-0001';
  const r = await a.stt(code, { key: k }); assert.equal(r.status, 502);
  assert.equal(await a.credits(code), 10); assert.equal(a.store.codes[a.store.hash(code)].held, 0);
  a.mock.fail.stt = null;
  const r2 = await a.stt(code, { key: k }); assert.equal(r2.status, 200); assert.equal(await a.credits(code), 8);
});

test('timeout penyedia = 504 dan kredit kembali', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '120' }); const code = await a.mkCode(10); a.mock.delay = 600;
  const r = await a.translate(code); assert.equal(r.status, 504); a.mock.delay = 0;
  assert.equal(await a.credits(code), 10);
});

test('penyedia sibuk (429) dipetakan ke 503 dan kredit kembali', async () => {
  const a = await boot(); const code = await a.mkCode(10); a.mock.fail.tts = 429;
  const r = await a.tts(code); assert.equal(r.status, 503); assert.equal(await a.credits(code), 10);
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

test('batas anggaran bulanan: layanan berhenti, pengembalian memulihkan anggaran', async () => {
  const a = await boot({ MONTHLY_BUDGET_USD: '0.001', USD_TRANSLATE_PER_CALL: '0.0004' }); const code = await a.mkCode(50);
  assert.equal((await a.translate(code)).status, 200); assert.equal((await a.translate(code)).status, 200);
  const r = await a.translate(code); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'budget_exceeded');
  assert.equal(a.mock.calls.translate, 2);
  const u = await (await a.adminCall('/admin/usage')).json(); assert.ok(u.spentUsdEstimate <= 0.001);
});

test('anggaran dikembalikan saat panggilan gagal', async () => {
  const a = await boot({ MONTHLY_BUDGET_USD: '0.001', USD_TRANSLATE_PER_CALL: '0.0004' }); const code = await a.mkCode(50);
  a.mock.fail.translate = 500; for (let i = 0; i < 4; i++) assert.equal((await a.translate(code)).status, 502);
  a.mock.fail.translate = null; assert.equal((await a.translate(code)).status, 200);
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

test('fallback: OpenAI menolak languages[] -> dicoba language, lalu diingat', async () => {
  const a = await boot(); const code = await a.mkCode(20); a.mock.rejectLanguagesField = true;
  const r = await a.stt(code); assert.equal(r.status, 200); assert.equal(a.mock.calls.stt, 2); assert.equal(await a.credits(code), 18);
  assert.ok(a.mock.seen[1].body.toString('latin1').includes('name="language"'));
  await a.stt(code); assert.equal(a.mock.calls.stt, 3); // percobaan berikutnya langsung memakai bentuk yang diterima
});

test('fallback: OpenAI menolak reasoning_effort -> dicoba tanpa itu', async () => {
  const a = await boot(); const code = await a.mkCode(20); a.mock.rejectReasoning = true;
  const r = await a.translate(code); assert.equal(r.status, 200); assert.equal(a.mock.calls.translate, 2); assert.equal(await a.credits(code), 19);
});

test('top-up dan daftar kode: id pendek, tanpa kode asli', async () => {
  const a = await boot(); const code = await a.mkCode(5, { name: 'Budi' });
  const list = await (await a.adminCall('/admin/codes')).json();
  assert.equal(list[0].name, 'Budi'); assert.equal(list[0].id.length, 8); assert.ok(!JSON.stringify(list).includes(code));
  const t = await (await a.adminCall('/admin/topup', { id: list[0].id, credits: 100 })).json();
  assert.equal(t.credits, 105);
});

test('kode akses kedaluwarsa dapat dibuat lewat expires_days', async () => {
  const a = await boot(); await a.mkCode(5, { expires_days: 7 });
  const list = await (await a.adminCall('/admin/codes')).json();
  assert.ok(Date.parse(list[0].expires) > Date.now() + 6 * 86400000);
});

test('Store: tahanan yatim dikembalikan saat sweep', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vb-s-'));
  const s = new Store(dir, { monthlyBudgetUsd: 1, dailyCalls: 10 });
  const { code } = s.createCode({ name: 'x', credits: 10 }); const { id } = s.authenticate(code);
  const h = s.reserve(id, { credits: 4, usd: 0.1, key: 'kunci-yatim-01' });
  assert.equal(s.codes[id].credits, 6); assert.equal(s.codes[id].held, 4);
  s.codes[id].holds[h.holdId].ts = Date.now() - 10 * 60000;
  assert.equal(s.sweep(60000), 1);
  assert.equal(s.codes[id].credits, 10); assert.equal(s.codes[id].held, 0); assert.equal(s.usage().spentUsdEstimate, 0);
  const s2 = new Store(dir); assert.equal(s2.codes[id].credits, 10); // tersimpan di berkas
});

test('Store: migrasi dari berkas backend lama (codes.json datar)', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vb-m-'));
  fs.writeFileSync(path.join(dir, 'codes.json'), JSON.stringify({ abc123: { name: 'Lama', credits: 42, created: '2026-10-28T00:00:00Z', used: 8 } }));
  const s = new Store(dir);
  assert.equal(s.codes.abc123.credits, 42); assert.equal(s.codes.abc123.used, 8); assert.deepEqual(s.codes.abc123.holds, {});
  assert.ok(fs.existsSync(path.join(dir, 'vocalbridge.json')));
});

test('parseWav: menolak header palsu dan menghitung durasi', () => {
  assert.throws(() => parseWav(Buffer.alloc(10)), /audio/);
  const w = makeWav(2.5, 16000); const i = parseWav(w); assert.equal(i.rate, 16000); assert.ok(Math.abs(i.seconds - 2.5) < 0.01);
  const stereo = Buffer.from(makeWav(1)); stereo.writeUInt16LE(5, 22); assert.throws(() => parseWav(stereo), /kanal/);
});
