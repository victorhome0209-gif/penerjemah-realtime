'use strict';
// Provider OpenAI. Dipanggil hanya dari backend. SATU permintaan HTTP per transaksi: tidak ada percobaan ulang atau
// fallback otomatis (setiap percobaan tambahan adalah pengeluaran yang tidak terkontrol). Penolakan 400 = gagal dan dikembalikan.
//
// Kontrak parameter (diverifikasi 29 Okt 2026 terhadap referensi API dan sumber SDK openai-node):
//  STT   POST /v1/audio/transcriptions  multipart: file, model, languages[] (gpt-transcribe) ATAU language (model lama), tidak pernah keduanya.
//        Array multipart memakai "languages[]" (konvensi SDK, sama seperti timestamp_granularities[]). response_format dihilangkan (bawaan json).
//  Terjemahan POST /v1/chat/completions  JSON: model, messages[developer|system, user], max_completion_tokens, reasoning_effort (opsional),
//        store:false (jangan simpan keluaran), safety_identifier (hash id kode, bukan data pribadi). Tidak mengirim temperature.
//  Suara POST /v1/audio/speech  JSON: model, voice, input, response_format, instructions (hanya model gpt-4o-mini-tts*).
//  Header X-Client-Request-Id = ID transaksi (ASCII, <=512): memungkinkan transaksi UNKNOWN dicocokkan ke log OpenAI.
// Model gpt-4o-mini-tts DEPRECATED, berhenti 2027-01-06; pengganti memakai Realtime API (perlu TTSProvider baru).
const crypto = require('crypto');
const { HttpError } = require('../util');
const { errMessage, httpError, readBody, send } = require('./common');

const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

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
const base = (cfg, ctx) => Object.assign({ Authorization: 'Bearer ' + cfg.openai.key }, cfg.openai.clientRequestId && ctx && ctx.txn ? { 'X-Client-Request-Id': String(ctx.txn) } : {});
const safety = ctx => 'vb-' + crypto.createHash('sha256').update('vb-safety:' + String((ctx && ctx.codeId) || '')).digest('hex').slice(0, 32);
async function check(r, who, cfg) { if (!r.ok) throw httpError(r.status, await errMessage(r), who, cfg); }
const prid = r => r.headers.get('x-request-id') || null;

class OpenAISTT {
  constructor(cfg) { this.cfg = cfg; this.id = 'openai'; }
  enabled() { return !!this.cfg.openai.key; }
  reason() { return 'OPENAI_API_KEY belum diisi di server'; }
  async transcribe({ wav, lang }, ctx) {
    const o = this.cfg.openai, fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'ucapan.wav');
    fd.append('model', o.modelStt);
    if (o.sttLangField === 'languages') fd.append('languages[]', lang); else fd.append('language', lang);
    const r = await send(o.base + '/v1/audio/transcriptions', { method: 'POST', headers: base(this.cfg, ctx), body: fd }, 'pengenal suara', this.cfg.upstreamTimeoutMs);
    await check(r, 'pengenal suara', this.cfg);
    const j = await readBody(r, 'pengenal suara', 'json');
    if (!j || typeof j.text !== 'string') throw new HttpError(502, 'pengenal suara: balasan tidak sesuai', 'provider_bad_response', 'unknown');
    const u = j.usage || {};
    return { text: j.text.trim(), providerRequestId: prid(r), usage: { kind: 'stt', stt_seconds: u.seconds, stt_in_tokens: u.input_tokens, stt_out_tokens: u.output_tokens } };
  }
}

class OpenAITranslation {
  constructor(cfg) { this.cfg = cfg; this.id = 'openai'; }
  enabled() { return !!this.cfg.openai.key; }
  reason() { return 'OPENAI_API_KEY belum diisi di server'; }
  async translate({ text, src, tgt, context }, ctx) {
    const o = this.cfg.openai;
    const body = { model: o.modelTranslate, messages: [{ role: o.instructionRole, content: interpreterPrompt(src, tgt, context) }, { role: 'user', content: text }], max_completion_tokens: 400, store: false };
    if (o.translateReasoning) body.reasoning_effort = o.translateReasoning;
    if (o.safetyId) body.safety_identifier = safety(ctx);
    const r = await send(o.base + '/v1/chat/completions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, base(this.cfg, ctx)), body: JSON.stringify(body) }, 'terjemahan', this.cfg.upstreamTimeoutMs);
    await check(r, 'terjemahan', this.cfg);
    const j = await readBody(r, 'terjemahan', 'json');
    const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof out !== 'string' || !out.trim()) throw new HttpError(502, 'terjemahan: balasan kosong', 'provider_bad_response', 'unknown');
    const u = j.usage || {};
    return { text: out.trim(), engine: 'OpenAI ' + o.modelTranslate, providerRequestId: prid(r), usage: { kind: 'translate', chat_in_tokens: u.prompt_tokens, chat_out_tokens: u.completion_tokens } };
  }
}

class OpenAITTS {
  constructor(cfg) { this.cfg = cfg; this.id = 'openai'; }
  enabled() { return !!this.cfg.openai.key; }
  reason() { return 'OPENAI_API_KEY belum diisi di server'; }
  validVoice(v) { return TTS_VOICES.includes(v); }
  async synthesize({ text, lang, voice }, ctx) {
    const o = this.cfg.openai;
    const body = { model: o.modelTts, voice: this.validVoice(voice) ? voice : o.ttsVoice, input: text, response_format: o.ttsFormat };
    if (/^gpt-4o-mini-tts/.test(o.modelTts)) body.instructions = 'Speak clearly in a natural, friendly, professional tone, at a moderate pace. Language: ' + (lang === 'id' ? 'Indonesian' : 'English') + '.';
    const r = await send(o.base + '/v1/audio/speech', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, base(this.cfg, ctx)), body: JSON.stringify(body) }, 'suara', this.cfg.upstreamTimeoutMs);
    await check(r, 'suara', this.cfg);
    const audio = await readBody(r, 'suara', 'buffer');
    if (!audio.length) throw new HttpError(502, 'suara: audio kosong', 'provider_bad_response', 'unknown');
    const type = o.ttsFormat === 'wav' ? 'audio/wav' : o.ttsFormat === 'opus' ? 'audio/ogg' : o.ttsFormat === 'aac' ? 'audio/aac' : o.ttsFormat === 'flac' ? 'audio/flac' : o.ttsFormat === 'pcm' ? 'audio/L16' : 'audio/mpeg';
    return { audio, contentType: type, providerRequestId: prid(r), usage: { kind: 'tts', tts_chars: text.length } };
  }
}

module.exports = { OpenAISTT, OpenAITranslation, OpenAITTS, interpreterPrompt, TTS_VOICES };
