'use strict';
// Golden test FRONTEND id/en (SIMULASI: halaman asli + backend asli + OpenAI palsu + mikrofon palsu di Chromium).
// Mengunci perilaku frontend yang terlihat pengguna dan kontrak permintaan ke backend sebelum refactor registri bahasa:
//   label dan arah (Mode, Saya/Lawan), bahasa permintaan STT (id/en), JSON terjemahan {text,src,tgt,context}, JSON TTS {text,lang},
//   dan kompatibilitas GET /api/me (bentuk lama, kolom tambahan, kolom opsional hilang, kolom wajib rusak).
// Tes ini harus LULUS pada kode dasar 5329218 (karakterisasi), bukan menguji fitur baru.
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { console.error('Playwright belum terpasang. Jalankan: npm install && npx playwright install chromium'); process.exit(2); }
const { startAll } = require('./servers');

const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log((ok ? 'LULUS ' : 'GAGAL ') + name + (extra !== undefined && !ok ? '  | ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tests = []; const test = (name, fn) => tests.push({ name, fn });
const openContexts = [];

async function newPage(browser, S) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  await ctx.addInitScript(() => { window.__TEST__ = true; window.__gum = 0; const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async c => { window.__gum++; return gum(c); }; });
  openContexts.push(ctx);
  const page = await ctx.newPage();
  page.errors = []; page.calls = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('dialog', d => d.accept());
  page.on('request', r => { if (/\/api\//.test(r.url())) page.calls.push({ url: r.url(), method: r.method(), ct: r.headers()['content-type'] || '', body: r.method() === 'POST' ? r.postData() : null }); });
  await page.goto(S.origin + '/'); await page.waitForSelector('#vbMic');
  return page;
}
async function openSettings(page, S, code) {
  await page.click('#btnSettings'); await page.fill('#vbApi', S.B); await page.fill('#vbCode', code); await page.click('#vbSave');
}
async function connect(page, S, code) {
  await openSettings(page, S, code);
  await page.waitForFunction(() => /Terhubung/.test(document.getElementById('vbConnInfo').textContent), null, { timeout: 8000 });
  await page.click('#btnClose');
}
async function startSession(page) {
  await page.click('#vbMic'); await page.waitForSelector('#vbConsent.open'); await page.click('#vbConsentOk');
  await page.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 8000 });
}
const txt = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
async function waitCard(page, side, ms = 30000) {
  await page.waitForFunction(s => { const p = document.querySelector('article.vb-turn.' + s + ' [data-k="tr"]'); return p && !p.classList.contains('dim'); }, side, { timeout: ms });
}
const bodies = (page, re) => page.calls.filter(c => re.test(c.url)).map(c => ({ url: c.url, ct: c.ct, json: (() => { try { return JSON.parse(c.body); } catch (_) { return null; } })() }));

// ---------------------------------------------------------------------------------------------
test('GOLDEN-F01: label, arah, dan bahasa pada layar (id/en)', async (b, S) => {
  const code = await S.api.mkCode(100);
  const p = await newPage(b, S); await connect(p, S, code); await startSession(p);
  check('F01: mode awal = English → Indonesia, tombol "Saya Bicara"', (await txt(p, '#vbMode')) === 'Mode: English → Indonesia' && (await txt(p, '#vbMicLabel')) === 'Saya Bicara', await txt(p, '#vbMode'));
  await waitCard(p, 'them');
  const them = await p.evaluate(() => { const a = document.querySelector('article.vb-turn.them'); return { who: a.querySelector('.vb-turn-head b').textContent, dir: a.querySelector('.vb-dir').textContent, boxes: [...a.querySelectorAll('.vb-box small')].map(x => x.textContent), orig: a.querySelector('[data-k="orig"]').textContent, tr: a.querySelector('[data-k="tr"]').textContent }; });
  check('F01: kartu lawan: label "Lawan bicara", arah English → Indonesia', them.who === 'Lawan bicara' && them.dir === 'English → Indonesia', JSON.stringify(them));
  check('F01: kartu lawan: kotak "Teks asli · English" dan "Terjemahan · Indonesia"', them.boxes[0] === 'Teks asli · English' && them.boxes[1] === 'Terjemahan · Indonesia', JSON.stringify(them.boxes));
  check('F01: kartu lawan: isi teks asli English dan terjemahan Indonesia', them.orig === 'Could you explain the proposal?' && them.tr === 'Bisakah Anda menjelaskan proposal tersebut?', JSON.stringify(them));
  await p.click('#vbMic');
  check('F01: Saya Bicara: mode Indonesia → English, tombol "Selesai Bicara"', (await txt(p, '#vbMode')) === 'Mode: Indonesia → English' && (await txt(p, '#vbMicLabel')) === 'Selesai Bicara', await txt(p, '#vbMode'));
  await p.evaluate(() => { const x = new Float32Array(48000 * 1.5); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000); window.__t.onMeSpeech(x, 48000, window.__t.analyzeFrames([x], 48000)); });
  await waitCard(p, 'me');
  const me = await p.evaluate(() => { const a = document.querySelector('article.vb-turn.me'); return { who: a.querySelector('.vb-turn-head b').textContent, dir: a.querySelector('.vb-dir').textContent, boxes: [...a.querySelectorAll('.vb-box small')].map(x => x.textContent), orig: a.querySelector('[data-k="orig"]').textContent, tr: a.querySelector('[data-k="tr"]').textContent }; });
  check('F01: kartu saya: label "Saya", arah Indonesia → English', me.who === 'Saya' && me.dir === 'Indonesia → English', JSON.stringify(me));
  check('F01: kartu saya: kotak "Teks asli · Indonesia" dan "Terjemahan · English"', me.boxes[0] === 'Teks asli · Indonesia' && me.boxes[1] === 'Terjemahan · English', JSON.stringify(me.boxes));
  check('F01: kartu saya: isi teks asli Indonesia dan terjemahan English', me.orig === 'Saya akan menjelaskan rencananya.' && me.tr === 'I will explain the plan.', JSON.stringify(me));
  check('F01: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('GOLDEN-F02: bahasa dan bentuk permintaan STT, terjemahan, TTS', async (b, S) => {
  const code = await S.api.mkCode(100);
  const p = await newPage(b, S); await connect(p, S, code);
  await p.evaluate(() => { document.getElementById('mode').value = 'headset'; document.getElementById('mode').dispatchEvent(new Event('change')); });
  await startSession(p); await waitCard(p, 'them'); await p.waitForFunction(() => !document.querySelector('article.vb-turn.them .vb-chip').textContent, null, { timeout: 15000 }).catch(() => {});
  await p.waitForFunction(() => window.__t.Conv.state === 'listen', null, { timeout: 15000 });
  await p.click('#vbMic');
  await p.evaluate(() => { const x = new Float32Array(48000 * 1.5); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000); window.__t.onMeSpeech(x, 48000, window.__t.analyzeFrames([x], 48000)); });
  await waitCard(p, 'me'); await p.waitForFunction(() => window.__t.Conv.state === 'listen', null, { timeout: 15000 });
  const stt = p.calls.filter(c => /\/api\/stt/.test(c.url));
  check('F02: STT lawan memakai ?lang=en, tipe audio/wav', stt.some(c => /[?&]lang=en(&|$)/.test(c.url) && c.ct === 'audio/wav'), JSON.stringify(stt.map(c => c.url + ' ' + c.ct)));
  check('F02: STT saya memakai ?lang=id, tipe audio/wav', stt.some(c => /[?&]lang=id(&|$)/.test(c.url) && c.ct === 'audio/wav'), JSON.stringify(stt.map(c => c.url)));
  const tr = bodies(p, /\/api\/translate/);
  const trThem = tr.find(x => x.json && x.json.src === 'en'), trMe = tr.find(x => x.json && x.json.src === 'id');
  check('F02: terjemahan lawan: kunci tepat {text,src,tgt,context}, en → id', !!trThem && JSON.stringify(Object.keys(trThem.json).sort()) === '["context","src","text","tgt"]' && trThem.json.tgt === 'id' && trThem.json.text === 'Could you explain the proposal?', JSON.stringify(trThem));
  check('F02: terjemahan lawan: context pertama = []', !!trThem && Array.isArray(trThem.json.context) && trThem.json.context.length === 0, JSON.stringify(trThem && trThem.json));
  check('F02: terjemahan saya: id → en, teks Indonesia', !!trMe && trMe.json.tgt === 'en' && trMe.json.text === 'Saya akan menjelaskan rencananya.', JSON.stringify(trMe));
  check('F02: terjemahan saya: context memuat giliran lawan {side,text(asli)}', !!trMe && JSON.stringify(trMe.json.context) === '[{"side":"them","text":"Could you explain the proposal?"}]', JSON.stringify(trMe && trMe.json.context));
  check('F02: Content-Type terjemahan application/json', tr.every(x => /^application\/json/.test(x.ct)), JSON.stringify(tr.map(x => x.ct)));
  const tts = bodies(p, /\/api\/tts/);
  check('F02: TTS lawan {text,lang:"id"} tepat dua kunci', tts.some(x => x.json && x.json.lang === 'id' && x.json.text === 'Bisakah Anda menjelaskan proposal tersebut?' && Object.keys(x.json).length === 2), JSON.stringify(tts.map(x => x.json)));
  check('F02: TTS saya {text,lang:"en"} tepat dua kunci', tts.some(x => x.json && x.json.lang === 'en' && x.json.text === 'I will explain the plan.' && Object.keys(x.json).length === 2), JSON.stringify(tts.map(x => x.json)));
  check('F02: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

// ---- kompatibilitas GET /api/me ----
async function withMe(b, S, mutate, after) {
  const code = await S.api.mkCode(77);
  const p = await newPage(b, S);
  await p.route('**/api/me', async route => { const r = await route.fetch(); let j = await r.json(); const out = mutate(j); await route.fulfill({ response: r, body: typeof out === 'string' ? out : JSON.stringify(out), contentType: 'application/json' }); });
  await openSettings(p, S, code);
  await p.waitForFunction(() => document.getElementById('vbConnInfo').textContent !== 'Memeriksa…', null, { timeout: 8000 });
  const info = await txt(p, '#vbConnInfo');
  await after(p, info, code);
}

test('GOLDEN-F03: /api/me: bentuk saat ini (tanpa languages) tetap dibaca', async (b, S) => {
  await withMe(b, S, j => j, async (p, info) => {
    check('F03: "Terhubung. Sisa kredit: 77"', /^Terhubung\. Sisa kredit: 77\b/.test(info), info);
    check('F03: penyedia STT/terjemahan/suara tampil', /Pengenal suara: \S+, terjemahan: \S+, suara: \S+\./.test(info), info);
    check('F03: lencana kredit "Uji · 77 kredit"', (await txt(p, '#planBadge')) === 'Uji · 77 kredit', await txt(p, '#planBadge'));
    check('F03: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  });
});

test('GOLDEN-F04: /api/me: kolom TAMBAHAN (languages, pairs, schema, kolom tak dikenal) diabaikan, perilaku sama', async (b, S) => {
  const extra = j => Object.assign({}, j, { languages_schema: 1, languages: [{ code: 'id', label: 'Indonesia', locale: 'id-ID', enabled: true }, { code: 'en', label: 'English', locale: 'en-US', enabled: true }, { code: 'ja', label: '日本語', locale: 'ja-JP', enabled: false }], pairs: [{ home: 'id', peer: 'en', enabled: true }], kolom_masa_depan: { x: [1, 2, 3] } });
  await withMe(b, S, extra, async (p, info, code) => {
    check('F04: tetap "Terhubung. Sisa kredit: 77"', /^Terhubung\. Sisa kredit: 77\b/.test(info), info);
    check('F04: lencana kredit sama', (await txt(p, '#planBadge')) === 'Uji · 77 kredit');
    await p.click('#btnClose'); await startSession(p);
    check('F04: mode tetap English → Indonesia (daftar bahasa tambahan tidak mengubah id/en)', (await txt(p, '#vbMode')) === 'Mode: English → Indonesia', await txt(p, '#vbMode'));
    check('F04: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  });
});

test('GOLDEN-F05: /api/me: kolom opsional hilang (held) dan nilai held > 0', async (b, S) => {
  await withMe(b, S, j => { const o = Object.assign({}, j); delete o.held; return o; }, async (p, info) => {
    check('F05: tanpa held: tetap terhubung, tanpa kata "ditahan"', /^Terhubung\./.test(info) && !/ditahan/.test(info), info);
    check('F05: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  });
  await withMe(b, S, j => Object.assign({}, j, { held: 5 }), async (p, info) => {
    check('F05: held=5: "(ditahan 5, menunggu pemeriksaan administrator)"', /ditahan 5, menunggu pemeriksaan administrator/.test(info), info);
  });
});

test('GOLDEN-F06: /api/me: paid_enabled=false memblokir sesi sebelum mikrofon dipakai', async (b, S) => {
  await withMe(b, S, j => Object.assign({}, j, { paid_enabled: false }), async (p, info) => {
    check('F06: info tetap menjelaskan "dinonaktifkan administrator"', /Layanan berbayar: dinonaktifkan administrator/.test(info), info);
    await p.click('#btnClose'); await p.click('#vbMic');
    await sleep(1500);
    check('F06: sesi tidak dimulai, mikrofon tidak diminta', (await p.evaluate(() => window.__gum)) === 0 && (await p.evaluate(() => document.getElementById('vbStatus').dataset.s)) === 'idle');
    check('F06: alasan tampil ke pengguna', /dinonaktifkan oleh administrator/.test(await txt(p, '#live') || '') || /dinonaktifkan oleh administrator/.test(await p.evaluate(() => document.body.innerText)), await txt(p, '#live'));
  });
});

test('GOLDEN-F07: /api/me: kolom WAJIB rusak atau respons bukan JSON tidak membuat halaman jatuh dan tidak mengklaim berhasil', async (b, S) => {
  await withMe(b, S, j => { const o = Object.assign({}, j); delete o.providers; return o; }, async (p, info) => {
    check('F07: providers hilang: tidak ada klaim "Terhubung. Sisa kredit" yang lengkap; ada pesan gagal', /^Gagal:/.test(info), info);
    check('F07: providers hilang: tanpa galat JS tak tertangkap', p.errors.length === 0, p.errors.join('|'));
  });
  await withMe(b, S, () => '{bukan json', async (p, info) => {
    check('F07: bukan JSON: pesan gagal, tanpa klaim terhubung', /^Gagal:/.test(info), info);
    check('F07: bukan JSON: tanpa galat JS tak tertangkap', p.errors.length === 0, p.errors.join('|'));
  });
  await withMe(b, S, j => Object.assign({}, j, { credits: 'banyak' }), async (p, info) => {
    check('F07: credits bukan angka: halaman tidak jatuh', p.errors.length === 0, p.errors.join('|') + ' / ' + info);
  });
});

(async () => {
  const S = await startAll({ credits: 100 });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + S.wav, '--autoplay-policy=no-user-gesture-required'] });
  const only = process.argv[2];
  for (const t of tests) {
    if (only && !t.name.toLowerCase().includes(only.toLowerCase())) continue;
    console.log('\n## ' + t.name);
    try { await t.fn(browser, S); } catch (e) { check('TES BERHENTI: ' + t.name, false, (e && e.stack || e).toString().split('\n').slice(0, 3).join(' / ')); }
    finally { while (openContexts.length) { try { await openContexts.pop().close(); } catch (_) {} } }
  }
  await browser.close(); await S.close();
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' lulus' + (bad.length ? ', GAGAL: ' + bad.map(r => r.name).join(' ; ') : ''));
  process.exit(bad.length ? 1 : 0);
})();
