'use strict';
// Tes keamanan: autentikasi, CORS, batas laju, rahasia tidak bocor, provider nonaktif, panggilan berbayar mati secara bawaan.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp, FAKE_OPENAI_KEY, ADMIN, ORIGIN } = require('./helpers');
const { loadConfig } = require('../lib/config');
const { warnings } = require('../server');

const apps = [];
const boot = async (env, seed) => { const a = await startApp(env, seed); apps.push(a); return a; };
after(async () => { for (const a of apps) { assert.deepEqual(a.mock.violations, [], 'permintaan ke OpenAI melanggar kontrak'); await a.close(); } });

test('health publik, tanpa kunci dan tanpa detail provider', async () => {
  const a = await boot();
  const r = await fetch(a.B + '/api/health'); const t = await r.text();
  assert.equal(r.status, 200); assert.ok(JSON.parse(t).ok);
  assert.ok(!t.includes(FAKE_OPENAI_KEY)); assert.ok(!/openai|elevenlabs|anthropic/i.test(t));
});

test('tanpa kode akses atau kode salah = 401, admin token salah = 401', async () => {
  const a = await boot();
  assert.equal((await a.call(null, '/api/me', { method: 'GET' })).status, 401);
  assert.equal((await a.call('VB-SALAH', '/api/me', { method: 'GET' })).status, 401);
  assert.equal((await fetch(a.B + '/admin/codes', { headers: { 'X-Admin-Token': 'salah' } })).status, 401);
  assert.equal((await fetch(a.B + '/admin/codes')).status, 401);
});

test('admin tanpa ADMIN_TOKEN terkonfigurasi selalu ditolak', async () => {
  const a = await boot({ ADMIN_TOKEN: '' });
  assert.equal((await fetch(a.B + '/admin/codes', { headers: { 'X-Admin-Token': '' } })).status, 401);
});

test('kode akses disimpan ber-hash, tidak polos di berkas data', async () => {
  const a = await boot();
  const code = await a.mkCode(10);
  const raw = fs.readFileSync(path.join(a.dir, 'vocalbridge.json'), 'utf8');
  assert.ok(!raw.includes(code));
  assert.ok(code.startsWith('VB-'));
});

test('/api/me menampilkan status tanpa membocorkan kunci', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const r = await a.call(code, '/api/me', { method: 'GET' }); const t = await r.text(); const j = JSON.parse(t);
  assert.equal(j.credits, 10); assert.equal(j.providers.stt.provider, 'openai'); assert.equal(j.paid_enabled, true);
  assert.ok(!t.includes(FAKE_OPENAI_KEY)); assert.ok(j.ai_notice.includes('OpenAI'));
});

test('CORS: origin yang diizinkan lolos, origin lain ditolak 403 termasuk preflight', async () => {
  const a = await boot();
  const ok = await fetch(a.B + '/api/health', { headers: { Origin: ORIGIN } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const pre = await fetch(a.B + '/api/translate', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  const bad = await fetch(a.B + '/api/health', { headers: { Origin: 'https://jahat.example' } });
  assert.equal(bad.status, 403); assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const badPre = await fetch(a.B + '/api/translate', { method: 'OPTIONS', headers: { Origin: 'https://jahat.example' } });
  assert.equal(badPre.status, 403);
});

test('CORS bukan pengganti autentikasi: origin sah tanpa kode tetap 401', async () => {
  const a = await boot();
  const r = await fetch(a.B + '/api/translate', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'abcdefgh1' }, body: JSON.stringify({ text: 'x', src: 'id', tgt: 'en' }) });
  assert.equal(r.status, 401); assert.equal(a.mock.calls.translate, 0);
});

test('ALLOWED_ORIGINS kosong: tidak ada origin browser yang diizinkan', async () => {
  const a = await boot({ ALLOWED_ORIGINS: '' });
  assert.equal((await fetch(a.B + '/api/health', { headers: { Origin: ORIGIN } })).status, 403);
  assert.equal((await fetch(a.B + '/api/health')).status, 200); // tanpa Origin (bukan browser)
});

test('panggilan berbayar MATI secara bawaan dan tidak menghubungi OpenAI', async () => {
  assert.equal(loadConfig({}).paidEnabled, false);
  const a = await boot({ PAID_API_ENABLED: 'false' }); const code = await a.mkCode(10);
  const r = await a.translate(code); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'paid_disabled');
  assert.equal(a.mock.calls.translate, 0); assert.equal(await a.credits(code), 10);
});

test('tombol darurat admin mematikan dan menghidupkan layanan berbayar', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  assert.equal((await a.translate(code)).status, 200);
  assert.equal((await (await a.adminCall('/admin/kill', { enabled: false })).json()).killed, true);
  const r = await a.translate(code); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'paid_disabled');
  assert.equal(a.mock.calls.translate, 1);
  await a.adminCall('/admin/kill', { enabled: true });
  assert.equal((await a.translate(code)).status, 200);
});

test('batas laju per kode: 429 setelah melewati batas', async () => {
  const a = await boot({ RATE_PER_MIN: '5' }); const code = await a.mkCode(10);
  const codes = []; for (let i = 0; i < 7; i++) codes.push((await a.call(code, '/api/me', { method: 'GET' })).status);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]); assert.equal(codes[5], 429);
});

test('percobaan tebak kode dibatasi per IP', async () => {
  const a = await boot({ IP_AUTH_FAIL_PER_MIN: '4' });
  const s = []; for (let i = 0; i < 6; i++) s.push((await a.call('VB-TEBAK' + i, '/api/me', { method: 'GET' })).status);
  assert.deepEqual(s.slice(0, 4), [401, 401, 401, 401]); assert.equal(s[4], 429);
});

test('kode kedaluwarsa dan kode dinonaktifkan ditolak', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const id = a.store.hash(code); a.store.codes[id].expires = new Date(Date.now() - 1000).toISOString();
  assert.equal((await a.call(code, '/api/me', { method: 'GET' })).status, 401);
  const c2 = await a.mkCode(10);
  const r = await a.adm('/admin/disable', { id: a.shortId(c2), disabled: true, request_id: a.rid() }); assert.equal(r.status, 200);
  assert.equal((await a.call(c2, '/api/me', { method: 'GET' })).status, 401);
});

test('provider Anthropic dan ElevenLabs nonaktif walau kunci terisi', async () => {
  const a = await boot({ TRANSLATION_PROVIDER: 'anthropic', TTS_PROVIDER: 'elevenlabs', ANTHROPIC_API_KEY: 'ant-xx-secret-key-1', ELEVENLABS_API_KEY: 'el-xx-secret-key-1' });
  const code = await a.mkCode(20);
  const t = await a.translate(code); assert.equal(t.status, 503); assert.equal((await t.json()).code, 'provider_disabled');
  const s = await a.tts(code); assert.equal(s.status, 503);
  assert.equal(a.mock.calls.translate, 0); assert.equal(a.mock.calls.tts, 0); assert.equal(await a.credits(code), 20);
  assert.equal((await a.call(code, '/api/clone', { json: {} })).status, 503);
});

test('provider tidak dikenal = 503 tanpa berpindah provider diam-diam', async () => {
  const a = await boot({ STT_PROVIDER: 'lainnya' }); const code = await a.mkCode(10);
  const r = await a.stt(code); assert.equal(r.status, 503); assert.equal(a.mock.calls.stt, 0);
});

test('log tidak berisi kunci, kode akses, token admin, teks percakapan, atau audio', async () => {
  const a = await boot(); const code = await a.mkCode(30);
  a.mock.fail.translate = 401; // galat penyedia yang memuat kunci palsu di pesannya
  await a.translate(code, 'rahasia pribadi banget');
  a.mock.fail.translate = null;
  await a.translate(code, 'rahasia pribadi banget');
  await a.stt(code); await a.tts(code, 'kalimat rahasia suara');
  await a.call('VB-TEBAK-SALAH', '/api/me', { method: 'GET' });
  const all = a.logs.join('\n');
  assert.ok(a.logs.length > 4);
  for (const bad of [FAKE_OPENAI_KEY, 'sk-SECRET', code, ADMIN, 'rahasia pribadi', 'halo dunia', 'kalimat rahasia', 'MP3DATA', 'Bearer ']) assert.ok(!all.includes(bad), 'bocor di log: ' + bad);
  assert.ok(JSON.parse(a.logs[0]).p);
});

test('galat penyedia tidak membocorkan kunci ke klien', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  a.mock.fail.translate = 401;
  const r = await a.translate(code); const t = await r.text();
  assert.equal(r.status, 502); assert.ok(!t.includes('sk-')); assert.ok(!t.includes(FAKE_OPENAI_KEY));
});

test('kunci OpenAI hanya dikirim server ke OpenAI, tidak pernah ke klien', async () => {
  const a = await boot(); const code = await a.mkCode(30);
  const r1 = await a.translate(code); const r2 = await a.stt(code); const r3 = await a.tts(code);
  for (const r of [r1, r2, r3]) { assert.equal(r.status, 200); for (const [k, v] of r.headers) assert.ok(!String(v).includes('sk-'), 'header ' + k); }
  assert.ok(a.mock.seen.length === 3 && a.mock.seen.every(s => s.headers.authorization === 'Bearer ' + FAKE_OPENAI_KEY));
});

test('peringatan konfigurasi berbahaya muncul saat start', () => {
  const w = warnings(loadConfig({ PAID_API_ENABLED: 'true', ALLOW_ANY_ORIGIN: 'true' }));
  assert.ok(w.some(x => /ADMIN_TOKEN/.test(x))); assert.ok(w.some(x => /ALLOW_ANY_ORIGIN/.test(x))); assert.ok(w.some(x => /OPENAI_API_KEY/.test(x)));
  const ok = warnings(loadConfig({ ADMIN_TOKEN: 'x'.repeat(30), ALLOWED_ORIGINS: ORIGIN }));
  assert.ok(ok.every(x => /deprecated/.test(x)), ok.join(' | ')); // satu-satunya peringatan: model TTS yang deprecated
});
