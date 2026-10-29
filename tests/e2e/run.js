'use strict';
// Tes browser (SIMULASI): halaman asli + backend asli + OpenAI palsu + mikrofon palsu di Chromium.
// Bukan tes nyata: tidak ada suara manusia, kunci OpenAI, HP, atau Meet/Zoom sungguhan.
const { chromium, devices } = require('playwright');
const { startAll } = require('./servers');

const results = [];
const openContexts = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log((ok ? 'LULUS ' : 'GAGAL ') + name + (extra !== undefined && !ok ? '  | ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser, S, { mobile = false, init } = {}) {
  const base = mobile ? devices['Pixel 7'] : { viewport: { width: 1280, height: 860 } };
  const ctx = await browser.newContext(Object.assign({}, base, { permissions: ['microphone', 'clipboard-read', 'clipboard-write'], acceptDownloads: true }));
  await ctx.addInitScript(() => {
    window.__TEST__ = true; window.__streams = []; window.__plays = 0; window.__gum = 0;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async c => { window.__gum++; const s = await gum(c); window.__streams.push(s); return s; };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__plays++; return play.apply(this, arguments); };
  });
  openContexts.push(ctx);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = []; page.reqs = []; page.resps = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('dialog', d => d.accept());
  page.on('request', r => page.reqs.push({ url: r.url(), method: r.method(), h: r.headers() }));
  page.on('response', r => page.resps.push({ url: r.url(), status: r.status(), h: r.headers() }));
  await page.goto(S.origin + '/'); await page.waitForSelector('#vbMic');
  return page;
}
async function connect(page, S, code) {
  await page.click('#btnSettings'); await page.fill('#vbApi', S.B); await page.fill('#vbCode', code || S.code); await page.click('#vbSave');
  await page.waitForFunction(() => /Terhubung/.test(document.getElementById('vbConnInfo').textContent), null, { timeout: 8000 });
  await page.click('#btnClose');
}
async function startSession(page) {
  await page.click('#vbMic');
  await page.waitForSelector('#vbConsent.open'); await page.click('#vbConsentOk');
  await page.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 8000 });
}
const state = page => page.evaluate(() => document.getElementById('vbStatus').dataset.s);
const txt = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
async function waitCard(page, side, ms = 25000) {
  await page.waitForFunction(s => { const p = document.querySelector('article.vb-turn.' + s + ' [data-k="tr"]'); return p && !p.classList.contains('dim'); }, side, { timeout: ms });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------
test('UI: satu tombol utama, tanpa tombol Lawan Bicara, tanpa klaim "audio meeting tersambung"', async (b, S) => {
  const p = await newPage(b, S);
  const btns = await p.evaluate(() => [...document.querySelectorAll('button')].map(x => (x.textContent + ' ' + (x.getAttribute('aria-label') || '')).trim()));
  check('UI: hanya satu tombol "Saya Bicara"', (await p.$$('#vbMic')).length === 1 && !btns.some(t => /lawan bicara/i.test(t)));
  check('UI: tidak ada tombol Lawan Bicara', !btns.some(t => /lawan bicara/i.test(t)), JSON.stringify(btns));
  check('UI: tidak ada klaim "tersambung" sebelum sesi', !/tersambung/i.test(await p.evaluate(() => document.body.innerText.split('Informasi AI')[0].replace(/Terhubung|tidak tersambung/g, ''))));
  check('UI: status awal idle dan lencana Gratis', (await state(p)) === 'idle' && (await txt(p, '#planBadge')) === 'Gratis');
  check('UI: tanpa galat JS saat dimuat', p.errors.length === 0, p.errors.join('|'));
  await p.context().close();
});

test('Keamanan: kunci lama dihapus dari localStorage saat dibuka', async (b, S) => {
  const p = await newPage(b, S, { init: () => { try { localStorage.setItem('tr_key_openai', 'sk-lama-1234567890'); localStorage.setItem('tr_key_claude', 'sk-ant-lama'); localStorage.setItem('tr_elkey', 'sk_lama1234567890'); } catch (_) {} } });
  const left = await p.evaluate(() => ['tr_key_openai', 'tr_key_claude', 'tr_elkey'].filter(k => localStorage.getItem(k) !== null));
  check('Keamanan: tr_key_openai, tr_key_claude, tr_elkey terhapus', left.length === 0, left.join());
  await p.context().close();
});

test('Alur utama: sesi, lawan otomatis, Saya Bicara, empat teks, tanpa tabrakan STT', async (b, S) => {
  S.mock.sttDelay = 400;
  const p = await newPage(b, S);
  await connect(p, S);
  check('Backend: terhubung dan lencana menampilkan kredit', /Uji · 100 kredit/.test(await txt(p, '#planBadge')), await txt(p, '#planBadge'));
  check('Keamanan: kode akses hanya di sessionStorage', await p.evaluate(() => !!sessionStorage.getItem('vb_token') && !Object.keys(localStorage).some(k => /token|code|key/i.test(k)) && !Object.values(localStorage).some(v => /VB-/.test(v))));
  check('Persetujuan: getUserMedia belum dipanggil sebelum setuju', (await p.evaluate(() => window.__gum)) === 0);
  await p.click('#vbMic'); await p.waitForSelector('#vbConsent.open');
  check('Persetujuan: dialog tampil sebelum izin audio', (await p.evaluate(() => window.__gum)) === 0 && /OpenAI/.test(await txt(p, '#vbConsent')));
  await p.click('#vbConsentOk');
  await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 8000 });
  check('Sesi: status "Mikrofon aktif" tanpa klaim tersambung', (await txt(p, '#vbTitle')) === 'Mikrofon aktif' && !/tersambung/i.test(await txt(p, '#vbStatus')));
  check('Sesi: mikrofon diminta setelah persetujuan', (await p.evaluate(() => window.__gum)) >= 1);
  check('Sesi: tombol Hentikan aktif, panel setup tersembunyi', (await p.evaluate(() => !document.getElementById('vbStop').disabled && document.getElementById('vbSetup').hidden)));

  // lawan bicara otomatis
  let maxMeter = 0; const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    maxMeter = Math.max(maxMeter, await p.evaluate(() => parseFloat(document.getElementById('meterTalk').style.width) || 0));
    if (await p.$('article.vb-turn.them [data-k="tr"]:not(.dim)')) break; await sleep(150);
  }
  check('Audio: indikator level bergerak mengikuti sinyal nyata', maxMeter > 8, maxMeter);
  await waitCard(p, 'them');
  check('Lawan: teks asli Inggris tampil', (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Could you explain the proposal?');
  check('Lawan: terjemahan Indonesia tampil', (await txt(p, 'article.vb-turn.them [data-k="tr"]')) === 'Bisakah Anda menjelaskan proposal tersebut?');
  check('Kredit: lawan = STT 2 + terjemah 1', (await S.api.credits(S.code)) === 97, await S.api.credits(S.code));
  check('Keadaan: tetap mendengarkan lawan setelah giliran lawan', (await state(p)) === 'listen');

  // Saya Bicara
  await sleep(300);
  await p.click('#vbMic');
  check('Saya Bicara: status berubah dan lawan dijeda', (await state(p)) === 'me' && /dijeda/.test(await txt(p, '#live')) && (await txt(p, '#vbMicLabel')) === 'Selesai Bicara');
  await waitCard(p, 'me');
  check('Saya: teks asli Indonesia tampil', (await txt(p, 'article.vb-turn.me [data-k="orig"]')) === 'Saya akan menjelaskan rencananya.');
  check('Saya: terjemahan Inggris tampil', (await txt(p, 'article.vb-turn.me [data-k="tr"]')) === 'I will explain the plan.');
  await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 15000 });
  check('Saya: audio Inggris dipanggil dari backend dan diputar', S.mock.calls.tts >= 1 && (await p.evaluate(() => window.__plays)) >= 1, S.mock.calls.tts + '/' + await p.evaluate(() => window.__plays));
  check('Saya: kembali mendengarkan lawan otomatis', (await state(p)) === 'listen');
  const langs = S.mock.seen.filter(s => s.kind === 'stt').map(s => (/name="languages\[\]"\r\n\r\n([a-z]+)/.exec(s.body.toString('latin1')) || [])[1]);
  check('STT: bahasa lawan en, bahasa saya id', langs.includes('en') && langs.includes('id'), langs.join());
  check('STT: tidak pernah dua proses berjalan bersamaan', S.mock.maxInflight.stt === 1, S.mock.maxInflight.stt);
  check('Empat teks: dua kartu, masing-masing dua blok', (await p.$$('article.vb-turn')).length >= 2 && (await p.$$('article.vb-turn .vb-box')).length >= 4);
  S.mock.sttDelay = 0;

  // salin, putar ulang, koreksi
  await p.click('article.vb-turn.them [data-a="copy-tr"]');
  check('Salin: isi clipboard sama dengan terjemahan', (await p.evaluate(() => navigator.clipboard.readText())) === 'Bisakah Anda menjelaskan proposal tersebut?');
  const tts0 = S.mock.calls.tts, plays0 = await p.evaluate(() => window.__plays);
  await p.click('article.vb-turn.me [data-a="play"]'); await sleep(900);
  check('Putar ulang kartu Saya: memakai audio tersimpan, tanpa biaya baru', S.mock.calls.tts === tts0 && (await p.evaluate(() => window.__plays)) === plays0 + 1);
  await p.click('article.vb-turn.them [data-a="play"]'); await sleep(1200);
  check('Putar ulang kartu Lawan: membuat suara Indonesia sekali', S.mock.calls.tts === tts0 + 1, S.mock.calls.tts);
  await p.click('article.vb-turn.them [data-a="play"]'); await sleep(1200);
  check('Putar ulang kedua: dari cache, tanpa biaya', S.mock.calls.tts === tts0 + 1, S.mock.calls.tts);
  await p.click('article.vb-turn.them [data-a="edit"]');
  await p.fill('article.vb-turn.them .vb-edit textarea', 'Where is the budget?');
  await p.click('article.vb-turn.them .vb-edit .pri');
  await p.waitForFunction(() => /Dikoreksi/.test(document.querySelector('article.vb-turn.them [data-k="chip"]').textContent), null, { timeout: 8000 });
  check('Koreksi: teks asli dan terjemahan diperbarui', (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Where is the budget?' && (await txt(p, 'article.vb-turn.them [data-k="tr"]')) === 'T:Where is the budget?');

  // riwayat opt-in
  check('Riwayat: tidak tersimpan secara bawaan', (await p.evaluate(() => localStorage.getItem('vb_history'))) === null);
  await p.click('#btnSettings'); await p.click('summary:has-text("Riwayat dan privasi")'); await p.check('#histOptIn');
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('vb_history') || '[]'));
  check('Riwayat: setelah opt-in tersimpan sebagai teks saja', saved.length === 1 && saved[0].items.length >= 2 && !JSON.stringify(saved).match(/audio|blob|wav|mp3/i), JSON.stringify(saved).slice(0, 200));
  const dl = p.waitForEvent('download'); await p.click('#btnExpSession'); const d = await dl;
  const body = require('fs').readFileSync(await d.path(), 'utf8');
  check('Ekspor transkrip: memuat teks asli dan terjemahan', /TRANSKRIP VOCALBRIDGE/.test(body) && /Could you|Where is the budget/.test(body) && /I will explain the plan\./.test(body));
  await p.click('#btnDelSession');
  check('Hapus sesi: kartu dan riwayat sesi hilang', (await p.$$('article.vb-turn')).length === 0 && (await p.evaluate(() => JSON.parse(localStorage.getItem('vb_history') || '[]'))).length === 0);
  await p.click('#btnClose');

  // jaringan dan penyimpanan
  const hosts = new Set(p.reqs.map(r => new URL(r.url).host));
  check('Jaringan: tidak ada panggilan langsung ke penyedia AI', ![...hosts].some(h => /openai|anthropic|elevenlabs|mymemory/i.test(h)), [...hosts].join());
  const paid = p.reqs.filter(r => /\/api\/(stt|translate|tts)/.test(r.url) && r.method === 'POST');
  check('Jaringan: semua panggilan berbayar membawa Authorization dan Idempotency-Key', paid.length >= 4 && paid.every(r => /^Bearer VB-/.test(r.h.authorization || '') && (r.h['idempotency-key'] || '').length >= 8), paid.length);
  const keys = paid.map(r => r.h['idempotency-key']); check('Jaringan: kunci idempotensi unik per permintaan', new Set(keys).size === keys.length);
  check('Penyimpanan: tidak ada kunci API atau kode akses di localStorage', await p.evaluate(() => { const all = JSON.stringify(Object.entries(localStorage)); return !/sk-|VB-|xi-api|Bearer/.test(all); }));

  // hentikan
  await p.click('#vbStop');
  check('Hentikan: sesi idle dan semua trek mikrofon berhenti', (await state(p)) === 'idle' && (await p.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended')))));
  check('Tanpa galat JS selama alur', p.errors.length === 0, p.errors.join('|'));
  await p.context().close();
});

test('Sumber audio tab: "terverifikasi" hanya setelah sinyal terdeteksi, dan jalur tanpa audio', async (b, S) => {
  const stub = () => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (window.__tabMode === 'noaudio') return new MediaStream();
      const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination(); const osc = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0;
      osc.frequency.value = 300; osc.connect(g); g.connect(dest); osc.start(); window.__tabGain = g; window.__tabCtx = ctx; return dest.stream;
    };
  };
  const p = await newPage(b, S, { init: stub });
  await connect(p, S);
  await p.selectOption('#vbSrc', 'tab');
  await p.click('#vbStart'); await p.waitForSelector('#vbConsent.open'); await p.click('#vbConsentOk');
  await p.waitForFunction(() => document.getElementById('vbTitle').textContent !== 'Belum ada sesi', null, { timeout: 8000 });
  await sleep(1500);
  check('Tab: sebelum ada suara, status menunggu (bukan terverifikasi)', (await txt(p, '#vbTitle')) === 'Menunggu audio dari tab…' && (await p.evaluate(() => document.getElementById('vbStatus').dataset.s)) === 'wait', await txt(p, '#vbTitle'));
  check('Tab: tidak ada klaim terverifikasi atau tersambung', !/terverifikasi|tersambung/i.test(await txt(p, '#vbStatus')));
  await p.evaluate(() => { window.__tabGain.gain.value = 0.3; });
  await p.waitForFunction(() => document.getElementById('vbTitle').textContent === 'Audio tab terverifikasi', null, { timeout: 8000 });
  check('Tab: terverifikasi setelah sinyal terdeteksi', true);
  await sleep(1500); await p.evaluate(() => { window.__tabGain.gain.value = 0; }); // ucapan selesai: diam agar VAD menutup giliran
  await waitCard(p, 'them', 20000);
  check('Tab: suara dari tab diproses sebagai lawan', (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Could you explain the proposal?');
  await p.evaluate(() => { window.__tabGain.gain.value = 0; });
  await p.click('#vbStop');
  check('Tab: Hentikan melepas semua trek', await p.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
  await p.context().close();

  const p2 = await newPage(b, S, { init: () => { window.__tabMode = 'noaudio'; (function () { navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(); })(); } });
  await connect(p2, S); await p2.selectOption('#vbSrc', 'tab'); await p2.click('#vbStart'); await p2.waitForSelector('#vbConsent.open'); await p2.click('#vbConsentOk');
  await p2.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 8000 });
  check('Tab tanpa audio: pesan jelas dan kembali ke mikrofon', /Tidak ada audio yang dibagikan/.test(await txt(p2, '#vbHint')) && (await txt(p2, '#vbTitle')) === 'Mikrofon aktif');
  await p2.context().close();
});

test('Ketahanan: respons hilang saat retry tidak memotong kredit dua kali', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S);
  let dropped = 0;
  await p.route('**/api/translate', async route => { if (dropped === 0) { dropped++; await route.fetch(); return route.abort('failed'); } return route.continue(); });
  await connect(p, S, code); await startSession(p);
  const c0 = await S.api.credits(code), t0 = S.mock.calls.translate;
  await waitCard(p, 'them', 30000);
  check('Retry: permintaan sempat dijatuhkan lalu dicoba ulang', dropped === 1);
  check('Retry: penyedia dipanggil sekali saja untuk terjemahan', S.mock.calls.translate === t0 + 1, S.mock.calls.translate - t0);
  check('Retry: kredit terpotong sekali (STT 2 + terjemah 1)', (await S.api.credits(code)) === 47, await S.api.credits(code));
  check('Retry: balasan ulang ditandai Idempotent-Replay', p.resps.some(r => /\/api\/translate/.test(r.url) && r.h['idempotent-replay'] === 'true'));
  await p.context().close();
});

test('Kesalahan: kredit habis dan layanan dinonaktifkan ditampilkan jelas', async (b, S) => {
  const code = await S.api.mkCode(2);
  const p = await newPage(b, S); await connect(p, S, code); await startSession(p);
  await p.waitForFunction(() => /Kredit habis/.test(document.querySelector('article.vb-turn .vb-chip')?.textContent || ''), null, { timeout: 25000 });
  check('Kredit habis: pesan jelas di kartu, tanpa crash', true);
  check('Kredit habis: kredit tidak negatif dan tidak ada panggilan terjemahan', (await S.api.credits(code)) === 0);
  await p.click('#vbStop'); await p.context().close();

  const code2 = await S.api.mkCode(50); await S.api.adminCall('/admin/kill', { enabled: false });
  const p2 = await newPage(b, S); await connect(p2, S, code2); await startSession(p2);
  await p2.waitForFunction(() => /dinonaktifkan/.test(document.getElementById('vbHint').textContent), null, { timeout: 25000 });
  check('Dinonaktifkan admin: pesan jelas', true);
  await S.api.adminCall('/admin/kill', { enabled: true });
  await p2.click('#vbStop'); await p2.context().close();
});

test('Responsif: HP (Pixel 7) dan desktop tanpa scroll horizontal, tombol terjangkau', async (b, S) => {
  const code = await S.api.mkCode(100);
  for (const mobile of [true, false]) {
    const tag = mobile ? 'HP' : 'Desktop';
    const p = await newPage(b, S, { mobile }); await connect(p, S, code); await startSession(p);
    await waitCard(p, 'them', 25000); await p.waitForTimeout(300);
    const m = await p.evaluate(() => { const r = document.getElementById('vbMic').getBoundingClientRect(); const f = parseFloat(getComputedStyle(document.querySelector('.vb-box p')).fontSize);
      return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, top: r.top, bottom: r.bottom, vh: window.innerHeight, left: r.left, right: r.right, font: f,
        turnOverflow: [...document.querySelectorAll('.vb-turn')].some(t => t.scrollWidth > t.clientWidth + 1) }; });
    check(tag + ': tanpa scroll horizontal', m.sw <= m.iw, JSON.stringify(m));
    check(tag + ': tombol Saya Bicara terlihat penuh di layar', m.top >= 0 && m.bottom <= m.vh && m.left >= 0 && m.right <= m.iw, JSON.stringify(m));
    check(tag + ': teks percakapan besar (>=17px) dan tidak terpotong', m.font >= 17 && !m.turnOverflow, JSON.stringify(m));
    if (mobile) check('HP: opsi audio tab dinonaktifkan dengan penjelasan', (await p.evaluate(() => document.getElementById('vbSrcTab').disabled)) && /HP/.test(await txt(p, '#vbSrcNote')));
    await p.screenshot({ path: '/tmp/vb-' + tag.toLowerCase() + '.png' });
    await p.click('#vbStop'); await p.context().close();
  }
});


test('Mode Gratis (tanpa backend): satu tombol, lawan otomatis, giliran Saya (SpeechRecognition dipalsukan)', async (b, S) => {
  const stub = () => {
    class FakeSR { constructor() { (window.__srs = window.__srs || []).push(this); } start() { window.__srLang = this.lang; } stop() { setTimeout(() => this.onend && this.onend(), 0); } }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
    window.__srEmit = text => { const r = window.__srs[window.__srs.length - 1]; r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); };
    speechSynthesis.speak = u => { (window.__spoken = window.__spoken || []).push([u.lang, u.text]); setTimeout(() => u.onend && u.onend(), 50); };
  };
  const p = await newPage(b, S, { init: stub });
  await p.route('https://api.mymemory.translated.net/**', route => { const u = new URL(route.request().url()); const pair = u.searchParams.get('langpair'); route.fulfill({ contentType: 'application/json', body: JSON.stringify({ responseStatus: 200, responseData: { translatedText: pair + ':' + u.searchParams.get('q') } }) }); });
  const calls0 = S.mock.calls.stt + S.mock.calls.translate + S.mock.calls.tts;
  await startSession(p);
  check('Gratis: sesi mendengarkan lawan dalam Inggris (en-US)', (await state(p)) === 'listen' && (await p.evaluate(() => window.__srLang)) === 'en-US');
  await p.evaluate(() => window.__srEmit('Could you explain the proposal?'));
  await waitCard(p, 'them', 8000);
  check('Gratis: kartu Lawan berisi teks asli dan terjemahan', (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Could you explain the proposal?' && /^en\|id:Could/.test(await txt(p, 'article.vb-turn.them [data-k="tr"]')), await txt(p, 'article.vb-turn.them [data-k="tr"]'));
  await p.click('#vbMic');
  check('Gratis: Saya Bicara menjeda lawan dan memakai id-ID', (await state(p)) === 'me' && (await p.evaluate(() => window.__srLang)) === 'id-ID');
  await p.evaluate(() => window.__srEmit('Saya akan menjelaskan rencananya.'));
  await waitCard(p, 'me', 8000);
  await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 10000 });
  check('Gratis: kartu Saya dan suara perangkat Inggris dipakai', /^id\|en:Saya/.test(await txt(p, 'article.vb-turn.me [data-k="tr"]')) && (await p.evaluate(() => (window.__spoken || []).some(x => x[0] === 'en-US'))));
  check('Gratis: kembali mendengarkan lawan (en-US)', (await p.evaluate(() => window.__srLang)) === 'en-US');
  check('Gratis: tidak memanggil backend sama sekali', S.mock.calls.stt + S.mock.calls.translate + S.mock.calls.tts === calls0 && !p.reqs.some(r => /\/api\//.test(r.url)));
  check('Gratis: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  await p.click('#vbStop'); check('Gratis: Hentikan mengembalikan ke idle', (await state(p)) === 'idle');
});

test('QA Lab: terpisah dari tampilan utama dan tetap berfungsi', async (b, S) => {
  const code = await S.api.mkCode(100);
  const p = await newPage(b, S); await connect(p, S, code);
  await p.click('#btnSettings'); await p.click('summary:has-text("Alat uji")'); await p.click('#btnOpenLab');
  check('QA Lab: tampil dan percakapan tersembunyi', (await p.evaluate(() => document.getElementById('view-test').classList.contains('on') && !document.getElementById('view-talk').classList.contains('on'))));
  check('QA Lab: naskah dialog tampil', (await txt(p, '#scriptTarget') || '').length > 5);
  await p.fill('#testerName', 'Penguji 1');
  await p.click('#btnRec');
  await p.waitForFunction(() => /Selesai\./.test(document.getElementById('scriptStatus').textContent), null, { timeout: 30000 });
  const log = await p.evaluate(() => JSON.parse(localStorage.getItem('tr_log') || '[]'));
  check('QA Lab: entri uji tersimpan dengan teks terdengar dan terjemahan', log.length === 1 && log[0].heard && log[0].translation && log[0].view === 'test' && log[0].tester === 'Penguji 1', JSON.stringify(log[0] || {}).slice(0, 160));
  check('QA Lab: kesesuaian ucapan dihitung', typeof log[0].acc === 'number');
  check('QA Lab: hasil tampil di layar', (await txt(p, '#scriptResult') || '').length > 10);
  for (const [id, re] of [['#expCsv', /heard|terdengar|Saya/i], ['#expTxt', /Penguji|penguji/i], ['#expTrans', /TRANSKRIP PERCAKAPAN/], ['#expJson', /"heard"/]]) {
    const dl = p.waitForEvent('download'); await p.click(id); const body = require('fs').readFileSync(await (await dl).path(), 'utf8');
    check('QA Lab: ekspor ' + id.slice(4) + ' berisi data', re.test(body) && body.length > 40, body.slice(0, 80));
  }
  const m = await S.api.credits(code); check('QA Lab: memakai backend (kredit berkurang)', m < 100, m);
  await p.click('#expClear');
  check('QA Lab: hapus catatan mengosongkan data', (await p.evaluate(() => JSON.parse(localStorage.getItem('tr_log') || '[]'))).length === 0);
  await p.click('#btnBackTalk');
  check('QA Lab: kembali ke percakapan', await p.evaluate(() => document.getElementById('view-talk').classList.contains('on')));
  check('QA Lab: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  await p.context().close();
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
