'use strict';
// Tes mesin status transaksi: PENDING / CONFIRMED / FAILED / UNKNOWN, pemulihan saat restart, rekonsiliasi, invarian saldo.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('./helpers');
const { Store } = require('../lib/store');

const apps = [];
const boot = async (env, seed) => { const a = await startApp(env, seed); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, [], 'kontrak OpenAI'); assert.deepEqual(a.audit(), [], 'audit saldo'); await a.close(); } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tx-'));
const thrown = (fn, code) => assert.throws(fn, e => e.code === code, 'harus melempar ' + code);
const U = { kind: 'translate', credits: 3, usd: 0.01 };

// ================= tingkat Store (tanpa HTTP) =================
test('recover: PENDING yang BELUM dikirim -> FAILED dan dikembalikan (penyedia tidak pernah dihubungi)', () => {
  const dir = tmp(); const s = new Store(dir); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  s.begin(id, Object.assign({ key: 'kunci-aaaaaaaa' }, U));
  assert.equal(s.codes[id].credits, 7); assert.equal(s.codes[id].held, 3);
  const s2 = new Store(dir);                         // simulasi restart: proses baru membaca berkas yang sama
  assert.deepEqual(s2.recover(), { failed: 1, unknown: 0 });
  assert.equal(s2.codes[id].credits, 10); assert.equal(s2.codes[id].held, 0); assert.equal(s2.usage().estimate.spentUsd, 0);
  assert.equal(s2.codes[id].txns['kunci-aaaaaaaa'].state, 'FAILED'); assert.deepEqual(s2.audit(), []);
  s2.begin(id, Object.assign({ key: 'kunci-aaaaaaaa' }, U)); // kunci yang sama boleh dicoba lagi
});

test('recover: PENDING yang SUDAH dikirim -> UNKNOWN, kredit dan anggaran TETAP ditahan, kunci terkunci', () => {
  const dir = tmp(); const s = new Store(dir); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  const h = s.begin(id, Object.assign({ key: 'kunci-bbbbbbbb' }, U)); s.markSent(h);
  const s2 = new Store(dir);
  assert.deepEqual(s2.recover(), { failed: 0, unknown: 1 });
  assert.equal(s2.codes[id].credits, 7); assert.equal(s2.codes[id].held, 3); assert.equal(s2.usage().estimate.spentUsd, 0.01);
  assert.equal(s2.codes[id].txns['kunci-bbbbbbbb'].state, 'UNKNOWN'); assert.deepEqual(s2.audit(), []);
  thrown(() => s2.begin(id, Object.assign({ key: 'kunci-bbbbbbbb' }, U)), 'txn_unknown'); // tidak bisa ditagihkan lagi dengan kunci yang sama
  assert.equal(s2.codes[id].credits, 7);
  assert.deepEqual(new Store(dir).recover(), { failed: 0, unknown: 0 });   // restart berikutnya: stabil, tidak mengubah apa pun
});

test('transisi terlarang ditolak: refund transaksi terkirim, konfirmasi dua kali, ubah status akhir', () => {
  const s = new Store(tmp()); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  const h = s.begin(id, Object.assign({ key: 'kunci-cccccccc' }, U)); s.markSent(h);
  assert.throws(() => s.fail(h, 'x'), /refund terlarang/);                  // terkirim tanpa kepastian: tidak boleh dikembalikan otomatis
  s.confirm(h, {}); assert.equal(s.codes[id].used, 3);
  assert.throws(() => s.confirm(h, {}), /transisi terlarang/); assert.throws(() => s.markUnknown(h, 'x'), /transisi terlarang/);
  assert.throws(() => s.fail(h, 'x', { definitive: true }), /transisi terlarang/);
  assert.deepEqual(s.audit(), []);
});

test('recover tidak menyentuh transaksi yang sedang dikerjakan proses ini (live)', () => {
  const s = new Store(tmp()); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  const h = s.begin(id, Object.assign({ key: 'kunci-dddddddd' }, U));
  assert.deepEqual(s.recover({ live: new Set([h.txn]) }), { failed: 0, unknown: 0 }); assert.equal(s.codes[id].txns['kunci-dddddddd'].state, 'PENDING');
  assert.deepEqual(s.recover({ live: new Set([h.txn]), olderThanMs: 60000 }), { failed: 0, unknown: 0 });
  assert.deepEqual(s.recover({}), { failed: 1, unknown: 0 });
});

test('gagal menyimpan: begin ditolak (fail-closed), saldo dan anggaran dipulihkan', () => {
  const s = new Store(tmp()); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  s.file = path.join(os.tmpdir(), 'tidak-ada-folder-ini', 'x', 'v.json');
  thrown(() => s.begin(id, Object.assign({ key: 'kunci-eeeeeeee' }, U)), 'store_unavailable');
  assert.equal(s.codes[id].credits, 10); assert.equal(s.codes[id].held, 0); assert.equal(s.usage().estimate.spentUsd, 0); assert.equal(s.healthy, false);
  assert.deepEqual(s.audit(), []);
});

test('migrasi v2: hold yatim -> UNKNOWN, kunci idempotensi -> CONFIRMED; saldo rusak -> 0 dan dicatat', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'vocalbridge.json'), JSON.stringify({ version: 2, meta: { month: new Date().toISOString().slice(0, 7), spentUsd: 0.02, kill: false }, codes: {
    ['a'.repeat(64)]: { name: 'v2', credits: 5, held: 2, used: 3, holds: { h1: { credits: 2, usd: 0.01, key: 'kunci-lama-0001', ts: Date.now() - 1000 } }, idem: ['kunci-lama-0002'] },
    ['b'.repeat(64)]: { name: 'rusak', credits: null, used: 0 } } }));
  const s = new Store(dir);
  assert.equal(s.codes['a'.repeat(64)].txns['kunci-lama-0001'].state, 'UNKNOWN'); assert.equal(s.codes['a'.repeat(64)].txns['kunci-lama-0002'].state, 'CONFIRMED');
  assert.equal(s.codes['a'.repeat(64)].held, 2); assert.equal(s.recover().unknown, 0); // sudah UNKNOWN, bukan PENDING
  assert.equal(s.codes['b'.repeat(64)].credits, 0); assert.deepEqual(s.migrated, ['bbbbbbbb']); assert.ok(s.adminLog.some(l => l.op === 'migrasi'));
  assert.deepEqual(s.audit(), []);
});

test('migrasi v1: berkas codes.json datar dari backend lama tetap terbaca', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'codes.json'), JSON.stringify({ abc123def456: { name: 'Lama', credits: 42, created: '2026-10-28T00:00:00Z', used: 8 } }));
  const s = new Store(dir); const r = s.codes.abc123def456;
  assert.equal(r.credits, 42); assert.equal(r.used, 8); assert.deepEqual(r.txns, {}); assert.equal(r.held, 0); assert.ok(fs.existsSync(path.join(dir, 'vocalbridge.json')));
});

// ================= tingkat aplikasi (HTTP + OpenAI palsu) =================
test('restart: backend baru memulihkan transaksi warisan saat start (log recover, saldo tampil di /api/me)', async () => {
  const dir = tmp(); const s = new Store(dir); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  s.begin(id, Object.assign({ key: 'kunci-belum-kirim' }, U));                                   // PENDING belum terkirim
  const h = s.begin(id, Object.assign({ key: 'kunci-sudah-kirim' }, U)); s.markSent(h);           // PENDING terkirim
  const a = await boot({ __DIR: dir });
  assert.deepEqual(a.app.recovered, { failed: 1, unknown: 1 }); assert.ok(a.logs.some(l => /"evt":"recover"/.test(l)));
  const me = await a.me(code); assert.equal(me.credits, 7); assert.equal(me.held, 3); assert.equal(me.unknown, 1);
});

test('UNKNOWN: timeout penyedia TIDAK dikembalikan; kunci sama = 409; kunci baru = transaksi terpisah; X-Client-Request-Id = ID transaksi', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '150' }); const code = await a.mkCode(10); a.mock.delay = 500;
  const k = 'kunci-timeout-0001';
  const r = await a.translate(code, 'Halo', { key: k }); const j = await r.json();
  assert.equal(r.status, 504); assert.equal(j.code, 'provider_unknown'); assert.ok(j.txn);
  a.mock.delay = 0;
  const me = await a.me(code); assert.equal(me.credits, 9); assert.equal(me.held, 1); assert.equal(me.unknown, 1);
  assert.equal(a.mock.seen[0].headers['x-client-request-id'], j.txn, 'ID transaksi dikirim ke penyedia untuk rekonsiliasi');
  const r2 = await a.translate(code, 'Halo', { key: k }); assert.equal(r2.status, 409); assert.equal((await r2.json()).code, 'txn_unknown'); assert.equal(a.mock.calls.translate, 1);
  const list = await a.adm('/admin/transactions?state=UNKNOWN'); assert.equal(list.json.length, 1); assert.equal(list.json[0].txn, j.txn); assert.equal(list.json[0].reason, 'provider_timeout');
  assert.equal((await a.translate(code, 'Halo')).status, 200); // kunci baru: permintaan baru yang sah, ditagih terpisah
  const me2 = await a.me(code); assert.equal(me2.credits, 8); assert.equal(me2.held, 1);
});

test('UNKNOWN: respons terputus, JSON rusak, balasan kosong -> penyedia sudah memproses, kredit tetap ditahan', async () => {
  for (const [kind, mode, call] of [['stt', 'reset', 'stt'], ['translate', 'reset', 'translate'], ['stt', 'badjson', 'stt'], ['translate', 'badjson', 'translate'], ['stt', 'empty', 'stt'], ['translate', 'empty', 'translate'], ['tts', 'reset', 'tts']]) {
    const a = await boot(); const code = await a.mkCode(10); a.mock.chaos[kind] = mode;
    const r = await a[call](code); const j = await r.json();
    assert.ok([502, 504].includes(r.status), kind + '/' + mode); assert.equal(j.code, 'provider_unknown', kind + '/' + mode);
    assert.equal(a.mock.completed[kind], 1, 'penyedia memang sudah memproses'); assert.equal(a.mock.calls[kind], 1, 'tanpa percobaan ulang');
    const me = await a.me(code); assert.equal(me.unknown, 1, kind + '/' + mode); assert.ok(me.credits < 10 && me.held > 0);
  }
});

test('5xx dari penyedia = UNKNOWN secara bawaan; REFUND_ON_PROVIDER_5XX=true = dikembalikan', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  for (const st of [500, 502, 503, 504]) { a.mock.fail.translate = st; const r = await a.translate(code); assert.equal((await r.json()).code, 'provider_unknown', 'status ' + st); }
  assert.equal((await a.me(code)).unknown, 4); assert.equal(await a.credits(code), 6);
  const b = await boot({ REFUND_ON_PROVIDER_5XX: 'true' }); const c2 = await b.mkCode(10); b.mock.fail.translate = 500;
  const r = await b.translate(c2); assert.equal((await r.json()).code, 'provider_error'); assert.equal(await b.credits(c2), 10); assert.equal((await b.me(c2)).unknown, 0);
});

test('pasti tidak terkirim (koneksi ditolak): FAILED dan dikembalikan, bukan UNKNOWN', async () => {
  const closed = await new Promise(r => { const sv = require('net').createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); }); // port yang pasti tidak ada yang mendengarkan
  const a = await boot({ OPENAI_BASE: 'http://127.0.0.1:' + closed }); const code = await a.mkCode(10);
  const r = await a.translate(code); const j = await r.json();
  assert.equal(r.status, 502); assert.equal(j.code, 'provider_unreachable'); assert.equal(await a.credits(code), 10); assert.equal((await a.me(code)).held, 0);
  assert.equal((await a.adm('/admin/transactions?state=UNKNOWN')).json.length, 0);
});

test('rekonsiliasi admin: confirm, refund, refund_keep_cost; hanya UNKNOWN; idempoten; catatan wajib', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '120' }); const code = await a.mkCode(20); a.mock.delay = 400;
  const txns = []; for (let i = 0; i < 3; i++) txns.push((await (await a.translate(code, 'Halo ' + i)).json()).txn);
  a.mock.delay = 0;
  let me = await a.me(code); assert.equal(me.credits, 17); assert.equal(me.held, 3);
  const spent0 = (await a.adm('/admin/usage')).json.estimate.spentUsd;
  const R = (txn, resolution, note = 'dicek di log OpenAI', request_id = a.rid()) => a.adm('/admin/transactions/resolve', { txn, resolution, note, request_id });
  const c = await R(txns[0], 'confirm'); assert.equal(c.json.state, 'CONFIRMED'); assert.equal(c.json.credits, 17); assert.equal(c.json.held, 2);
  const f = await R(txns[1], 'refund'); assert.equal(f.json.state, 'FAILED'); assert.equal(f.json.credits, 18); assert.equal(f.json.held, 1);
  const k = await R(txns[2], 'refund_keep_cost'); assert.equal(k.json.credits, 19); assert.equal(k.json.held, 0);
  me = await a.me(code); assert.equal(me.credits, 19); assert.equal(me.unknown, 0);
  assert.equal(a.store.codes[a.store.hash(code)].used, 1);
  const spent1 = (await a.adm('/admin/usage')).json.estimate.spentUsd;
  assert.ok(Math.abs((spent0 - spent1) - 0.0005) < 1e-9, 'hanya "refund" melepas anggaran; confirm dan refund_keep_cost mempertahankan biaya: ' + spent0 + ' -> ' + spent1);
  assert.equal((await R(txns[0], 'refund')).status, 409);                                                    // bukan UNKNOWN lagi
  const rid = a.rid(); const again1 = await R(txns[1], 'refund', 'x', rid); assert.equal(again1.status, 409);
  assert.equal((await R('tidak-ada', 'confirm')).status, 404);
  assert.equal((await R(txns[0], 'hapus')).status, 400);
  assert.equal((await a.adm('/admin/transactions/resolve', { txn: txns[0], resolution: 'confirm', request_id: a.rid() })).status, 400);      // note wajib
  assert.equal((await a.adm('/admin/transactions/resolve', { txn: txns[0], resolution: 'confirm', note: 'x' })).status, 400);                // request_id wajib
});

test('rekonsiliasi idempoten: request_id yang sama tidak mengubah saldo dua kali', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '120' }); const code = await a.mkCode(10); a.mock.delay = 400;
  const txn = (await (await a.translate(code)).json()).txn; a.mock.delay = 0;
  const body = { txn, resolution: 'refund', note: 'dicek', request_id: 'req-resolve-0001' };
  const r1 = await a.adm('/admin/transactions/resolve', body), r2 = await a.adm('/admin/transactions/resolve', body);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.equal(r2.json.replayed, true); assert.equal(await a.credits(code), 10);
  assert.equal((await a.adm('/admin/transactions/resolve', Object.assign({}, body, { resolution: 'confirm' }))).status, 409); // request_id sama untuk operasi lain
});

test('CONFIRMED yang hasilnya hilang: kunci sama setelah restart = 409 idem_conflict, tidak dipotong dua kali', async () => {
  const a = await boot(); const code = await a.mkCode(10); const k = 'kunci-hilang-0001';
  assert.equal((await a.translate(code, 'Halo', { key: k })).status, 200);
  const { createApp } = require('../server'); const app2 = createApp(a.cfg, { logSink: () => {} });
  await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
  const r = await fetch('http://127.0.0.1:' + app2.server.address().port + '/api/translate', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Idempotency-Key': k, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Halo', src: 'id', tgt: 'en' }) });
  assert.equal(r.status, 409); assert.equal((await r.json()).code, 'idem_conflict'); assert.equal(a.mock.calls.translate, 1); assert.equal(app2.store.codes[a.store.hash(code)].credits, 9);
  await new Promise(r => app2.server.close(r));
});

test('penyimpanan gagal saat berjalan: permintaan ditolak SEBELUM menghubungi penyedia, saldo utuh', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  a.store.file = path.join(os.tmpdir(), 'tidak-ada-folder-ini', 'x', 'v.json');
  const r = await a.translate(code); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'store_unavailable');
  assert.equal(a.mock.calls.translate, 0); assert.equal(a.store.codes[a.store.hash(code)].credits, 10);
  assert.equal((await (await fetch(a.B + '/api/health')).json()).store_ok, false);
  a.store.file = path.join(a.dir, 'vocalbridge.json');
});

test('invarian saldo setelah kekacauan acak: kredit + ditahan + terpakai = kredit awal, audit bersih', async () => {
  const a = await boot({ UPSTREAM_TIMEOUT_MS: '200', DAILY_CALLS_PER_CODE: '1000', RATE_PER_MIN: '1000', IP_RATE_PER_MIN: '5000' });
  const codes = [await a.mkCode(500), await a.mkCode(500), await a.mkCode(500)];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 12; round++) {
    a.mock.fail = {}; a.mock.chaos = {}; a.mock.delay = 0;
    const m = rnd(); if (m < 0.2) a.mock.fail.translate = [400, 429, 500][Math.floor(rnd() * 3)]; else if (m < 0.4) a.mock.chaos.translate = ['reset', 'badjson', 'empty'][Math.floor(rnd() * 3)]; else if (m < 0.5) a.mock.delay = 400;
    const ps = []; for (let i = 0; i < 6; i++) { const c = codes[Math.floor(rnd() * 3)], kind = rnd(); ps.push(kind < 0.6 ? a.translate(c, 'x' + round + i) : kind < 0.85 ? a.stt(c) : a.tts(c)); }
    await Promise.all(ps);
  }
  a.mock.fail = {}; a.mock.chaos = {}; a.mock.delay = 0;
  const unknown = (await a.adm('/admin/transactions?state=UNKNOWN&limit=500')).json;
  for (const [i, t] of unknown.entries()) await a.adm('/admin/transactions/resolve', { txn: t.txn, resolution: ['confirm', 'refund', 'refund_keep_cost'][i % 3], note: 'uji acak', request_id: 'req-fuzz-' + i + '-xxxx' });
  assert.deepEqual(a.audit(), []);
  for (const c of codes) { const r = a.store.codes[a.store.hash(c)]; assert.equal(r.credits + r.held + r.used, 500, 'konservasi kredit'); assert.ok(r.credits >= 0 && r.held >= 0); }
  assert.equal((await a.adm('/admin/transactions?state=PENDING')).json.length, 0, 'tidak ada transaksi PENDING menggantung');
  assert.deepEqual((await a.adm('/admin/audit')).json, { issues: [] });
});
