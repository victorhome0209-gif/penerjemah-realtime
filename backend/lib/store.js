'use strict';
// Penyimpanan kode akses, kredit, tahanan (hold), batas harian, dan anggaran bulanan.
// Berkas JSON ditulis atomik. Cukup untuk tahap uji dengan jumlah tester kecil.
// Node berjalan satu utas: setiap metode di sini sinkron, sehingga tidak ada dua permintaan
// yang bisa lolos pemeriksaan saldo yang sama (tidak ada balapan antar await).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./util');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

class Store {
  constructor(dir, { monthlyBudgetUsd = 5, dailyCalls = 600 } = {}) {
    this.opts = { monthlyBudgetUsd, dailyCalls };
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'vocalbridge.json');
    const legacy = path.join(dir, 'codes.json');
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    if (!d) { // migrasi dari backend lama: berkas datar {hash: catatan}
      let old = null; try { old = JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch (_) {}
      d = { version: 2, codes: old || {}, meta: {} };
    }
    this.codes = d.codes || {};
    this.meta = Object.assign({ month: month(), spentUsd: 0, kill: false }, d.meta || {});
    for (const r of Object.values(this.codes)) { r.held = r.held || 0; r.holds = r.holds || {}; r.idem = r.idem || []; r.used = r.used || 0; }
    this._save();
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, codes: this.codes, meta: this.meta }));
    fs.renameSync(tmp, this.file);
  }
  _roll() { const m = month(); if (this.meta.month !== m) { this.meta.month = m; this.meta.spentUsd = 0; } }

  // ----- kode akses -----
  hash(code) { return sha(code); }
  createCode({ name = '', credits, expiresDays, dailyCalls } = {}) {
    const code = 'VB-' + crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[-_]/g, 'X');
    const rec = { name: String(name).slice(0, 60), credits, created: new Date().toISOString(), used: 0, held: 0, holds: {}, idem: [] };
    if (expiresDays > 0) rec.expires = new Date(Date.now() + expiresDays * 86400000).toISOString();
    if (dailyCalls > 0) rec.dailyCalls = Math.floor(dailyCalls);
    this.codes[sha(code)] = rec; this._save();
    return { code, expires: rec.expires || null };
  }
  authenticate(code) {
    const id = sha(String(code || ''));
    const rec = this.codes[id];
    if (!rec || rec.disabled || (rec.expires && Date.now() > Date.parse(rec.expires))) return null;
    return { id, rec };
  }
  list() {
    return Object.entries(this.codes).map(([id, r]) => ({ id: id.slice(0, 8), name: r.name, credits: r.credits, held: r.held, used: r.used, disabled: !!r.disabled, expires: r.expires || null, created: r.created }));
  }
  topup(prefix, credits, disabled) {
    const p = String(prefix || '');
    const hit = p.length >= 6 ? Object.keys(this.codes).find(k => k.startsWith(p)) : null;
    if (!hit) throw new HttpError(404, 'id tidak ditemukan');
    this.codes[hit].credits += Math.floor(+credits) || 0;
    if (disabled != null) this.codes[hit].disabled = !!disabled;
    this._save();
    return { id: hit.slice(0, 8), credits: this.codes[hit].credits, disabled: !!this.codes[hit].disabled };
  }

  // ----- tahan, konfirmasi, kembalikan -----
  reserve(id, { credits, usd, key }) {
    const rec = this.codes[id]; this._roll();
    if (rec.day == null || rec.day.d !== today()) rec.day = { d: today(), calls: 0 };
    if (rec.day.calls >= (rec.dailyCalls || this.opts.dailyCalls)) throw new HttpError(429, 'batas pemakaian harian tercapai', 'daily_limit');
    if (rec.credits < credits) { const e = new HttpError(402, 'kredit habis', 'no_credit'); e.credits = rec.credits; throw e; }
    if (this.meta.spentUsd + usd > this.opts.monthlyBudgetUsd) throw new HttpError(503, 'batas anggaran bulanan tercapai, layanan dihentikan sementara', 'budget_exceeded');
    if (rec.idem.includes(key)) throw new HttpError(409, 'permintaan ini sudah diproses, kirim ulang dengan Idempotency-Key baru', 'idem_conflict');
    const holdId = crypto.randomBytes(6).toString('hex');
    rec.idem.push(key); if (rec.idem.length > 300) rec.idem.shift();
    rec.credits -= credits; rec.held += credits; rec.day.calls++;
    this.meta.spentUsd += usd;
    rec.holds[holdId] = { credits, usd, key, ts: Date.now() };
    this._save();
    return { id, holdId, credits, usd, key };
  }
  capture(h) {
    const rec = this.codes[h.id]; if (!rec || !rec.holds[h.holdId]) return;
    delete rec.holds[h.holdId]; rec.held -= h.credits; rec.used += h.credits; this._save();
  }
  release(h) {
    const rec = this.codes[h.id]; if (!rec || !rec.holds[h.holdId]) return;
    delete rec.holds[h.holdId]; rec.held -= h.credits; rec.credits += h.credits;
    this.meta.spentUsd = Math.max(0, this.meta.spentUsd - h.usd);
    if (rec.day) rec.day.calls = Math.max(0, rec.day.calls - 1);
    rec.idem = rec.idem.filter(k => k !== h.key); // gagal dan dikembalikan: boleh dicoba lagi
    this._save();
  }
  // Kembalikan tahanan yang menggantung (mis. server mati di tengah permintaan).
  sweep(maxAgeMs) {
    let n = 0; const now = Date.now();
    for (const [id, rec] of Object.entries(this.codes)) {
      for (const [holdId, h] of Object.entries(rec.holds)) {
        if (now - h.ts > maxAgeMs) { this.release({ id, holdId, credits: h.credits, usd: h.usd, key: h.key }); n++; }
      }
    }
    return n;
  }

  // ----- tombol darurat dan ringkasan -----
  setKill(on) { this.meta.kill = !!on; this._save(); return this.meta.kill; }
  get killed() { return !!this.meta.kill; }
  usage() { this._roll(); return { month: this.meta.month, spentUsdEstimate: +this.meta.spentUsd.toFixed(4), budgetUsd: this.opts.monthlyBudgetUsd, killed: !!this.meta.kill }; }
}

module.exports = { Store };
