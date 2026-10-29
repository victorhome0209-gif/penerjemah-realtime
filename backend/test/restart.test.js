'use strict';
// Skenario restart NYATA: backend dijalankan sebagai proses terpisah lalu dimatikan paksa (SIGKILL) di tengah permintaan.
// OpenAI tetap palsu. Membuktikan: kredit tidak dikembalikan lalu ditagih dua kali, dan rekonsiliasi berjalan.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, spawnBackend } = require('./helpers');
const { Store } = require('../lib/store');

const procs = [], mocks = [];
after(async () => { for (const p of procs) { try { p.p.kill('SIGKILL'); } catch (_) {} } for (const m of mocks) await new Promise(r => m.server.close(r)); });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-restart-'));
const wait = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout menunggu kondisi'); await new Promise(r => setTimeout(r, 25)); } };
async function setup(credits = 10) {
  const m = await startMock(); mocks.push(m); const dir = tmp();
  const b = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(b);
  const code = (await b.adm('/admin/codes', { name: 'T', credits })).json.code;
  return { m, dir, b, code };
}

test('SIGKILL saat permintaan sedang di penyedia: restart -> UNKNOWN, kredit ditahan, kunci sama 409, tidak ditagih dua kali', async () => {
  const { m, dir, b, code } = await setup(10); m.delay = 1500;
  const K = 'kunci-restart-0001';
  const pending = b.translate(code, K).catch(() => null);
  await wait(() => m.calls.translate === 1);
  await b.kill(); await pending; await wait(() => m.completed.translate === 1, 4000);     // penyedia menyelesaikan dan MENAGIH walau klien dan server sudah mati
  m.delay = 0;
  const b2 = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(b2);
  assert.match(b2.out(), /"recovered":\{"failed":0,"unknown":1\}/, 'log start melaporkan pemulihan');
  const me = await b2.me(code); assert.equal(me.credits, 9, 'kredit TIDAK dikembalikan otomatis'); assert.equal(me.held, 1); assert.equal(me.unknown, 1);
  const unk = (await b2.adm('/admin/transactions?state=UNKNOWN')).json; assert.equal(unk.length, 1); assert.equal(unk[0].reason, 'restart_saat_diproses');
  assert.equal(m.seen[0].headers['x-client-request-id'], unk[0].txn, 'ID transaksi UNKNOWN = X-Client-Request-Id yang diterima penyedia (bahan rekonsiliasi)');
  const r2 = await b2.translate(code, K); assert.equal(r2.status, 409); assert.equal((await r2.json()).code, 'txn_unknown'); assert.equal(m.calls.translate, 1, 'tidak ada panggilan kedua ke penyedia');
  const r3 = await b2.translate(code, 'kunci-baru-0002'); assert.equal(r3.status, 200);   // permintaan baru yang sah
  assert.equal(m.completed.translate, 2); const me3 = await b2.me(code); assert.equal(me3.credits, 8); assert.equal(me3.held, 1);
  const res = await b2.adm('/admin/transactions/resolve', { txn: unk[0].txn, resolution: 'confirm', note: 'terlihat di log OpenAI', request_id: 'req-restart-confirm' });
  assert.equal(res.json.state, 'CONFIRMED'); const fin = await b2.me(code); assert.equal(fin.credits, 8); assert.equal(fin.held, 0);
  assert.equal(10 - fin.credits, m.completed.translate, 'kredit terpakai = pekerjaan yang benar-benar ditagih penyedia');
  assert.deepEqual((await b2.adm('/admin/audit')).json, { issues: [] });
});

test('rekonsiliasi refund setelah restart: penyedia tidak menagih -> kredit dan anggaran kembali', async () => {
  const { m, dir, b, code } = await setup(10); m.delay = 1500;
  const pending = b.translate(code, 'kunci-refund-0001').catch(() => null); await wait(() => m.calls.translate === 1); await b.kill(); await pending;
  const b2 = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(b2);
  const spent = (await b2.adm('/admin/usage')).json.estimate.spentUsd; assert.ok(spent > 0);
  const t = (await b2.adm('/admin/transactions?state=UNKNOWN')).json[0].txn;
  assert.equal((await b2.adm('/admin/transactions/resolve', { txn: t, resolution: 'refund', note: 'tidak ada di log OpenAI', request_id: 'req-restart-refund' })).json.state, 'FAILED');
  assert.equal((await b2.me(code)).credits, 10); assert.equal((await b2.adm('/admin/usage')).json.estimate.spentUsd, 0);
  assert.deepEqual((await b2.adm('/admin/audit')).json, { issues: [] });
});

test('restart saat transaksi PENDING belum dikirim: dikembalikan otomatis (penyedia tidak pernah dihubungi)', async () => {
  const m = await startMock(); mocks.push(m); const dir = tmp();
  const s = new Store(dir); const { code } = s.createCode({ credits: 10 }); const { id } = s.authenticate(code);
  s.begin(id, { kind: 'translate', credits: 1, usd: 0.0005, key: 'kunci-belum-kirim' });         // proses lama mati sebelum markSent
  const b = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(b);
  assert.match(b.out(), /"recovered":\{"failed":1,"unknown":0\}/);
  const me = await b.me(code); assert.equal(me.credits, 10); assert.equal(me.held, 0); assert.equal(m.calls.translate, 0);
});

test('restart berulang stabil: dua kali kill dan start tidak mengubah saldo, status, atau jumlah UNKNOWN', async () => {
  const { m, dir, b, code } = await setup(10); m.delay = 1500;
  const pending = b.translate(code, 'kunci-berulang-001').catch(() => null); await wait(() => m.calls.translate === 1); await b.kill(); await pending; m.delay = 0;
  let cur = null, snap = null;
  for (let i = 0; i < 3; i++) {
    cur = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(cur);
    const now = JSON.stringify({ me: await cur.me(code), unk: (await cur.adm('/admin/transactions?state=UNKNOWN')).json.map(t => [t.txn, t.state]) });
    if (snap) assert.equal(now, snap, 'restart ke-' + i); snap = now; await cur.kill();
  }
  assert.equal(JSON.parse(snap).me.credits, 9);
});

test('respons hilang setelah CONFIRMED lalu restart: kunci sama = 409 idem_conflict, kredit tetap dipotong sekali', async () => {
  const { m, dir, b, code } = await setup(10); m.delay = 300;
  const ctl = new AbortController();
  fetch(b.B + '/api/translate', { method: 'POST', signal: ctl.signal, headers: { Authorization: 'Bearer ' + code, 'Idempotency-Key': 'kunci-hilang-0003', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Halo', src: 'id', tgt: 'en' }) }).catch(() => null);
  await wait(() => m.calls.translate === 1); ctl.abort();                                        // klien pergi saat penyedia memproses: respons tidak pernah dibaca
  await wait(() => m.completed.translate === 1); await new Promise(r => setTimeout(r, 300));    // server tetap menyelesaikan dan mengonfirmasi
  assert.equal((await b.me(code)).credits, 9); await b.kill();
  const b2 = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(b2);
  const r = await b2.translate(code, 'kunci-hilang-0003'); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'idem_conflict');
  assert.equal(m.calls.translate, 1); assert.equal((await b2.me(code)).credits, 9);
});

test('backend menolak start dengan konfigurasi rusak (kredit negatif) dan menjelaskan alasannya', async () => {
  const dir = tmp();
  await assert.rejects(() => spawnBackend({ COST_STT: '-5' }, dir), /Konfigurasi tidak valid[\s\S]*COST_STT/);
});
