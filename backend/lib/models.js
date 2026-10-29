'use strict';
// Status model OpenAI menurut dokumentasi (diperiksa 29 Okt 2026: halaman Models, Deprecations, referensi API, dan sumber SDK openai-node).
// Dipakai untuk peringatan saat start. Selalu verifikasi ulang sebelum uji nyata.
const MODELS = {
  'gpt-transcribe': { kind: 'stt', status: 'current' },
  'gpt-4o-mini-transcribe': { kind: 'stt', status: 'deprecated', sunset: '2027-02-26', replacement: 'gpt-transcribe' },
  'gpt-4o-transcribe': { kind: 'stt', status: 'deprecated', sunset: '2027-02-26', replacement: 'gpt-transcribe' },
  'whisper-1': { kind: 'stt', status: 'deprecated', sunset: '2027-02-26', replacement: 'gpt-transcribe' },
  'gpt-6-luna': { kind: 'translate', status: 'current' },
  'gpt-6.1-terra': { kind: 'translate', status: 'current' },
  'gpt-4o-mini-tts': { kind: 'tts', status: 'deprecated', sunset: '2027-01-06', replacement: 'gpt-realtime-2.1-mini (Realtime API, bukan /v1/audio/speech)' },
  'gpt-4o-mini-tts-2025-12-15': { kind: 'tts', status: 'deprecated', sunset: '2027-01-06', replacement: 'gpt-realtime-2.1-mini (Realtime API)' },
  'tts-1': { kind: 'tts', status: 'deprecated', sunset: '2027-01-06', replacement: 'gpt-realtime-2.1-mini (Realtime API)' },
  'tts-1-hd': { kind: 'tts', status: 'deprecated', sunset: '2027-01-06', replacement: 'gpt-realtime-2.1-mini (Realtime API)' }
};
function modelWarnings(cfg, now = Date.now()) {
  const w = [];
  for (const [kind, name] of [['stt', cfg.openai.modelStt], ['translate', cfg.openai.modelTranslate], ['tts', cfg.openai.modelTts]]) {
    if (cfg.providers[kind] !== 'openai') continue;
    const m = MODELS[name];
    if (!m) { w.push('model ' + kind + ' "' + name + '" tidak ada dalam daftar terverifikasi; periksa dokumentasi OpenAI'); continue; }
    if (m.kind !== kind) w.push('model "' + name + '" adalah model ' + m.kind + ', bukan ' + kind);
    if (m.status === 'deprecated') {
      const days = Math.ceil((Date.parse(m.sunset) - now) / 86400000);
      w.push('model "' + name + '" deprecated, berhenti ' + m.sunset + (days >= 0 ? ' (' + days + ' hari lagi)' : ' (SUDAH BERHENTI)') + '; pengganti: ' + m.replacement);
    }
  }
  return w;
}
module.exports = { MODELS, modelWarnings };
