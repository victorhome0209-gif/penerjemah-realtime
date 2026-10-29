'use strict';
// Provider ElevenLabs (suara). NONAKTIF di V1. Klon suara belum dipindahkan ke backend baru dan tidak tersedia.
const { HttpError } = require('../util');
const { errMessage, httpError, readBody, send } = require('./common');

class ElevenLabsTTS {
  constructor(cfg) { this.cfg = cfg; this.id = 'elevenlabs'; }
  enabled() { return !!(this.cfg.enableElevenlabs && this.cfg.elevenlabs.key); }
  reason() { return this.cfg.enableElevenlabs ? 'ELEVENLABS_API_KEY belum diisi di server' : 'provider ElevenLabs dinonaktifkan di V1'; }
  validVoice(v) { return /^[A-Za-z0-9]{10,40}$/.test(String(v || '')); }
  async synthesize({ text, voice }) {
    const e = this.cfg.elevenlabs;
    const r = await send(e.base + '/v1/text-to-speech/' + voice + '?output_format=mp3_44100_128', { method: 'POST', headers: { 'xi-api-key': e.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: e.model }) }, 'suara', this.cfg.upstreamTimeoutMs);
    if (!r.ok) throw httpError(r.status, await errMessage(r), 'suara', this.cfg);
    const audio = await readBody(r, 'suara', 'buffer');
    if (!audio.length) throw new HttpError(502, 'suara: audio kosong', 'provider_bad_response', 'unknown');
    return { audio, contentType: r.headers.get('content-type') || 'audio/mpeg', usage: { kind: 'tts', tts_chars: text.length } };
  }
}
module.exports = { ElevenLabsTTS };
