'use strict';
// Penjaga satu instance: dua proses tidak boleh memakai folder data yang sama.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DataLock } = require('../lib/lock');
const { spawnBackend, startMock } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-lock-'));
const procs = [], mocks = [];
after(async () => { for (const p of procs) try { p.p.kill('SIGKILL'); } catch (_) {} for (const m of mocks) await new Promise(r => m.server.close(r)); });

test('kunci: instance kedua ditolak dengan pesan jelas selama pemegang aktif', async () => {
  const dir = tmp(); const a = await new DataLock(dir, { staleMs: 5000 }).acquire();
  await assert.rejects(() => new DataLock(dir, { staleMs: 5000, waitMs: 250 }).acquire(), /dikunci oleh proses lain.*HANYA SATU instance/);
  a.release();
});

test('kunci: setelah dilepas, instance lain bisa mengambil; berkas kunci hilang saat release', async () => {
  const dir = tmp(); const a = await new DataLock(dir).acquire(); assert.ok(fs.existsSync(a.file)); a.release(); assert.ok(!fs.existsSync(a.file));
  const b = await new DataLock(dir).acquire(); b.release();
});

test('kunci: detak basi (pemilik mati/SIGKILL) diambil alih; detak segar tidak', async () => {
  const dir = tmp(); const a = await new DataLock(dir, { staleMs: 300 }).acquire(); clearInterval(a.timer);   // pemilik "mati": detak berhenti
  const old = Date.now() / 1000 - 10; fs.utimesSync(a.file, old, old);
  const b = await new DataLock(dir, { staleMs: 300, waitMs: 1000 }).acquire(); assert.ok(b.held); b.release();
});

test('kunci: detak memperbarui mtime selama proses hidup sehingga tidak dianggap basi', async () => {
  const dir = tmp(); const a = await new DataLock(dir, { staleMs: 300 }).acquire();
  await new Promise(r => setTimeout(r, 900)); assert.ok(Date.now() - fs.statSync(a.file).mtimeMs < 300);
  await assert.rejects(() => new DataLock(dir, { staleMs: 300, waitMs: 400 }).acquire(), /dikunci/); a.release();
});

test('kunci: pemilik yang kehilangan kunci menghentikan dirinya (onLost) agar tidak menulis berdampingan', async () => {
  const dir = tmp(); let lost = null; const a = await new DataLock(dir, { staleMs: 300, onLost: e => { lost = e; } }).acquire();
  fs.writeFileSync(a.file, JSON.stringify({ id: 'pemilik-lain' }));
  await new Promise(r => setTimeout(r, 400)); assert.ok(lost && /diambil proses lain/.test(lost.message)); assert.equal(a.held, false);
});

test('dua proses backend pada DATA_DIR yang sama: yang kedua menolak start; setelah SIGKILL, restart mengambil alih', async () => {
  const m = await startMock(); mocks.push(m); const dir = tmp();
  const b1 = await spawnBackend({ OPENAI_BASE: m.base, LOCK_WAIT_MS: '500' }, dir); procs.push(b1);
  await assert.rejects(() => spawnBackend({ OPENAI_BASE: m.base, LOCK_WAIT_MS: '500' }, dir), /dikunci oleh proses lain/);
  await b1.kill();
  const b2 = await spawnBackend({ OPENAI_BASE: m.base }, dir); procs.push(b2);   // kunci basi (SIGKILL) diambil alih dalam LOCK_STALE_MS
  assert.match(b2.out(), /"data_lock":true/); assert.equal((await b2.adm('/admin/audit')).json.issues.length, 0);
});

test('DATA_LOCK=false mematikan penjaga (hanya untuk pengembangan)', async () => {
  const m = await startMock(); mocks.push(m); const dir = tmp();
  const b = await spawnBackend({ OPENAI_BASE: m.base, DATA_LOCK: 'false' }, dir); procs.push(b); assert.match(b.out(), /"data_lock":false/); assert.ok(!fs.existsSync(path.join(dir, 'vocalbridge.lock')));
});
