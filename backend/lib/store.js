'use strict';
// Penyimpanan kode akses, kredit, TRANSAKSI, batas harian, anggaran bulanan, dan log admin.
// Berkas JSON ditulis atomik. Cukup untuk tahap uji dengan tester sedikit dan SATU instance server.
//
// Mesin status transaksi (satu transaksi = satu permintaan berbayar):
//   PENDING   kredit ditahan; permintaan sedang diproses. `sent_at` diisi SEBELUM permintaan keluar ke penyedia (write-ahead).
//   CONFIRMED penyedia berhasil; kredit terpakai.
//   FAILED    pasti tidak ditagih (ditolak penyedia, atau pasti tidak terkirim); kredit dikembalikan.
//   UNKNOWN   hasil di penyedia TIDAK diketahui (timeout, koneksi putus, server mati saat diproses). Kredit TETAP ditahan
//             dan kunci idempotensi terkunci sampai administrator merekonsiliasi (confirm / refund / refund_keep_cost).
// Transisi sah: PENDING -> CONFIRMED | FAILED | UNKNOWN ; UNKNOWN -> CONFIRMED | FAILED (hanya admin). Selain itu terlarang.
// Node berjalan satu utas dan metode di sini sinkron: tidak ada balapan antar await.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, intIn, reqId, bool, cleanText } = require('./util');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const rid = n => crypto.randomBytes(n).toString('hex');
const OPEN = new Set(['PENDING', 'UNKNOWN']); // transaksi yang kreditnya masih ditahan

class Store {
  constructor(dir, { monthlyBudgetUsd = 5, dailyCalls = 600, maxBalance = 10000000, maxCreditsPerOp = 1000000, maxTxnsPerCode = 500 } = {}) {
    this.opts = { monthlyBudgetUsd, dailyCalls, maxBalance, maxCreditsPerOp, maxTxnsPerCode };
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'vocalbridge.json');
    this.saveErrors = 0; this.lastSaveError = null;
    this.migrated = [];
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    if (!d) { let old = null; try { old = JSON.parse(fs.readFileSync(path.join(dir, 'codes.json'), 'utf8')); } catch (_) {} d = { version: 1, codes: old || {}, meta: {} }; }
    this.codes = d.codes || {};
    this.meta = Object.assign({ month: month(), spentUsd: 0, kill: false, reported: {} }, d.meta || {});
    this.adminLog = Array.isArray(d.adminLog) ? d.adminLog : [];
    this.adminReq = d.adminReq && typeof d.adminReq === 'object' ? d.adminReq : {};
    this._normalize(d.version || 1);
    this._save(true);
  }

  // ----- persistensi -----
  _save(strict) {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 3, codes: this.codes, meta: this.meta, adminLog: this.adminLog, adminReq: this.adminReq }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.saveErrors++; this.lastSaveError = String(e && e.message).slice(0, 120);
      if (strict) throw new HttpError(503, 'penyimpanan data tidak tersedia, permintaan tidak diproses', 'store_unavailable');
    }
  }
  get healthy() { return this.saveErrors === 0; }
  _log(op, id, detail, requestId) {
    this.adminLog.push({ t: new Date().toISOString(), op, id: id ? id.slice(0, 8) : null, detail, request_id: requestId || null });
    while (this.adminLog.length > 500) this.adminLog.shift();
  }

  // Menormalkan data dari versi lama dan memperbaiki saldo rusak (mis. null akibat topup tidak valid di V1).
  _normalize(version) {
    for (const [id, r] of Object.entries(this.codes)) {
      if (!Number.isSafeInteger(r.credits) || r.credits < 0) { this._log('migrasi', id, 'saldo rusak (' + JSON.stringify(r.credits) + ') diatur 0, periksa manual'); this.migrated.push(id.slice(0, 8)); r.credits = 0; }
      r.used = Number.isSafeInteger(r.used) && r.used >= 0 ? r.used : 0;
      r.txns = r.txns && typeof r.txns === 'object' ? r.txns : {};
      if (version < 3) {
        // v1/v2: "holds" yang yatim tidak diketahui apakah sudah dikirim -> UNKNOWN (tidak dikembalikan otomatis).
        for (const [hid, h] of Object.entries(r.holds || {})) {
          r.txns[h.key || 'migrasi-' + hid] = { id: hid, key: h.key || 'migrasi-' + hid, kind: 'tidak_diketahui', state: 'UNKNOWN', credits: h.credits, usd: h.usd || 0, month: month(), day: today(),
            created: new Date(h.ts || Date.now()).toISOString(), sent_at: new Date(h.ts || Date.now()).toISOString(), finished_at: null, attempt: 1, reason: 'migrasi_v' + version, usage: null };
        }
        for (const k of r.idem || []) if (!r.txns[k]) r.txns[k] = { id: 'm' + rid(5), key: k, kind: 'tidak_diketahui', state: 'CONFIRMED', credits: 0, usd: 0, month: month(), day: today(), created: null, sent_at: null, finished_at: null, attempt: 1, reason: 'migrasi_v' + version, usage: null };
        delete r.holds; delete r.idem;
      }
      r.held = Object.values(r.txns).reduce((s, t) => s + (OPEN.has(t.state) ? t.credits : 0), 0);
    }
  }
  _roll() { const m = month(); if (this.meta.month !== m) { this.meta.month = m; this.meta.spentUsd = 0; this.meta.reported = {}; } }

  // ----- kode akses -----
  hash(code) { return sha(code); }
  createCode({ name = '', credits, expiresDays = 0, dailyCalls = 0 } = {}) {
    intIn(credits, 1, this.opts.maxCreditsPerOp, 'credits');
    const code = 'VB-' + crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[-_]/g, 'X');
    const rec = { name: cleanText(name, 60, 'name'), credits, created: new Date().toISOString(), used: 0, held: 0, txns: {} };
    if (expiresDays > 0) rec.expires = new Date(Date.now() + expiresDays * 86400000).toISOString();
    if (dailyCalls > 0) rec.dailyCalls = dailyCalls;
    this.codes[sha(code)] = rec; this._log('create', sha(code), { credits }); this._save(true);
    return { code, id: sha(code).slice(0, 8), expires: rec.expires || null };
  }
  authenticate(code) {
    const id = sha(String(code || ''));
    const rec = this.codes[id];
    if (!rec || rec.disabled || (rec.expires && Date.now() > Date.parse(rec.expires))) return null;
    return { id, rec };
  }
  list() {
    return Object.entries(this.codes).map(([id, r]) => ({ id: id.slice(0, 8), name: r.name, credits: r.credits, held: r.held, used: r.used, disabled: !!r.disabled, expires: r.expires || null, created: r.created,
      unknown: Object.values(r.txns).filter(t => t.state === 'UNKNOWN').length }));
  }
  // Cari kode dengan awalan id. Wajib cocok persis satu (hindari mengubah kode yang salah).
  _find(prefix) {
    const p = typeof prefix === 'string' ? prefix : '';
    if (!/^[0-9a-f]{8,64}$/.test(p)) throw new HttpError(400, 'id kode harus 8 karakter heksadesimal atau lebih (lihat GET /admin/codes)', 'bad_id');
    const hits = Object.keys(this.codes).filter(k => k.startsWith(p));
    if (!hits.length) throw new HttpError(404, 'id tidak ditemukan', 'not_found');
    if (hits.length > 1) throw new HttpError(409, 'id ambigu: cocok dengan lebih dari satu kode, tulis lebih panjang', 'ambiguous_id');
    return hits[0];
  }

  // ----- transaksi -----
  _txn(h) {
    const rec = this.codes[h.id], t = rec && rec.txns[h.key];
    if (!t || t.id !== h.txn) throw new Error('transaksi tidak ditemukan: ' + h.txn);
    return { rec, t };
  }
  _assertState(t, ...allowed) { if (!allowed.includes(t.state)) throw new Error('transisi terlarang: ' + t.id + ' ' + t.state + ' -> ' + allowed.join('|')); }
  _trim(rec) {
    const keys = Object.keys(rec.txns);
    for (let i = 0; keys.length - i > this.opts.maxTxnsPerCode && i < keys.length; i++) { if (!OPEN.has(rec.txns[keys[i]].state)) delete rec.txns[keys[i]]; } // jangan pernah membuang transaksi terbuka
  }

  begin(id, { kind, credits, usd, key }) {
    const rec = this.codes[id]; this._roll();
    intIn(credits, 1, 1e9, 'credits');
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) throw new Error('usd tidak valid');
    const prev = rec.txns[key];
    if (prev) {
      if (prev.state === 'PENDING') throw new HttpError(409, 'permintaan ini masih diproses', 'txn_pending');
      if (prev.state === 'UNKNOWN') { const e = new HttpError(409, 'permintaan ini berstatus belum pasti di penyedia; kredit ditahan sampai administrator memeriksa. Jangan kirim ulang dengan kunci yang sama.', 'txn_unknown'); e.txn = prev.id; throw e; }
      if (prev.state === 'CONFIRMED') throw new HttpError(409, 'permintaan ini sudah diproses dan hasilnya tidak tersimpan (server tidak menyimpan hasil); kirim ulang dengan Idempotency-Key baru bila perlu', 'idem_conflict');
    } // FAILED: boleh dicoba lagi dengan kunci yang sama
    if (rec.day == null || rec.day.d !== today()) rec.day = { d: today(), calls: 0 };
    if (rec.day.calls >= (rec.dailyCalls || this.opts.dailyCalls)) throw new HttpError(429, 'batas pemakaian harian tercapai', 'daily_limit');
    if (rec.credits < credits) { const e = new HttpError(402, 'kredit habis', 'no_credit'); e.credits = rec.credits; throw e; }
    if (this.meta.spentUsd + usd > this.opts.monthlyBudgetUsd) throw new HttpError(503, 'batas anggaran bulanan (perkiraan internal) tercapai, layanan dihentikan sementara', 'budget_exceeded');
    const t = { id: rid(6), key, kind, state: 'PENDING', credits, usd, month: this.meta.month, day: today(), created: new Date().toISOString(), sent_at: null, finished_at: null, attempt: prev ? prev.attempt + 1 : 1, reason: null, usage: null };
    const snap = { credits: rec.credits, held: rec.held, calls: rec.day.calls, spent: this.meta.spentUsd, prev };
    rec.txns[key] = t; rec.credits -= credits; rec.held += credits; rec.day.calls++; this.meta.spentUsd += usd;
    try { this._save(true); }
    catch (e) { rec.credits = snap.credits; rec.held = snap.held; rec.day.calls = snap.calls; this.meta.spentUsd = snap.spent; if (snap.prev) rec.txns[key] = snap.prev; else delete rec.txns[key]; throw e; }
    this._trim(rec);
    return { id, key, txn: t.id, usd };
  }
  // Tulis-dulu: dipanggil TEPAT SEBELUM permintaan ke penyedia. Gagal menyimpan = permintaan tidak boleh dikirim.
  markSent(h) {
    const { t } = this._txn(h); this._assertState(t, 'PENDING');
    t.sent_at = new Date().toISOString();
    try { this._save(true); } catch (e) { t.sent_at = null; throw e; }
  }
  confirm(h, extra = {}) {
    const { rec, t } = this._txn(h); this._assertState(t, 'PENDING');
    t.state = 'CONFIRMED'; t.finished_at = new Date().toISOString(); t.usage = extra.usage || null; t.provider_request_id = extra.providerRequestId || null;
    rec.held -= t.credits; rec.used += t.credits;
    const u = extra.usage; if (u && t.month === this.meta.month) for (const [k, v] of Object.entries(u)) if (typeof v === 'number' && Number.isFinite(v)) this.meta.reported[k] = (this.meta.reported[k] || 0) + v;
    this._save(false);
  }
  _refund(rec, t, keepCost) {
    rec.held -= t.credits; rec.credits += t.credits;
    if (!keepCost && t.month === this.meta.month) this.meta.spentUsd = Math.max(0, this.meta.spentUsd - t.usd);
    if (rec.day && rec.day.d === t.day) rec.day.calls = Math.max(0, rec.day.calls - 1);
  }
  // Pasti tidak ditagih: ditolak penyedia ATAU pasti tidak terkirim. Dilarang untuk transaksi terkirim tanpa kepastian.
  fail(h, reason, { definitive = false } = {}) {
    const { rec, t } = this._txn(h); this._assertState(t, 'PENDING');
    if (t.sent_at && !definitive) throw new Error('refund terlarang: transaksi ' + t.id + ' sudah dikirim ke penyedia dan hasilnya belum pasti');
    t.state = 'FAILED'; t.finished_at = new Date().toISOString(); t.reason = String(reason || '').slice(0, 80);
    this._refund(rec, t, false); this._save(false);
  }
  // Hasil di penyedia tidak diketahui: kredit dan anggaran TETAP ditahan.
  markUnknown(h, reason) {
    const { t } = this._txn(h); this._assertState(t, 'PENDING');
    t.state = 'UNKNOWN'; t.reason = String(reason || '').slice(0, 80); this._save(false);
  }
  // Setelah restart atau untuk yatim: belum terkirim -> FAILED (aman dikembalikan); sudah terkirim -> UNKNOWN (tidak dikembalikan).
  recover({ live = new Set(), olderThanMs = 0 } = {}) {
    const out = { failed: 0, unknown: 0 }, now = Date.now();
    for (const [id, rec] of Object.entries(this.codes)) for (const t of Object.values(rec.txns)) {
      if (t.state !== 'PENDING' || live.has(t.id)) continue;
      if (olderThanMs && now - Date.parse(t.created) < olderThanMs) continue;
      const h = { id, key: t.key, txn: t.id };
      if (!t.sent_at) { this.fail(h, 'tidak_terkirim_sebelum_restart', { definitive: true }); out.failed++; } else { this.markUnknown(h, 'restart_saat_diproses'); out.unknown++; }
    }
    return out;
  }
  findTxn(txnId) {
    for (const [id, rec] of Object.entries(this.codes)) for (const t of Object.values(rec.txns)) if (t.id === txnId) return { id, rec, t };
    throw new HttpError(404, 'transaksi tidak ditemukan', 'not_found');
  }
  listTxns({ state, limit = 100 } = {}) {
    const out = [];
    for (const [id, rec] of Object.entries(this.codes)) for (const t of Object.values(rec.txns)) if (!state || t.state === state)
      out.push({ txn: t.id, code: id.slice(0, 8), kind: t.kind, state: t.state, credits: t.credits, usd_estimate: t.usd, created: t.created, sent_at: t.sent_at, finished_at: t.finished_at, reason: t.reason, attempt: t.attempt, provider_request_id: t.provider_request_id || null });
    out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return out.slice(0, limit);
  }

  // ----- operasi admin: validasi ketat, idempoten lewat request_id, tercatat -----
  _adminOp(requestId, sig, fn) {
    const prev = this.adminReq[requestId];
    if (prev) { if (prev.sig !== sig) throw new HttpError(409, 'request_id ini sudah dipakai untuk operasi lain', 'request_id_conflict'); return Object.assign({}, prev.result, { replayed: true }); }
    const result = fn();
    this.adminReq[requestId] = { sig, result, t: new Date().toISOString() };
    const ks = Object.keys(this.adminReq); for (let i = 0; ks.length - i > 500; i++) delete this.adminReq[ks[i]];
    this._save(true);
    return result;
  }
  topup(prefix, credits, requestId) {
    reqId(requestId); intIn(credits, 1, this.opts.maxCreditsPerOp, 'credits');
    const id = this._find(prefix);
    return this._adminOp(requestId, 'topup:' + id + ':' + credits, () => {
      const rec = this.codes[id];
      if (rec.credits + rec.held + credits > this.opts.maxBalance) throw new HttpError(400, 'saldo melebihi batas maksimum ' + this.opts.maxBalance, 'balance_cap');
      rec.credits += credits; this._log('topup', id, { credits }, requestId);
      return { id: id.slice(0, 8), credits: rec.credits, held: rec.held };
    });
  }
  // Pengurangan saldo (koreksi). Tidak boleh membuat saldo negatif dan tidak menyentuh kredit yang ditahan.
  adjust(prefix, delta, reason, requestId) {
    reqId(requestId); intIn(delta, -this.opts.maxCreditsPerOp, -1, 'delta'); const why = cleanText(reason, 200, 'reason', { required: true });
    const id = this._find(prefix);
    return this._adminOp(requestId, 'adjust:' + id + ':' + delta, () => {
      const rec = this.codes[id];
      if (rec.credits + delta < 0) throw new HttpError(400, 'pengurangan melebihi saldo tersedia (' + rec.credits + '); kredit yang ditahan tidak bisa dikurangi', 'insufficient_available');
      rec.credits += delta; this._log('adjust', id, { delta, reason: why }, requestId);
      return { id: id.slice(0, 8), credits: rec.credits, held: rec.held };
    });
  }
  setDisabled(prefix, disabled, requestId) {
    reqId(requestId); bool(disabled, 'disabled');
    const id = this._find(prefix);
    return this._adminOp(requestId, 'disable:' + id + ':' + disabled, () => { this.codes[id].disabled = disabled; this._log('disable', id, { disabled }, requestId); return { id: id.slice(0, 8), disabled }; });
  }
  // Rekonsiliasi transaksi UNKNOWN. Keputusan manusia setelah memeriksa log/dashboard OpenAI (lihat docs/BACKEND.md).
  resolve(txnId, resolution, note, requestId) {
    reqId(requestId);
    if (!['confirm', 'refund', 'refund_keep_cost'].includes(resolution)) throw new HttpError(400, 'resolution harus confirm, refund, atau refund_keep_cost', 'bad_resolution');
    const why = cleanText(note, 200, 'note', { required: true });
    return this._adminOp(requestId, 'resolve:' + txnId + ':' + resolution, () => {
      const { id, rec, t } = this.findTxn(String(txnId));
      if (t.state !== 'UNKNOWN') throw new HttpError(409, 'hanya transaksi UNKNOWN yang dapat direkonsiliasi (status sekarang ' + t.state + ')', 'not_unknown');
      t.finished_at = new Date().toISOString(); t.reason = 'admin:' + resolution + ' - ' + why;
      if (resolution === 'confirm') { t.state = 'CONFIRMED'; rec.held -= t.credits; rec.used += t.credits; }
      else { t.state = 'FAILED'; this._refund(rec, t, resolution === 'refund_keep_cost'); }
      this._log('resolve', id, { txn: t.id, resolution, note: why }, requestId);
      return { txn: t.id, state: t.state, code: id.slice(0, 8), credits: rec.credits, held: rec.held };
    });
  }

  // ----- tombol darurat, ringkasan, pemeriksaan konsistensi -----
  setKill(on) { this.meta.kill = !!on; this._log('kill', null, { killed: !!on }); this._save(true); return this.meta.kill; }
  get killed() { return !!this.meta.kill; }
  usage() {
    this._roll();
    const counts = { PENDING: 0, CONFIRMED: 0, FAILED: 0, UNKNOWN: 0 }; let unknownUsd = 0, unknownCredits = 0;
    for (const rec of Object.values(this.codes)) for (const t of Object.values(rec.txns)) { counts[t.state]++; if (t.state === 'UNKNOWN') { unknownUsd += t.usd; unknownCredits += t.credits; } }
    return { month: this.meta.month, killed: !!this.meta.kill,
      estimate: { basis: 'perkiraan internal, bukan tagihan', spentUsd: +this.meta.spentUsd.toFixed(4), budgetUsd: this.opts.monthlyBudgetUsd, includesUnknownUsd: +unknownUsd.toFixed(4) },
      transactions: counts, unknownCredits,
      reportedByProvider: this.meta.reported,
      storage: { healthy: this.healthy, lastError: this.lastSaveError } };
  }
  // Mengembalikan daftar kejanggalan (kosong = konsisten).
  audit() {
    const bad = [];
    for (const [id, r] of Object.entries(this.codes)) {
      const s = id.slice(0, 8);
      if (!Number.isSafeInteger(r.credits) || r.credits < 0) bad.push(s + ': saldo tidak valid ' + r.credits);
      if (!Number.isSafeInteger(r.used) || r.used < 0) bad.push(s + ': used tidak valid');
      const open = Object.values(r.txns).reduce((a, t) => a + (OPEN.has(t.state) ? t.credits : 0), 0);
      if (r.held !== open) bad.push(s + ': held ' + r.held + ' != jumlah transaksi terbuka ' + open);
      for (const t of Object.values(r.txns)) {
        if (!['PENDING', 'CONFIRMED', 'FAILED', 'UNKNOWN'].includes(t.state)) bad.push(s + ': status tidak dikenal ' + t.state);
        if (t.state === 'UNKNOWN' && !t.sent_at) bad.push(s + ': UNKNOWN tanpa sent_at ' + t.id);
        if (t.state === 'FAILED' && t.sent_at && !t.reason) bad.push(s + ': FAILED terkirim tanpa alasan ' + t.id);
      }
    }
    if (!(this.meta.spentUsd >= 0)) bad.push('anggaran negatif');
    return bad;
  }
}

module.exports = { Store, OPEN };
