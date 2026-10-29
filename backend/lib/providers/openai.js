'use strict';
// Provider OpenAI: pengenal suara, terjemahan, suara. Dipanggil hanya dari backend.
// Model dan endpoint diperiksa terhadap dokumentasi OpenAI pada 29 Okt 2026:
//  - STT: gpt-transcribe (model lama gpt-4o-mini-transcribe deprecated, berhenti 26 Feb 2027)
//  - Terjemahan: gpt-6-luna lewat /v1/chat/completions
//  - Suara: gpt-4o-mini-tts lewat /v1/audio/speech (deprecated, berhenti 6 Jan 2027; pengganti
//    resmi memakai Realtime API sehingga perlu TTSProvider baru sebelum tanggal itu)
const { HttpError, redact } = require('../util');

const TTS_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

async function readErrMessage(r) {
  try { const j = await r.json(); return redact((j.error && (j.error.message || j.error)) || j.message || ''); } catch (_) { return ''; }
}
// Ubah galat penyedia menjadi galat HTTP kita tanpa membocorkan detail konfigurasi.
function mapError(status, msg, who) {
  const m = String(msg || '').slice(0, 160);
  if (status === 401 || status === 403) return new HttpError(502, who + ': konfigurasi penyedia bermasalah (periksa kunci di server)', 'provider_auth');
  if (status === 429) return new HttpError(503, who + ' sedang sibuk, coba lagi sebentar', 'provider_busy');
  return new HttpError(502, who + ' gagal' + (m ? ': ' + m : ''), 'provider_error');
}
async function send(cfg, path, init, who) {
  try {
    return await fetch(cfg.openai.base + path, Object.assign({ signal: AbortSignal.timeout(cfg.upstreamTimeoutMs) }, init));
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new HttpError(504, who + ' tidak menjawab tepat waktu', 'provider_timeout');
    throw new HttpError(502, who + ' tidak terjangkau', 'provider_unreachable');
  }
}
const auth = cfg => ({ Authorization: 'Bearer ' + cfg.openai.key });

function interpreterPrompt(src, tgt, context) {
  const from = src === 'id' ? 'Indonesian' : 'English', to = tgt === 'id' ? 'Indonesian' : 'English';
  const ctx = (Array.isArray(context) ? context : []).slice(-4)
    .map(h => (h && h.side === 'me' ? 'Freelancer: ' : 'Client: ') + String((h && h.text) || '').slice(0, 300)).join('\n');
  return 'You are a live interpreter between a freelancer (Indonesian) and an overseas client (English). ' +
    'Translate the speaker\'s utterance from ' + from + ' to ' + to + '. ' +
    'The text comes from speech recognition, so quietly fix obvious recognition slips using context. ' +
    'Keep the tone natural and conversational, keep proper names (people, places, products) unchanged. ' +
    'Output ONLY the translation. Never answer questions, never add notes or quotes.' +
    (ctx ? '\n\nRecent conversation (context only, do NOT translate):\n' + ctx : '');
}

class OpenAISTT {
  constructor(cfg) { this.cfg = cfg; this.id = 'openai'; this.langField = cfg.openai.sttLangField; }
  enabled() { return !!this.cfg.openai.key; }
  reason() { return 'OPENAI_API_KEY belum diisi di server'; }
  async transcribe({ wav, lang }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fd = new FormData();
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'ucapan.wav');
      fd.append('model', this.cfg.openai.modelStt);
      if (this.langField === 'languages') fd.append('languages[]', lang); else fd.append('language', lang);
      fd.append('response_format', 'json');
      const r = await send(this.cfg, '/v1/audio/transcriptions', { method: 'POST', headers: auth(this.cfg), body: fd }, 'pengenal suara');
      if (r.ok) { const j = await r.json(); return { text: String(j.text || '').trim() }; }
      const msg = await readErrMessage(r);
      // Penyedia menolak nama kolom bahasa: coba bentuk satunya sekali (permintaan 400 tidak ditagih).
      if (r.status === 400 && attempt === 0 && /language/i.test(msg)) { this.langField = this.langField === 'languages' ? 'language' : 'languages'; continue; }
      throw mapError(r.status, msg, 'pengenal suara');
    }
  }
}

class OpenAITranslation {
  constructor(cfg) { this.cfg = cfg; this.id = 'openai'; }
  enabled() { return !!this.cfg.openai.key; }
  reason() { return 'OPENAI_API_KEY belum diisi di server'; }
  async translate({ text, src, tgt, context }) {
    const o = this.cfg.openai;
    const base = { model: o.modelTranslate, messages: [{ role: 'system', content: interpreterPrompt(src, tgt, context) }, { role: 'user', content: text }] };
    // Urutan percobaan: parameter lengkap, tanpa reasoning_effort, lalu max_tokens lama. Hanya lanjut bila 400.
    const tries = [
      Object.assign({}, base, o.translateReasoning ? { reasoning_effort: o.translateReasoning } : {}, { max_completion_tokens: 400 }),
      Object.assign({}, base, { max_completion_tokens: 400 }),
      Object.assign({}, base, { max_tokens: 400 })
    ];
    let last = null;
    for (const body of tries) {
      const r = await send(this.cfg, '/v1/chat/completions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth(this.cfg)), body: JSON.stringify(body) }, 'terjemahan');
      if (r.ok) {
        const j = await r.json(); const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!out) throw new HttpError(502, 'terjemahan: balasan kosong', 'provider_error');
        return { text: String(out).trim(), engine: 'OpenAI ' + o.modelTranslate };
      }
      const msg = await readErrMessage(r); last = mapError(r.status, msg, 'terjemahan');
      if (r.status !== 400) throw last;
    }
    throw last;
  }
}

class OpenAITTS {
  constructor(cfg) { this.cfg = cfg; this.id = 'openai'; }
  enabled() { return !!this.cfg.openai.key; }
  reason() { return 'OPENAI_API_KEY belum diisi di server'; }
  validVoice(v) { return TTS_VOICES.includes(v); }
  async synthesize({ text, lang, voice }) {
    const o = this.cfg.openai;
    const body = { model: o.modelTts, voice: this.validVoice(voice) ? voice : o.ttsVoice, input: text, response_format: o.ttsFormat,
      instructions: 'Speak clearly in a natural, friendly, professional tone, at a moderate pace. Language: ' + (lang === 'id' ? 'Indonesian' : 'English') + '.' };
    const r = await send(this.cfg, '/v1/audio/speech', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth(this.cfg)), body: JSON.stringify(body) }, 'suara');
    if (!r.ok) throw mapError(r.status, await readErrMessage(r), 'suara');
    const type = o.ttsFormat === 'wav' ? 'audio/wav' : o.ttsFormat === 'opus' ? 'audio/ogg' : 'audio/mpeg';
    return { audio: Buffer.from(await r.arrayBuffer()), contentType: type };
  }
}

module.exports = { OpenAISTT, OpenAITranslation, OpenAITTS, interpreterPrompt, mapError, readErrMessage, TTS_VOICES };
