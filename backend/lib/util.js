'use strict';
// Utilitas kecil: galat HTTP, penyamaran rahasia di log, pembaca header WAV, pembatas laju.

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

// Pola kunci yang tidak boleh muncul di log atau balasan.
const SECRET_RE = /(sk-[A-Za-z0-9_\-]{6,}|sk_[A-Za-z0-9]{8,}|xi-api-key\S*|Bearer\s+[A-Za-z0-9._\-]{8,}|VB-[A-Z0-9]{8,})/g;
function redact(s) { return String(s == null ? '' : s).replace(SECRET_RE, '[disembunyikan]'); }

// Baca header WAV PCM 16-bit. Mengembalikan {rate, channels, seconds}. Melempar HttpError 400 bila tidak valid.
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

// Pembatas laju jendela tetap per kunci.
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

// Log satu baris JSON. Tidak pernah berisi isi permintaan, audio, atau header.
function makeLogger(sink) {
  const out = sink || (line => process.stdout.write(line + '\n'));
  return obj => out(redact(JSON.stringify(Object.assign({ t: new Date().toISOString() }, obj))));
}

module.exports = { HttpError, redact, parseWav, RateLimiter, makeLogger };
