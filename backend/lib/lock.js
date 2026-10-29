'use strict';
// Penjaga SATU INSTANCE pada folder data. Penyimpanan berkas JSON tidak aman bila dua proses menulis bersamaan
// (mis. dua deploy Railway yang bertumpang tindih pada Volume yang sama). Pemegang kunci memperbarui detak (mtime)
// berkala; proses lain menunggu sampai detak basi lalu mengambil alih, atau menyerah.
// Kunci yang ditinggalkan SIGKILL/crash basi dalam LOCK_STALE_MS (bawaan 15 detik): restart sesudah crash menunggu paling lama itu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class DataLock {
  constructor(dir, { staleMs = 15000, waitMs = 30000, onLost = null } = {}) {
    this.file = path.join(dir, 'vocalbridge.lock');
    this.staleMs = staleMs; this.waitMs = waitMs; this.onLost = onLost;
    this.id = crypto.randomBytes(8).toString('hex'); this.timer = null; this.held = false;
    fs.mkdirSync(dir, { recursive: true });
  }
  _readOwner() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).id; } catch (_) { return null; } }
  async acquire() {
    const t0 = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(fd, JSON.stringify({ id: this.id, pid: process.pid, host: os.hostname(), since: new Date().toISOString() })); fs.closeSync(fd);
        this.held = true; this._heartbeat(); return this;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let age; try { age = Date.now() - fs.statSync(this.file).mtimeMs; } catch (_) { continue; }
        if (age > this.staleMs) { try { fs.unlinkSync(this.file); } catch (_) {} continue; }   // detak basi: pemilik sudah mati
        if (Date.now() - t0 >= this.waitMs) {
          let who = ''; try { const o = JSON.parse(fs.readFileSync(this.file, 'utf8')); who = ' (pid ' + o.pid + ' di ' + o.host + ', sejak ' + o.since + ')'; } catch (_) {}
          throw new Error('folder data dikunci oleh proses lain' + who + '. Jalankan HANYA SATU instance backend per Volume.');
        }
        await new Promise(r => setTimeout(r, Math.min(200, Math.max(20, this.staleMs / 10))));
      }
    }
  }
  _heartbeat() {
    this.timer = setInterval(() => {
      if (this._readOwner() !== this.id) { this.held = false; clearInterval(this.timer); if (this.onLost) this.onLost(new Error('kunci folder data diambil proses lain')); return; }
      try { const now = new Date(); fs.utimesSync(this.file, now, now); } catch (_) {}
    }, Math.max(20, Math.floor(this.staleMs / 3)));
    this.timer.unref();
  }
  release() {
    clearInterval(this.timer);
    if (this.held && this._readOwner() === this.id) { try { fs.unlinkSync(this.file); } catch (_) {} }
    this.held = false;
  }
}
module.exports = { DataLock };
