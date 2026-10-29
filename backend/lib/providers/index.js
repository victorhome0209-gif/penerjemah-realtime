'use strict';
// Kontrak modular. Setiap provider mengimplementasikan salah satu:
//   STTProvider:         { id, enabled(), reason(), transcribe({ wav, lang })            -> { text } }
//   TranslationProvider: { id, enabled(), reason(), translate({ text, src, tgt, context }) -> { text, engine } }
//   TTSProvider:         { id, enabled(), reason(), validVoice(v), synthesize({ text, lang, voice }) -> { audio, contentType } }
// Memilih provider tidak pernah berpindah otomatis: provider yang dipilih mati berarti 503.
const { HttpError } = require('../util');
const { OpenAISTT, OpenAITranslation, OpenAITTS } = require('./openai');
const { AnthropicTranslation } = require('./anthropic');
const { ElevenLabsTTS } = require('./elevenlabs');

function buildProviders(cfg) {
  const reg = {
    stt: { openai: new OpenAISTT(cfg) },
    translate: { openai: new OpenAITranslation(cfg), anthropic: new AnthropicTranslation(cfg) },
    tts: { openai: new OpenAITTS(cfg), elevenlabs: new ElevenLabsTTS(cfg) }
  };
  return {
    reg,
    pick(kind) {
      const p = reg[kind] && reg[kind][cfg.providers[kind]];
      if (!p) throw new HttpError(503, 'provider ' + kind + ' tidak dikenal: ' + cfg.providers[kind], 'provider_unknown');
      if (!p.enabled()) throw new HttpError(503, p.reason(), 'provider_disabled');
      return p;
    },
    status() {
      const o = {};
      for (const kind of Object.keys(reg)) {
        const p = reg[kind][cfg.providers[kind]];
        o[kind] = { provider: cfg.providers[kind], enabled: !!(p && p.enabled()) };
      }
      return o;
    }
  };
}
module.exports = { buildProviders };
