'use strict';
// Tes endpoint admin dan konfigurasi: nilai tidak valid, kredit negatif, perubahan saldo tidak disengaja, batas biaya.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FAKE_OPENAI_KEY, ADMIN } = require('./helpers');
const { loadConfig, ConfigError } = require('../lib/config');

const apps = [];
const boot = async (env) => { const a = await startApp(env); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, []); assert.deepEqual(a.audit(), []); await a.close(); } });

test('topup: semua nilai tidak valid ditolak 400 dan saldo TIDAK berubah (negatif, nol, desimal, teks, null, tak hingga, terlalu besar)', async () => {
  const a = await boot(); const code = await a.mkCode(10); const id = a.shortId(code);
  const bad = [-1000, 0, 1.5, '10', null, true, [], {}, 2000000, 9007199254740993];
  for (const credits of bad) { const r = await a.adm('/admin/topup', { id, credits, request_id: a.rid() }); assert.equal(r.status, 400, 'credits=' + JSON.stringify(credits)); assert.equal(r.json.code, 'bad_credits'); }
  for (const raw of ['1e999', '-1e999', '1e400']) { const r = await a.adminCall('/admin/topup', '{"id":"' + id + '","credits":' + raw + ',"request_id":"' + a.rid() + '"}'); assert.equal(r.status, 400, raw); }
  assert.equal(await a.credits(code), 10);
  assert.ok(!/null|Infinity|NaN/.test(require('fs').readFileSync(a.store.file, 'utf8').match(/"credits":[^,}]*/g).join()), 'berkas data tidak rusak');
});

test('topup: request_id wajib, id harus 8+ heksadesimal dan cocok persis satu kode', async () => {
  const a = await boot(); const code = await a.mkCode(10); const id = a.shortId(code);
  assert.equal((await a.adm('/admin/topup', { id, credits: 5 })).status, 400);                                            // tanpa request_id
  assert.equal((await a.adm('/admin/topup', { id, credits: 5, request_id: 'pendek' })).status, 400);
  for (const badId of [undefined, '', 'abc', 'zzzzzzzz', id.slice(0, 7), 12345678, '../../x']) assert.equal((await a.adm('/admin/topup', { id: badId, credits: 5, request_id: a.rid() })).status, 400, JSON.stringify(badId));
  assert.equal((await a.adm('/admin/topup', { id: 'deadbeef', credits: 5, request_id: a.rid() })).status, 404);
  a.store.codes['abcd1234' + '1'.repeat(56)] = { name: 'x', credits: 1, held: 0, used: 0, txns: {} }; a.store.codes['abcd1234' + '2'.repeat(56)] = { name: 'y', credits: 1, held: 0, used: 0, txns: {} };
  const amb = await a.adm('/admin/topup', { id: 'abcd1234', credits: 5, request_id: a.rid() }); assert.equal(amb.status, 409); assert.equal(amb.json.code, 'ambiguous_id');
  delete a.store.codes['abcd1234' + '1'.repeat(56)]; delete a.store.codes['abcd1234' + '2'.repeat(56)];
  assert.equal(await a.credits(code), 10);
});

test('topup: request_id membuat pengulangan aman (Enter dua kali tidak menambah dua kali), parameter berbeda = 409', async () => {
  const a = await boot(); const code = await a.mkCode(10); const id = a.shortId(code); const rid = 'req-topup-0001';
  const r1 = await a.adm('/admin/topup', { id, credits: 5, request_id: rid }), r2 = await a.adm('/admin/topup', { id, credits: 5, request_id: rid });
  assert.equal(r1.json.credits, 15); assert.equal(r2.json.credits, 15); assert.equal(r2.json.replayed, true); assert.equal(await a.credits(code), 15);
  assert.equal((await a.adm('/admin/topup', { id, credits: 7, request_id: rid })).status, 409);
  assert.equal(await a.credits(code), 15);
});

test('topup hanya menambah: kunci "disabled" ditolak (mencegah menonaktifkan kode secara tidak sengaja)', async () => {
  const a = await boot(); const code = await a.mkCode(10); const id = a.shortId(code);
  for (const d of [true, false, 'false', 'true']) assert.equal((await a.adm('/admin/topup', { id, credits: 1, disabled: d, request_id: a.rid() })).json.code, 'use_disable');
  assert.equal((await a.call(code, '/api/me', { method: 'GET' })).status, 200); assert.equal(await a.credits(code), 10);
});

test('MAX_BALANCE membatasi saldo total (tersedia + ditahan)', async () => {
  const a = await boot({ MAX_BALANCE: '100' }); const code = await a.mkCode(60); const id = a.shortId(code);
  assert.equal((await a.adm('/admin/topup', { id, credits: 50, request_id: a.rid() })).json.code, 'balance_cap');
  assert.equal((await a.adm('/admin/topup', { id, credits: 40, request_id: a.rid() })).status, 200); assert.equal(await a.credits(code), 100);
});

test('adjust: hanya pengurangan, alasan wajib, tidak boleh negatif, tidak menyentuh kredit yang ditahan', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '120' }); const code = await a.mkCode(10); const id = a.shortId(code);
  a.mock.delay = 400; await a.translate(code); a.mock.delay = 0;                         // 1 kredit ditahan (UNKNOWN), tersedia 9
  const A = (delta, reason = 'koreksi salah isi', rid = a.rid()) => a.adm('/admin/adjust', { id, delta, reason, request_id: rid });
  assert.equal((await A(5)).status, 400); assert.equal((await A(0)).status, 400); assert.equal((await A(-1.5)).status, 400); assert.equal((await A('-3')).status, 400);
  assert.equal((await A(-3, '')).status, 400); assert.equal((await a.adm('/admin/adjust', { id, delta: -3, request_id: a.rid() })).status, 400); // tanpa reason
  assert.equal((await A(-10)).json.code, 'insufficient_available');                       // 10 > 9 tersedia: ditolak walau total 10
  const ok = await A(-4); assert.equal(ok.json.credits, 5); assert.equal(ok.json.held, 1);
  assert.equal(await a.credits(code), 5);
  assert.ok(a.store.adminLog.some(l => l.op === 'adjust' && l.detail.reason === 'koreksi salah isi'));
});

test('disable: harus boolean sungguhan (teks "false" ditolak), idempoten, kode kembali bisa dipakai', async () => {
  const a = await boot(); const code = await a.mkCode(10); const id = a.shortId(code);
  for (const d of ['false', 'true', 0, 1, null, undefined]) assert.equal((await a.adm('/admin/disable', { id, disabled: d, request_id: a.rid() })).status, 400, JSON.stringify(d));
  assert.equal((await a.call(code, '/api/me', { method: 'GET' })).status, 200);
  const rid = a.rid(); assert.equal((await a.adm('/admin/disable', { id, disabled: true, request_id: rid })).status, 200);
  assert.equal((await a.call(code, '/api/me', { method: 'GET' })).status, 401);
  assert.equal((await a.adm('/admin/disable', { id, disabled: true, request_id: rid })).json.replayed, true);
  assert.equal((await a.adm('/admin/disable', { id, disabled: false, request_id: a.rid() })).status, 200);
  assert.equal(await a.credits(code), 10);
});

test('buat kode: kredit, masa berlaku, batas harian divalidasi ketat; nama dibersihkan', async () => {
  const a = await boot();
  for (const credits of [0, -5, 1.2, '50', null, 2000000, undefined]) assert.equal((await a.adm('/admin/codes', { name: 'x', credits })).status, 400, JSON.stringify(credits));
  assert.equal((await a.adm('/admin/codes', { credits: 5, expires_days: -1 })).status, 400); assert.equal((await a.adm('/admin/codes', { credits: 5, expires_days: 400 })).status, 400);
  assert.equal((await a.adm('/admin/codes', { credits: 5, daily_calls: 1.5 })).status, 400); assert.equal((await a.adm('/admin/codes', { credits: 5, name: { x: 1 } })).status, 400);
  const ok = await a.adm('/admin/codes', { credits: 5, name: 'Budi\u0000\n<script>', expires_days: 3, daily_calls: 10 });
  assert.equal(ok.status, 200); assert.ok(!/[\u0000-\u001f]/.test(a.store.list().pop().name));
});

test('kill: wajib boolean (teks "false" tidak boleh mematikan atau menghidupkan secara tidak sengaja)', async () => {
  const a = await boot();
  assert.equal((await a.adm('/admin/kill', { enabled: 'false' })).status, 400); assert.equal((await a.adm('/admin/kill', {})).status, 400);
  assert.equal((await a.adm('/admin/kill', { enabled: false })).json.killed, true); assert.equal((await a.adm('/admin/kill', { enabled: true })).json.killed, false);
});

test('log admin mencatat setiap perubahan tanpa kode akses atau token', async () => {
  const a = await boot(); const code = await a.mkCode(10); const id = a.shortId(code);
  await a.adm('/admin/topup', { id, credits: 5, request_id: a.rid() }); await a.adm('/admin/adjust', { id, delta: -2, reason: 'uji', request_id: a.rid() }); await a.adm('/admin/kill', { enabled: false });
  const log = (await a.adm('/admin/log')).json; const ops = log.map(l => l.op);
  for (const op of ['create', 'topup', 'adjust', 'kill']) assert.ok(ops.includes(op), op);
  const t = JSON.stringify(log); assert.ok(!t.includes(code) && !t.includes(ADMIN) && !t.includes(FAKE_OPENAI_KEY));
});

test('tebak token admin dibatasi per IP', async () => {
  const a = await boot({ IP_AUTH_FAIL_PER_MIN: '3' }); const s = [];
  for (let i = 0; i < 5; i++) s.push((await fetch(a.B + '/admin/codes', { headers: { 'X-Admin-Token': 'salah' + i } })).status);
  assert.deepEqual(s.slice(0, 3), [401, 401, 401]); assert.equal(s[3], 429);
});

test('batas biaya INTERNAL = perkiraan: laporan membedakan estimasi, UNKNOWN, dan nilai yang dilaporkan penyedia', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '120' }); const code = await a.mkCode(50);
  await a.stt(code); await a.translate(code); a.mock.delay = 400; await a.translate(code); a.mock.delay = 0;
  const u = (await a.adm('/admin/usage')).json;
  assert.match(u.estimate.basis, /perkiraan internal, bukan tagihan/); assert.ok(u.estimate.spentUsd > 0 && u.estimate.includesUnknownUsd > 0);
  assert.equal(u.transactions.CONFIRMED, 2); assert.equal(u.transactions.UNKNOWN, 1); assert.equal(u.unknownCredits, 1);
  assert.equal(u.reportedByProvider.stt_seconds, 1); assert.equal(u.reportedByProvider.chat_in_tokens, 50); assert.equal(u.reportedByProvider.chat_out_tokens, 10);
  assert.match(u.note, /dashboard OpenAI/); assert.equal(u.storage.healthy, true);
});

test('UNKNOWN tetap dihitung dalam anggaran: layanan berhenti walau semua transaksi UNKNOWN', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '120', MONTHLY_BUDGET_USD: '0.001', USD_TRANSLATE_PER_CALL: '0.0004' }); const code = await a.mkCode(50); a.mock.delay = 400;
  assert.equal((await a.translate(code)).status, 504); assert.equal((await a.translate(code)).status, 504);
  const r = await a.translate(code); assert.equal((await r.json()).code, 'budget_exceeded');
});

// ================= konfigurasi =================
test('konfigurasi rusak membuat server menolak start (bukan memakai nilai berbahaya)', () => {
  const bad = { COST_STT: '-5', COST_TRANSLATE: '0', COST_TTS_PER_100: 'abc', PORT: '99999', MONTHLY_BUDGET_USD: '-1', DAILY_CALLS_PER_CODE: '1.5', PAID_API_ENABLED: 'mungkin',
    OPENAI_TTS_FORMAT: 'xyz', OPENAI_STT_LANG_FIELD: 'foo', OPENAI_TRANSLATE_REASONING: 'super', OPENAI_INSTRUCTION_ROLE: 'admin', RATE_PER_MIN: '0', MAX_BALANCE: 'Infinity', UPSTREAM_TIMEOUT_MS: '5' };
  for (const [k, v] of Object.entries(bad)) assert.throws(() => loadConfig({ [k]: v }), e => e instanceof ConfigError && e.message.includes(k.startsWith('OPENAI_TRANSLATE') ? 'OPENAI_TRANSLATE_REASONING' : k), k + '=' + v);
  assert.throws(() => loadConfig({ COST_STT: '-5', PORT: 'x' }), e => /COST_STT/.test(e.message) && /PORT/.test(e.message));
});

test('konfigurasi valid dan bawaan aman', () => {
  const c = loadConfig({});
  assert.equal(c.paidEnabled, false); assert.equal(c.cost.stt, 2); assert.equal(c.openai.modelStt, 'gpt-transcribe'); assert.equal(c.openai.sttLangField, 'languages'); assert.equal(c.openai.instructionRole, 'developer');
  assert.equal(c.refundOnProvider5xx, false); assert.equal(c.maxBalance, 10000000);
  assert.equal(loadConfig({ OPENAI_MODEL_STT: 'whisper-1' }).openai.sttLangField, 'language');            // model lama: language, bukan languages
  assert.equal(loadConfig({ OPENAI_MODEL_STT: 'whisper-1', OPENAI_STT_LANG_FIELD: 'languages' }).openai.sttLangField, 'languages'); // override eksplisit
});
