'use strict';
// Provider ElevenLabs (suara). NONAKTIF di V1: baru hidup bila ENABLE_ELEVENLABS=true dan kunci diisi.
// Klon suara belum dipindahkan ke backend baru dan tidak tersedia di V1.
const { HttpError } = require('../util');
const { mapError, readErrMessage } = require('./openai');

class ElevenLabsTTS {
  constructor(cfg) { this.cfg = cfg; this.id = 'elevenlabs'; }
  enabled() { return !!(this.cfg.enableElevenlabs && this.cfg.elevenlabs.key); }
  reason() { return this.cfg.enableElevenlabs ? 'ELEVENLABS_API_KEY belum diisi di server' : 'provider ElevenLabs dinonaktifkan di V1'; }
  validVoice(v) { return /^[A-Za-z0-9]{10,40}$/.test(String(v || '')); }
  async synthesize({ text, voice }) {
    const e = this.cfg.elevenlabs;
    let r;
    try {
      r = await fetch(e.base + '/v1/text-to-speech/' + voice + '?output_format=mp3_44100_128', { method: 'POST', signal: AbortSignal.timeout(this.cfg.upstreamTimeoutMs),
        headers: { 'xi-api-key': e.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: e.model }) });
    } catch (err) { throw new HttpError(err && err.name === 'TimeoutError' ? 504 : 502, 'suara tidak terjangkau', 'provider_unreachable'); }
    if (!r.ok) throw mapError(r.status, await readErrMessage(r), 'suara');
    return { audio: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'audio/mpeg' };
  }
}
module.exports = { ElevenLabsTTS };
