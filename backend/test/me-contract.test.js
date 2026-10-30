'use strict';
// P1: kontrak /api/me dengan aturan superset. LULUS pada kode sekarang; memungkinkan field `languages` (V1.3) ditambahkan tanpa mematahkan tes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FAKE_OPENAI_KEY } = require('./helpers');
const { checkMe, checkLanguages } = require('./me-contract');

const apps = [];
const boot = async (env) => { const a = await startApp(env); apps.push(a); return a; };
after(async () => { for (const a of apps) await a.close(); });

const LANGS = { languages_schema: 1, languages: [{ code: 'id', label: 'Indonesia', locale: 'id-ID', enabled: true }, { code: 'en', label: 'English', locale: 'en-US', enabled: true }], pairs: [{ home: 'id', peer: 'en', enabled: true }] };

test('kontrak: /api/me nyata memenuhi kolom wajib dan tipe', async () => {
  const a = await boot(); const code = await a.mkCode(10);
  const r = await a.call(code, '/api/me', { method: 'GET' }); const raw = await r.text(); const j = JSON.parse(raw);
  assert.equal(r.status, 200); assert.deepEqual(checkMe(j, raw), []);
  assert.equal(j.credits, 10); assert.ok(!raw.includes(FAKE_OPENAI_KEY) && !raw.includes(code));
});

test('kontrak superset: kolom tambahan (termasuk languages valid) diizinkan, kolom wajib tetap diperiksa', async () => {
  const a = await boot(); const code = await a.mkCode(10); const base = await a.me(code);
  assert.deepEqual(checkMe(Object.assign({}, base, { kolom_baru_masa_depan: { x: 1 } })), []);
  assert.deepEqual(checkMe(Object.assign({}, base, LANGS)), []);
  for (const k of ['credits', 'paid_enabled', 'providers', 'features', 'limits', 'ai_notice', 'held']) { const m = Object.assign({}, base); delete m[k]; assert.notDeepEqual(checkMe(m), [], 'harus gagal tanpa ' + k); }
  assert.notDeepEqual(checkMe(Object.assign({}, base, { credits: '10' })), []);
  assert.notDeepEqual(checkMe(Object.assign({}, base, { features: { voice_clone: { enabled: true } } })), []);
});

test('kontrak: languages opsional tetapi divalidasi bila ada (kode ganda, pasangan tak dikenal, id/en dimatikan, skema salah)', async () => {
  assert.deepEqual(checkLanguages({}), []);
  assert.deepEqual(checkLanguages(LANGS), []);
  const dup = JSON.parse(JSON.stringify(LANGS)); dup.languages.push({ code: 'id', label: 'x', locale: 'id-ID', enabled: true }); assert.notDeepEqual(checkLanguages(dup), []);
  const badPair = JSON.parse(JSON.stringify(LANGS)); badPair.pairs.push({ home: 'id', peer: 'fr', enabled: true }); assert.notDeepEqual(checkLanguages(badPair), []);
  const off = JSON.parse(JSON.stringify(LANGS)); off.languages[1].enabled = false; assert.notDeepEqual(checkLanguages(off), []);
  const noEn = JSON.parse(JSON.stringify(LANGS)); noEn.languages = noEn.languages.slice(0, 1); assert.notDeepEqual(checkLanguages(noEn), []);
  assert.notDeepEqual(checkLanguages({ languages: 'id,en' }), []);
  assert.notDeepEqual(checkLanguages(Object.assign({}, LANGS, { languages_schema: 2 })), []);
});

test('kontrak: pola rahasia pada respons terdeteksi sebagai pelanggaran', async () => {
  const a = await boot(); const code = await a.mkCode(10); const base = await a.me(code);
  assert.notDeepEqual(checkMe(base, JSON.stringify(base) + FAKE_OPENAI_KEY), []);
  assert.notDeepEqual(checkMe(base, JSON.stringify(base) + ' Bearer abc'), []);
});

test('kontrak: tanpa kode akses /api/me tetap 401 (tidak ada bocoran bahasa tanpa autentikasi)', async () => {
  const a = await boot();
  const r = await a.call(null, '/api/me', { method: 'GET' }); const raw = await r.text();
  assert.equal(r.status, 401); assert.ok(!/languages|pairs/.test(raw));
});
