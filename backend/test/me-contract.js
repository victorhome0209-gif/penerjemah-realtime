'use strict';
// Kontrak GET /api/me (aturan SUPERSET): kolom wajib dengan tipe tetap harus ada; kolom TAMBAHAN diizinkan (mis. `languages`
// pada V1.3). Bukan deepEqual. `languages` opsional, tetapi bila ada harus valid. Mengembalikan daftar pelanggaran ([] = patuh).
const SECRET_RE = /sk-[A-Za-z0-9_-]{8,}|Bearer\s|VB-[A-Za-z0-9]{4,}/;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function checkLanguages(j) {
  const v = [];
  if (!('languages' in j) && !('pairs' in j) && !('languages_schema' in j)) return v;          // opsional
  if (!Array.isArray(j.languages)) return ['languages bukan array'];
  const seen = new Set();
  for (const l of j.languages) {
    if (!isObj(l) || typeof l.code !== 'string' || !l.code || typeof l.label !== 'string' || typeof l.locale !== 'string' || typeof l.enabled !== 'boolean') { v.push('entri languages tidak valid'); continue; }
    if (seen.has(l.code)) v.push('kode bahasa ganda: ' + l.code); seen.add(l.code);
  }
  for (const c of ['id', 'en']) { const e = j.languages.find(l => l && l.code === c); if (!e || e.enabled !== true) v.push('id dan en harus ada dan enabled'); }
  if (!Array.isArray(j.pairs)) v.push('pairs bukan array');
  else for (const p of j.pairs) { if (!isObj(p) || !seen.has(p.home) || !seen.has(p.peer) || typeof p.enabled !== 'boolean') v.push('pasangan tidak valid'); }
  if (j.languages_schema !== 1) v.push('languages_schema harus 1');
  return v;
}

function checkMe(j, raw) {
  const v = [];
  if (!isObj(j)) return ['respons bukan objek'];
  if (typeof j.name !== 'string') v.push('name');
  for (const k of ['credits', 'held', 'unknown']) if (!isNum(j[k])) v.push(k + ' bukan angka');
  if (!(j.expires === null || typeof j.expires === 'string')) v.push('expires');
  if (typeof j.paid_enabled !== 'boolean') v.push('paid_enabled');
  if (!isObj(j.providers)) v.push('providers'); else for (const k of ['stt', 'translate', 'tts']) if (!isObj(j.providers[k]) || typeof j.providers[k].provider !== 'string') v.push('providers.' + k + '.provider');
  if (!isObj(j.features) || !isObj(j.features.voice_clone) || j.features.voice_clone.enabled !== false) v.push('features.voice_clone.enabled harus false');
  if (!isObj(j.limits)) v.push('limits'); else for (const k of ['max_audio_seconds', 'max_translate_chars', 'max_tts_chars']) if (!isNum(j.limits[k])) v.push('limits.' + k);
  if (typeof j.ai_notice !== 'string' || !j.ai_notice.includes('OpenAI')) v.push('ai_notice');
  if (raw != null && SECRET_RE.test(raw)) v.push('pola rahasia pada respons');
  return v.concat(checkLanguages(j));
}

module.exports = { checkMe, checkLanguages };
