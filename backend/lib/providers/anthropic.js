'use strict';
// Provider Anthropic (terjemahan). NONAKTIF di V1: baru hidup bila ENABLE_ANTHROPIC=true dan kunci diisi. Satu permintaan, tanpa percobaan ulang.
const { HttpError } = require('../util');
const { interpreterPrompt } = require('./openai');
const { errMessage, httpError, readBody, send } = require('./common');

class AnthropicTranslation {
  constructor(cfg) { this.cfg = cfg; this.id = 'anthropic'; }
  enabled() { return !!(this.cfg.enableAnthropic && this.cfg.anthropic.key); }
  reason() { return this.cfg.enableAnthropic ? 'ANTHROPIC_API_KEY belum diisi di server' : 'provider Anthropic dinonaktifkan di V1'; }
  async translate({ text, src, tgt, context }) {
    const a = this.cfg.anthropic;
    const r = await send(a.base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': a.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: a.model, max_tokens: 400, system: interpreterPrompt(src, tgt, context), messages: [{ role: 'user', content: text }] }) }, 'terjemahan', this.cfg.upstreamTimeoutMs);
    if (!r.ok) throw httpError(r.status, await errMessage(r), 'terjemahan', this.cfg);
    const j = await readBody(r, 'terjemahan', 'json');
    const out = j && j.content && j.content[0] && j.content[0].text;
    if (typeof out !== 'string') throw new HttpError(502, 'terjemahan: balasan tidak sesuai', 'provider_bad_response', 'unknown');
    return { text: out.trim(), engine: 'Claude ' + a.model, usage: { kind: 'translate' } };
  }
}
module.exports = { AnthropicTranslation };
