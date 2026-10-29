'use strict';
// V1.2 verifikasi akhir: galat kuota/biaya OpenAI gagal aman (tanpa kebocoran kunci, tanpa potong kredit ganda),
// kontrak parameter terhadap spesifikasi endpoint, dan urutan smoke test (5 panggilan, 7 kredit).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeWav, FAKE_OPENAI_KEY, ADMIN } = require('./helpers');

const apps = [];
const boot = async (env, seed) => { const a = await startApp(env, seed); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, [], 'permintaan ke OpenAI melanggar kontrak dokumentasi'); assert.deepEqual(a.audit(), [], 'audit konsistensi saldo'); await a.close(); } });

const CALL = {
  stt: (a, code, o) => a.stt(code, o),
  translate: (a, code, o) => a.translate(code, 'Selamat pagi', o),
  tts: (a, code, o) => a.tts(code, 'Hello there', o)
};
const COST = { stt: 2, translate: 1, tts: 1 };
const noLeak = (a, ...parts) => {
  const all = parts.join('\n') + '\n' + a.logs.join('\n');
  for (const bad of [FAKE_OPENAI_KEY, 'sk-SECRET', ADMIN, 'Bearer sk-']) assert.ok(!all.includes(bad), 'bocor: ' + bad);
};

for (const [status, errCode, label] of [[429, 'project_spend_limit_exceeded', 'project_spend_limit_exceeded'], [429, 'insufficient_quota', 'insufficient_quota'],
  [429, 'organization_spend_limit_exceeded', 'organization_spend_limit_exceeded'], [429, 'credit_balance_exhausted', 'credit_balance_exhausted']]) {
  test('kuota OpenAI ' + label + ': gagal aman di STT, terjemahan, dan suara; kredit kembali; satu panggilan; tanpa kebocoran kunci', async () => {
    for (const kind of ['stt', 'translate', 'tts']) {
      const a = await boot(); const code = await a.mkCode(20);
      a.mock.fail[kind] = status; a.mock.failCode[kind] = errCode;
      const key = a.key(), r = await CALL[kind](a, code, { key }), txt = await r.text(), j = JSON.parse(txt);
      assert.equal(r.status, 503, kind); assert.equal(j.code, 'provider_quota', kind);
      assert.match(j.error, /batas biaya atau kuota OpenAI tercapai/); noLeak(a, txt);
      assert.equal(await a.credits(code), 20, kind + ': kredit kembali penuh'); assert.equal(a.mock.calls[kind], 1, kind + ': tepat satu panggilan, tanpa percobaan ulang');
      // mengulang dengan kunci idempotensi yang sama setelah penolakan pasti: boleh, tetapi tidak memotong dua kali
      a.mock.fail[kind] = null; a.mock.failCode[kind] = null;
      const r2 = await CALL[kind](a, code, { key }); assert.equal(r2.status, 200, kind + ': ulangi setelah pulih');
      assert.equal(await a.credits(code), 20 - COST[kind], kind + ': dipotong tepat sekali');
    }
  });
}

test('kuota OpenAI: jenis galat insufficient_quota tanpa kode khusus tetap dikenali; 429 biasa tetap "sibuk"', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  a.mock.fail.translate = 429; a.mock.failCode.translate = 'kode_lain'; // mock memberi type=insufficient_quota
  assert.equal((await (await a.translate(code)).json()).code, 'provider_quota');
  a.mock.failCode.translate = null; // 429 tanpa code/type kuota
  assert.equal((await (await a.translate(code)).json()).code, 'provider_busy');
  assert.equal(await a.credits(code), 10);
});

test('provider_bad_request (400): gagal aman, kredit kembali, kunci tidak bocor, tidak diulang', async () => {
  for (const kind of ['stt', 'translate', 'tts']) {
    const a = await boot(); const code = await a.mkCode(20); a.mock.fail[kind] = 400;
    const r = await CALL[kind](a, code), txt = await r.text(), j = JSON.parse(txt);
    assert.equal(r.status, 502, kind); assert.equal(j.code, 'provider_bad_request', kind); noLeak(a, txt);
    assert.equal(await a.credits(code), 20, kind); assert.equal(a.mock.calls[kind], 1, kind);
  }
});

test('kunci ditolak (401/403): provider_auth, kredit kembali, kunci tidak bocor', async () => {
  for (const st of [401, 403]) {
    const a = await boot(); const code = await a.mkCode(20); a.mock.fail.translate = st;
    const r = await a.translate(code), txt = await r.text();
    assert.equal(r.status, 502); assert.equal(JSON.parse(txt).code, 'provider_auth'); noLeak(a, txt); assert.equal(await a.credits(code), 20);
  }
});

test('galat 5xx: status BELUM PASTI, kredit ditahan (bukan dipotong ganda, bukan dikembalikan otomatis), kunci terkunci', async () => {
  const a = await boot(); const code = await a.mkCode(20); a.mock.fail.translate = 500;
  const key = a.key(), r = await a.translate(code, 'Selamat pagi', { key }), txt = await r.text();
  assert.equal(JSON.parse(txt).code, 'provider_unknown'); noLeak(a, txt);
  const me = await a.me(code); assert.equal(me.credits + me.held, 20, 'saldo + ditahan tetap 20'); assert.equal(me.held, 1);
  a.mock.fail.translate = null;
  const r2 = await a.translate(code, 'Selamat pagi', { key }); assert.equal(r2.status, 409, 'kunci yang sama ditolak sampai admin memeriksa');
  assert.equal(a.mock.calls.translate, 1, 'tidak ada panggilan ulang'); assert.equal((await a.me(code)).held, 1);
});

test('kontrak parameter: permintaan nyata ke OpenAI memuat tepat kolom yang didokumentasikan', async () => {
  const a = await boot(); const code = await a.mkCode(20);
  await a.stt(code); await a.translate(code); await a.tts(code);
  const stt = a.mock.seen.find(s => s.kind === 'stt'), tr = a.mock.seen.find(s => s.kind === 'translate'), tts = a.mock.seen.find(s => s.kind === 'tts');
  assert.equal(stt.url, '/v1/audio/transcriptions');
  const names = [...stt.body.toString('latin1').matchAll(/[; ]name="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(names, ['file', 'languages[]', 'model'], 'STT: model, file, languages[] (tanpa language)');
  assert.match(stt.body.toString('latin1'), /name="model"\r\n\r\ngpt-transcribe\r\n/);
  assert.equal(tr.url, '/v1/chat/completions');
  const tj = JSON.parse(tr.body.toString());
  assert.deepEqual(Object.keys(tj).sort(), ['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'safety_identifier', 'store'], 'chat: tanpa temperature/max_tokens');
  assert.equal(tj.model, 'gpt-6-luna'); assert.equal(tj.reasoning_effort, 'none'); assert.equal(tj.store, false); assert.equal(tj.messages[0].role, 'developer'); assert.equal(tj.messages[1].role, 'user');
  assert.match(tj.safety_identifier, /^vb-[0-9a-f]{32}$/); assert.ok(!tj.safety_identifier.includes(code), 'kode akses tidak dikirim sebagai pengenal');
  assert.equal(tts.url, '/v1/audio/speech');
  const sj = JSON.parse(tts.body.toString());
  assert.deepEqual(Object.keys(sj).sort(), ['input', 'instructions', 'model', 'response_format', 'voice']);
  assert.equal(sj.model, 'gpt-4o-mini-tts'); assert.equal(sj.voice, 'marin');
  for (const s of [stt, tr, tts]) { assert.match(s.headers['x-client-request-id'], /^[\x20-\x7e]{1,512}$/); assert.match(s.headers.authorization, /^Bearer sk-/); }
});

test('smoke test minimal: satu putaran dua arah = 5 panggilan, 7 kredit, perkiraan internal < US$0,01', async () => {
  const a = await boot({ MONTHLY_BUDGET_USD: '0.05', DAILY_CALLS_PER_CODE: '10', RATE_PER_MIN: '10' });
  const code = await a.mkCode(10, { daily_calls: 10, expires_days: 1 });
  const st = [(await a.call(code, '/api/stt?lang=id', { wav: makeWav(3) })).status, (await a.translate(code, 'Halo, nama saya Budi.')).status, (await a.tts(code, 'Hello, my name is Budi.')).status,
    (await a.call(code, '/api/stt?lang=en', { wav: makeWav(3) })).status, (await a.call(code, '/api/translate', { json: { text: 'Could you send the files by Friday?', src: 'en', tgt: 'id' } })).status];
  assert.deepEqual(st, [200, 200, 200, 200, 200]);
  assert.deepEqual(a.mock.calls, { stt: 2, translate: 2, tts: 1 }); assert.equal(await a.credits(code), 3, '10 - 7 = 3');
  const u = (await a.adm('/admin/usage')).json;
  assert.ok(u.estimate.spentUsd > 0 && u.estimate.spentUsd < 0.01, 'perkiraan internal ' + u.estimate.spentUsd); assert.equal(u.transactions.UNKNOWN, 0);
});

test('PAID_API_ENABLED=false: tidak ada satu pun panggilan ke OpenAI untuk semua jenis permintaan', async () => {
  const a = await boot({ PAID_API_ENABLED: 'false' }); const code = await a.mkCode(20);
  for (const kind of ['stt', 'translate', 'tts']) { const r = await CALL[kind](a, code); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'paid_disabled'); }
  assert.deepEqual(a.mock.calls, { stt: 0, translate: 0, tts: 0 }); assert.equal(await a.credits(code), 20);
});
