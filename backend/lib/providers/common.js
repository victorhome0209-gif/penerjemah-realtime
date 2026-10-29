'use strict';
// Klasifikasi hasil panggilan ke penyedia menjadi tiga kepastian (dipakai mesin status transaksi):
//   rejected : penyedia menjawab menolak (4xx)               -> pasti tidak diproses, aman dikembalikan
//   not_sent : permintaan pasti tidak keluar (DNS, tolak koneksi, TLS gagal) -> aman dikembalikan
//   unknown  : timeout, koneksi putus, 5xx, respons rusak    -> mungkin sudah ditagih, JANGAN dikembalikan otomatis
const { HttpError, redact } = require('../util');

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function fetchError(e, who) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return new HttpError(504, who + ' tidak menjawab tepat waktu', 'provider_timeout', 'unknown');
  const code = e && e.cause && e.cause.code;
  if (code && NOT_SENT.has(code)) return new HttpError(502, who + ' tidak terjangkau', 'provider_unreachable', 'not_sent');
  return new HttpError(502, who + ': koneksi terputus', 'provider_connection_lost', 'unknown');
}
async function errMessage(r) {
  try { const j = await r.json(); return redact((j.error && (j.error.message || j.error)) || j.message || ''); } catch (_) { return ''; }
}
function httpError(status, msg, who, cfg) {
  const m = String(msg || '').slice(0, 160);
  const outcome = status >= 500 && !(cfg && cfg.refundOnProvider5xx) ? 'unknown' : 'rejected';
  if (status === 401 || status === 403) return new HttpError(502, who + ': konfigurasi penyedia bermasalah (periksa kunci di server)', 'provider_auth', outcome);
  if (status === 429) return new HttpError(503, who + ' sedang sibuk, coba lagi sebentar', 'provider_busy', outcome);
  if (status === 400 || status === 404 || status === 422) return new HttpError(502, who + ': penyedia menolak permintaan' + (m ? ' (' + m + ')' : ''), 'provider_bad_request', outcome);
  return new HttpError(502, who + ' gagal' + (m ? ': ' + m : ''), 'provider_error', outcome);
}
// Membaca badan respons 200. Gagal membaca = hasil tidak diketahui (penyedia sudah memproses).
async function readBody(r, who, kind) {
  try { return kind === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer()); }
  catch (_) { throw new HttpError(502, who + ': respons terputus atau tidak dapat dibaca', 'provider_bad_response', 'unknown'); }
}
// Satu permintaan, tanpa percobaan ulang otomatis.
async function send(url, init, who, timeoutMs) {
  try { return await fetch(url, Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, init)); }
  catch (e) { throw fetchError(e, who); }
}
module.exports = { fetchError, errMessage, httpError, readBody, send };
