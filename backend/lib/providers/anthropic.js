'use strict';
// Provider Anthropic (terjemahan). NONAKTIF di V1: baru hidup bila ENABLE_ANTHROPIC=true dan kunci diisi.
const { HttpError } = require('../util');
const { interpreterPrompt, mapError, readErrMessage } = require('./openai');

class AnthropicTranslation {
  constructor(cfg) { this.cfg = cfg; this.id = 'anthropic'; }
  enabled() { return !!(this.cfg.enableAnthropic && this.cfg.anthropic.key); }
  reason() { return this.cfg.enableAnthropic ? 'ANTHROPIC_API_KEY belum diisi di server' : 'provider Anthropic dinonaktifkan di V1'; }
  async translate({ text, src, tgt, context }) {
    const a = this.cfg.anthropic;
    let r;
    try {
      r = await fetch(a.base + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(this.cfg.upstreamTimeoutMs),
        headers: { 'content-type': 'application/json', 'x-api-key': a.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: a.model, max_tokens: 400, system: interpreterPrompt(src, tgt, context), messages: [{ role: 'user', content: text }] }) });
    } catch (e) { throw new HttpError(e && e.name === 'TimeoutError' ? 504 : 502, 'terjemahan tidak terjangkau', 'provider_unreachable'); }
    if (!r.ok) throw mapError(r.status, await readErrMessage(r), 'terjemahan');
    const j = await r.json();
    return { text: String(j.content[0].text).trim(), engine: 'Claude ' + a.model };
  }
}
module.exports = { AnthropicTranslation };
