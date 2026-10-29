'use strict';
// Semua pengaturan dibaca dari environment variables. Tidak ada nilai rahasia di sini.
const path = require('path');

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const url = (v, d) => String(v || d).replace(/\/+$/, '');

function loadConfig(E = process.env) {
  return {
    port: num(E.PORT, 8787),
    dataDir: E.DATA_DIR || path.join(__dirname, '..', 'data'),
    trustProxy: bool(E.TRUST_PROXY, false),

    // Akses
    adminToken: E.ADMIN_TOKEN || '',
    origins: String(E.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    allowAnyOrigin: bool(E.ALLOW_ANY_ORIGIN, false), // hanya untuk pengembangan lokal

    // Pengaman biaya. Panggilan berbayar MATI sampai PAID_API_ENABLED=true.
    paidEnabled: bool(E.PAID_API_ENABLED, false),
    monthlyBudgetUsd: num(E.MONTHLY_BUDGET_USD, 5),
    dailyCallsPerCode: num(E.DAILY_CALLS_PER_CODE, 600),
    ratePerMin: num(E.RATE_PER_MIN, 90),
    ipRatePerMin: num(E.IP_RATE_PER_MIN, 240),
    ipAuthFailPerMin: num(E.IP_AUTH_FAIL_PER_MIN, 15),

    // Batas input
    maxAudioSeconds: num(E.MAX_AUDIO_SECONDS, 30),
    maxAudioBytes: num(E.MAX_AUDIO_BYTES, 3 * 1024 * 1024),
    maxTranslateChars: num(E.MAX_TRANSLATE_CHARS, 1000),
    maxTtsChars: num(E.MAX_TTS_CHARS, 800),
    upstreamTimeoutMs: num(E.UPSTREAM_TIMEOUT_MS, 20000),
    idempotencyTtlMs: num(E.IDEMPOTENCY_TTL_MS, 10 * 60 * 1000),
    holdTtlMs: num(E.HOLD_TTL_MS, 2 * 60 * 1000),

    // Biaya dalam kredit (diubah sesuai harga jual)
    cost: { stt: num(E.COST_STT, 2), translate: num(E.COST_TRANSLATE, 1), ttsPer100: num(E.COST_TTS_PER_100, 1) },
    // Perkiraan biaya USD untuk batas anggaran. Ini perkiraan, cek halaman harga OpenAI sebelum menetapkan batas.
    usd: {
      sttPerMin: num(E.USD_STT_PER_MIN, 0.0045),
      translatePerCall: num(E.USD_TRANSLATE_PER_CALL, 0.0005),
      ttsPerMin: num(E.USD_TTS_PER_MIN, 0.015),
      ttsCharsPerSec: num(E.TTS_CHARS_PER_SEC, 14)
    },

    // Provider aktif per fungsi. Hanya OpenAI aktif di V1.
    providers: { stt: (E.STT_PROVIDER || 'openai').toLowerCase(), translate: (E.TRANSLATION_PROVIDER || 'openai').toLowerCase(), tts: (E.TTS_PROVIDER || 'openai').toLowerCase() },
    enableAnthropic: bool(E.ENABLE_ANTHROPIC, false),
    enableElevenlabs: bool(E.ENABLE_ELEVENLABS, false),

    openai: {
      key: E.OPENAI_API_KEY || '',
      base: url(E.OPENAI_BASE, 'https://api.openai.com'),
      modelStt: E.OPENAI_MODEL_STT || 'gpt-transcribe',
      sttLangField: E.OPENAI_STT_LANG_FIELD === 'language' ? 'language' : 'languages',
      modelTranslate: E.OPENAI_MODEL_TRANSLATE || 'gpt-6-luna',
      translateReasoning: E.OPENAI_TRANSLATE_REASONING === undefined ? 'none' : E.OPENAI_TRANSLATE_REASONING,
      modelTts: E.OPENAI_MODEL_TTS || 'gpt-4o-mini-tts',
      ttsVoice: E.OPENAI_TTS_VOICE || 'marin',
      ttsFormat: E.OPENAI_TTS_FORMAT || 'mp3'
    },
    anthropic: { key: E.ANTHROPIC_API_KEY || '', base: url(E.ANTHROPIC_BASE, 'https://api.anthropic.com'), model: E.CLAUDE_MODEL || 'claude-haiku-5-5' },
    elevenlabs: { key: E.ELEVENLABS_API_KEY || '', base: url(E.ELEVEN_BASE, 'https://api.elevenlabs.io'), model: E.ELEVEN_MODEL || 'eleven_flash_v2_5' }
  };
}

module.exports = { loadConfig };
