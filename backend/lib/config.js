'use strict';
// Semua pengaturan dari environment variables. Nilai yang ditulis tetapi rusak (huruf, negatif, di luar rentang)
// membuat server menolak start, bukan diam-diam memakai nilai bawaan atau nilai berbahaya.
const path = require('path');

class ConfigError extends Error {}

function loadConfig(E = process.env) {
  const errs = [];
  const has = n => E[n] !== undefined && E[n] !== '';
  const num = (n, d, { min = -Infinity, max = Infinity, int = false } = {}) => {
    if (!has(n)) return d;
    const v = Number(E[n]);
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) { errs.push(n + '=' + JSON.stringify(E[n]) + ' tidak valid (' + (int ? 'bilangan bulat ' : 'angka ') + min + '..' + max + ')'); return d; }
    return v;
  };
  const bool = (n, d) => { if (!has(n)) return d; const s = String(E[n]).toLowerCase(); if (/^(1|true|yes|on)$/.test(s)) return true; if (/^(0|false|no|off)$/.test(s)) return false; errs.push(n + ' harus true atau false'); return d; };
  const oneOf = (n, d, list) => { if (!has(n)) return d; if (!list.includes(E[n])) { errs.push(n + ' harus salah satu dari: ' + list.join(', ')); return d; } return E[n]; };
  const url = (n, d) => String(E[n] || d).replace(/\/+$/, '');

  const modelStt = E.OPENAI_MODEL_STT || 'gpt-transcribe';
  const cfg = {
    port: num('PORT', 8787, { min: 0, max: 65535, int: true }),
    dataDir: E.DATA_DIR || path.join(__dirname, '..', 'data'),
    trustProxy: bool('TRUST_PROXY', false),
    // Penjaga satu instance pada DATA_DIR (lihat lib/lock.js). Jangan dimatikan di hosting.
    dataLock: bool('DATA_LOCK', true),
    lockStaleMs: num('LOCK_STALE_MS', 15000, { min: 100, max: 600000, int: true }),
    lockWaitMs: num('LOCK_WAIT_MS', 30000, { min: 0, max: 300000, int: true }),

    adminToken: E.ADMIN_TOKEN || '',
    origins: String(E.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    allowAnyOrigin: bool('ALLOW_ANY_ORIGIN', false),

    // Pengaman biaya. Panggilan berbayar MATI sampai PAID_API_ENABLED=true.
    paidEnabled: bool('PAID_API_ENABLED', false),
    // Batas INTERNAL berbasis perkiraan. BUKAN pengganti batas belanja di dashboard OpenAI (lihat docs/BACKEND.md).
    monthlyBudgetUsd: num('MONTHLY_BUDGET_USD', 5, { min: 0, max: 100000 }),
    dailyCallsPerCode: num('DAILY_CALLS_PER_CODE', 600, { min: 1, max: 100000, int: true }),
    ratePerMin: num('RATE_PER_MIN', 90, { min: 1, max: 100000, int: true }),
    ipRatePerMin: num('IP_RATE_PER_MIN', 240, { min: 1, max: 100000, int: true }),
    ipAuthFailPerMin: num('IP_AUTH_FAIL_PER_MIN', 15, { min: 1, max: 100000, int: true }),

    // Batas input
    maxAudioSeconds: num('MAX_AUDIO_SECONDS', 30, { min: 1, max: 120 }),
    maxAudioBytes: num('MAX_AUDIO_BYTES', 3 * 1024 * 1024, { min: 1000, max: 25 * 1024 * 1024, int: true }),
    maxTranslateChars: num('MAX_TRANSLATE_CHARS', 1000, { min: 1, max: 20000, int: true }),
    maxTtsChars: num('MAX_TTS_CHARS', 800, { min: 1, max: 4096, int: true }),
    upstreamTimeoutMs: num('UPSTREAM_TIMEOUT_MS', 20000, { min: 100, max: 120000, int: true }),
    idempotencyTtlMs: num('IDEMPOTENCY_TTL_MS', 10 * 60 * 1000, { min: 1000, max: 24 * 3600 * 1000, int: true }),
    // Transaksi PENDING yatim (bukan milik proses ini) lebih tua dari ini diperiksa ulang oleh penyapu.
    holdTtlMs: num('HOLD_TTL_MS', 2 * 60 * 1000, { min: 1000, max: 24 * 3600 * 1000, int: true }),

    // Kredit. Harus bilangan bulat positif: nilai nol atau negatif akan memberi kredit gratis.
    cost: { stt: num('COST_STT', 2, { min: 1, max: 10000, int: true }), translate: num('COST_TRANSLATE', 1, { min: 1, max: 10000, int: true }), ttsPer100: num('COST_TTS_PER_100', 1, { min: 1, max: 10000, int: true }) },
    maxCreditsPerOp: num('ADMIN_MAX_CREDITS_PER_OP', 1000000, { min: 1, max: 1e9, int: true }),
    maxBalance: num('MAX_BALANCE', 10000000, { min: 1, max: 1e9, int: true }),

    // Perkiraan biaya USD untuk batas internal. Ini PERKIRAAN, cek halaman harga OpenAI.
    usd: {
      sttPerMin: num('USD_STT_PER_MIN', 0.0045, { min: 0, max: 100 }),
      translatePerCall: num('USD_TRANSLATE_PER_CALL', 0.0005, { min: 0, max: 100 }),
      ttsPerMin: num('USD_TTS_PER_MIN', 0.015, { min: 0, max: 100 }),
      ttsCharsPerSec: num('TTS_CHARS_PER_SEC', 14, { min: 1, max: 1000 })
    },
    // true = galat 5xx dari penyedia dianggap pasti gagal dan dikembalikan. Bawaan false: 5xx dianggap UNKNOWN.
    refundOnProvider5xx: bool('REFUND_ON_PROVIDER_5XX', false),

    providers: { stt: (E.STT_PROVIDER || 'openai').toLowerCase(), translate: (E.TRANSLATION_PROVIDER || 'openai').toLowerCase(), tts: (E.TTS_PROVIDER || 'openai').toLowerCase() },
    enableAnthropic: bool('ENABLE_ANTHROPIC', false),
    enableElevenlabs: bool('ENABLE_ELEVENLABS', false),

    openai: {
      key: E.OPENAI_API_KEY || '',
      base: url('OPENAI_BASE', 'https://api.openai.com'),
      modelStt,
      // gpt-transcribe memakai "languages" (array, dikirim sebagai languages[]). Model lama memakai "language". Tidak pernah dikirim keduanya.
      sttLangField: oneOf('OPENAI_STT_LANG_FIELD', /^gpt-transcribe/.test(modelStt) ? 'languages' : 'language', ['languages', 'language']),
      modelTranslate: E.OPENAI_MODEL_TRANSLATE || 'gpt-6-luna',
      translateReasoning: E.OPENAI_TRANSLATE_REASONING === undefined ? 'none' : E.OPENAI_TRANSLATE_REASONING,
      instructionRole: oneOf('OPENAI_INSTRUCTION_ROLE', 'developer', ['developer', 'system']),
      modelTts: E.OPENAI_MODEL_TTS || 'gpt-4o-mini-tts',
      ttsVoice: E.OPENAI_TTS_VOICE || 'marin',
      ttsFormat: oneOf('OPENAI_TTS_FORMAT', 'mp3', ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']),
      // Kirim X-Client-Request-Id = ID transaksi, agar transaksi UNKNOWN dapat dicocokkan dengan log OpenAI.
      clientRequestId: bool('OPENAI_CLIENT_REQUEST_ID', true),
      safetyId: bool('OPENAI_SAFETY_ID', true)
    },
    anthropic: { key: E.ANTHROPIC_API_KEY || '', base: url('ANTHROPIC_BASE', 'https://api.anthropic.com'), model: E.CLAUDE_MODEL || 'claude-haiku-5-5' },
    elevenlabs: { key: E.ELEVENLABS_API_KEY || '', base: url('ELEVEN_BASE', 'https://api.elevenlabs.io'), model: E.ELEVEN_MODEL || 'eleven_flash_v2_5' }
  };
  if (!['stt', 'translate', 'tts'].every(k => /^[a-z]+$/.test(cfg.providers[k]))) errs.push('nama provider tidak valid');
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(cfg.openai.ttsVoice)) errs.push('OPENAI_TTS_VOICE tidak valid');
  if (cfg.openai.translateReasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(cfg.openai.translateReasoning)) errs.push('OPENAI_TRANSLATE_REASONING tidak valid');
  if (errs.length) throw new ConfigError('Konfigurasi tidak valid:\n - ' + errs.join('\n - '));
  return cfg;
}

module.exports = { loadConfig, ConfigError };
