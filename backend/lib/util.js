'use strict';
// Utilitas: galat HTTP, penyamaran rahasia, validasi ketat, pembaca header WAV, pembatas laju, log.

// outcome (hanya untuk galat penyedia): 'rejected' = penyedia menjawab menolak (pasti tidak diproses),
// 'not_sent' = permintaan pasti tidak keluar, 'unknown' = hasil di penyedia TIDAK diketahui (mungkin sudah ditagih).
class HttpError extends Error {
  constructor(status, message, code, outcome) { super(message); this.status = status; this.code = code || null; this.outcome = outcome || null; }
}

const SECRET_RE = /(sk-[A-Za-z0-9_\-]{6,}|sk_[A-Za-z0-9]{8,}|xi-api-key\S*|Bearer\s+[A-Za-z0-9._\-]{8,}|VB-[A-Z0-9]{8,})/g;
function redact(s) { return String(s == null ? '' : s).replace(SECRET_RE, '[disembunyikan]'); }

// ----- validasi ketat untuk input admin dan klien -----
// Hanya bilangan bulat bertipe number: menolak string, desimal, NaN, Infinity, dan nilai di luar rentang.
function intIn(v, min, max, name) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new HttpError(400, name + ' harus bilangan bulat antara ' + min + ' dan ' + max, 'bad_' + name);
  return v;
}
function reqId(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_\-]{8,64}$/.test(v)) throw new HttpError(400, 'request_id wajib (8-64 karakter huruf, angka, - atau _) agar pengulangan tidak mengubah saldo dua kali', 'request_id_required');
  return v;
}
function bool(v, name) { if (typeof v !== 'boolean') throw new HttpError(400, name + ' harus true atau false (bukan teks)', 'bad_' + name); return v; }
function cleanText(v, max, name, { required = false } = {}) {
  if (v == null || v === '') { if (required) throw new HttpError(400, name + ' wajib diisi', 'bad_' + name); return ''; }
  if (typeof v !== 'string') throw new HttpError(400, name + ' harus teks', 'bad_' + name);
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  if (required && !t) throw new HttpError(400, name + ' wajib diisi', 'bad_' + name);
  return t;
}

// Baca header WAV PCM 16-bit. Mengembalikan {rate, channels, seconds}.
function parseWav(buf, { minSeconds = 0.3, maxSeconds = 30 } = {}) {
  const bad = m => new HttpError(400, m, 'audio_invalid');
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw bad('audio kosong atau terlalu pendek');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw bad('format audio harus WAV');
  let off = 12, fmt = null, dataBytes = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - (off + 8)); break;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataBytes == null) throw bad('header WAV tidak lengkap');
  if (fmt.format !== 1 || fmt.bits !== 16) throw bad('WAV harus PCM 16-bit');
  if (fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8000 || fmt.rate > 48000) throw bad('WAV: kanal atau laju sampel tidak didukung');
  const seconds = dataBytes / (fmt.rate * fmt.channels * 2);
  if (seconds < minSeconds) throw bad('audio terlalu pendek');
  if (seconds > maxSeconds) throw new HttpError(413, 'audio terlalu panjang (maksimal ' + maxSeconds + ' detik)', 'audio_too_long');
  return { rate: fmt.rate, channels: fmt.channels, seconds };
}

class RateLimiter {
  constructor(limit, windowMs = 60000) { this.limit = limit; this.windowMs = windowMs; this.map = new Map(); }
  hit(key, now = Date.now()) {
    let b = this.map.get(key);
    if (!b || now - b.t >= this.windowMs) { b = { t: now, n: 0 }; this.map.set(key, b); }
    b.n++;
    if (this.map.size > 5000) for (const [k, v] of this.map) if (now - v.t >= this.windowMs) this.map.delete(k);
    return b.n <= this.limit;
  }
}

function makeLogger(sink) {
  const out = sink || (line => process.stdout.write(line + '\n'));
  return obj => out(redact(JSON.stringify(Object.assign({ t: new Date().toISOString() }, obj))));
}

module.exports = { HttpError, redact, intIn, reqId, bool, cleanText, parseWav, RateLimiter, makeLogger };
