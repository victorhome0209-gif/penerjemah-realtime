'use strict';
// Tes browser (SIMULASI): halaman asli + backend asli + OpenAI palsu + mikrofon palsu di Chromium.
// Bukan tes nyata: tidak ada suara manusia, kunci OpenAI, HP, atau Meet/Zoom sungguhan.
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (_) { console.error('Playwright belum terpasang. Jalankan: npm install && npx playwright install chromium'); process.exit(2); }
const { startAll } = require('./servers');
const { spawnBackend } = require('../../backend/test/helpers');
const net = require('net');

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
  check('UI: status awal idle, lencana "Belum terhubung", tanpa label Gratis', (await state(p)) === 'idle' && (await txt(p, '#planBadge')) === 'Belum terhubung' && !/gratis/i.test(await p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('script,style').forEach(n => n.remove()); return c.textContent; })));
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

  // V1.2: bila administrator mematikan layanan, sesi tidak dimulai sama sekali (diperiksa sebelum persetujuan dan mikrofon)
  const code2 = await S.api.mkCode(50); await S.api.adminCall('/admin/kill', { enabled: false });
  try {
    const p2 = await newPage(b, S); await connect(p2, S, code2); await p2.click('#vbMic');
    await p2.waitForFunction(() => /dinonaktifkan/.test(document.getElementById('vbHint').textContent), null, { timeout: 25000 });
    check('Dinonaktifkan admin: pesan jelas, sesi tidak dimulai, mikrofon tidak diminta', (await state(p2)) === 'idle' && (await p2.evaluate(() => window.__gum)) === 0 && (await txt(p2, '#vbHint')).startsWith('Layanan AI belum terhubung.'), await txt(p2, '#vbHint'));
    await p2.context().close();
  } finally { await S.api.adminCall('/admin/kill', { enabled: true }); }
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


// ---------------------------------------------------------------------------------------------
// V1.2 API-only: tidak ada mode Gratis. Penyadap di bawah mendeteksi pemakaian jalur lama (SpeechRecognition, suara perangkat).
const OFF = 'Layanan AI belum terhubung.';
const spyInit = () => {
  window.__freeUse = [];
  class SpySR { constructor() { window.__freeUse.push('SpeechRecognition'); } start() { window.__freeUse.push('SpeechRecognition.start'); } stop() {} }
  window.SpeechRecognition = window.webkitSpeechRecognition = SpySR;
  try { speechSynthesis.speak = () => window.__freeUse.push('speechSynthesis.speak'); } catch (_) {}
};
const freeUse = p => p.evaluate(() => window.__freeUse || []);
const noFreeNet = p => !p.reqs.some(r => /mymemory|translated\.net/i.test(r.url));
const bodyText = p => p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('script,style').forEach(n => n.remove()); return c.textContent; });
const closedPort = () => new Promise(r => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const q = sv.address().port; sv.close(() => r(q)); }); });
const withStorage = (base, token) => new Function('try{localStorage.setItem("vb_api",' + JSON.stringify(base) + ');sessionStorage.setItem("vb_token",' + JSON.stringify(token) + ');}catch(_){}');

test('V1.2 tanpa backend: gagal aman dan informatif, tanpa jalur gratis, QA Lab dan tes mikrofon tetap berfungsi', async (b, S) => {
  const p = await newPage(b, S, { init: spyInit });
  await p.route('https://api.mymemory.translated.net/**', route => route.abort());
  check('Tanpa backend: layar utama menampilkan "' + OFF + '"', (await txt(p, '#vbTitle')) === OFF, await txt(p, '#vbTitle'));
  check('Tanpa backend: lencana "Belum terhubung" dan tidak ada kata "Gratis" di UI', (await txt(p, '#planBadge')) === 'Belum terhubung' && !/gratis/i.test(await bodyText(p)), await txt(p, '#planBadge'));
  check('Tanpa backend: tetap satu tombol "Saya Bicara"', (await p.$$('#vbMic')).length === 1 && (await txt(p, '#vbMicLabel')) === 'Saya Bicara');
  await p.click('#vbMic'); await sleep(600);
  check('Tanpa backend: Saya Bicara tidak memulai sesi (status idle, tanpa dialog persetujuan)', (await state(p)) === 'idle' && !(await p.$('#vbConsent.open')));
  check('Tanpa backend: mikrofon tidak diminta', (await p.evaluate(() => window.__gum)) === 0);
  check('Tanpa backend: pesan "' + OFF + '" tampil di status dan petunjuk', (await txt(p, '#live')).startsWith(OFF) && (await txt(p, '#vbHint')).startsWith(OFF), await txt(p, '#live'));
  check('Tanpa backend: tidak ada klaim sedang mendengarkan atau berhasil menerjemahkan', !/Mikrofon aktif|Mendengarkan lawan|Memproses|terjemahan/i.test((await txt(p, '#vbTitle')) + (await txt(p, '#live'))) && (await p.$$('article.vb-turn')).length === 0);
  check('Tanpa backend: tidak ada panggilan jaringan ke /api/ atau MyMemory', !p.reqs.some(r => /\/api\//.test(r.url)) && noFreeNet(p));
  check('Tanpa backend: SpeechRecognition dan suara perangkat tidak dipakai', (await freeUse(p)).length === 0, JSON.stringify(await freeUse(p)));
  // QA Lab: bagian offline tetap jalan, rekam butuh layanan
  await p.click('#btnSettings'); await p.click('summary:has-text("Alat uji")'); await p.click('#btnOpenLab');
  check('QA Lab (offline): naskah dialog tampil', (await txt(p, '#scriptTarget') || '').length > 5);
  await p.click('#btnRec'); await sleep(400);
  check('QA Lab: rekam tanpa layanan ditolak dengan pesan jelas, mikrofon tidak dibuka', (await txt(p, '#scriptStatus')).startsWith(OFF) && (await p.evaluate(() => window.__gum)) === 0, await txt(p, '#scriptStatus'));
  const rv = await p.evaluate(() => { const T = window.__t; return [T.wer('hello world today', 'hello world', 'en') > 0, T.normText('It costs $5', 'en').includes('dollars'), T.diffHtml('a b', 'a c', 'en').includes('mark')]; });
  check('QA Lab (offline): WER, normalisasi, dan diff tetap bekerja', rv.every(Boolean), JSON.stringify(rv));
  await p.click('#btnBackTalk');
  // pengaturan mikrofon (tes 8 detik, hanya lokal)
  await p.click('#btnSettings'); await p.click('summary:has-text("Audio dan mikrofon")');
  const n0 = p.reqs.length; await p.click('#btnMicTest');
  await p.waitForFunction(() => document.getElementById('micVerdict').textContent.length > 10, null, { timeout: 14000 });
  check('Pengaturan mikrofon: tes lokal memberi hasil tanpa layanan AI dan tanpa jaringan', p.reqs.slice(n0).filter(r => !/^data:|^blob:/.test(r.url)).length === 0 && (await p.evaluate(() => window.__gum)) >= 1);
  check('Tanpa backend: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('V1.2 server tidak terjangkau: sesi tidak dimulai, pesan jelas, tanpa jalur gratis', async (b, S) => {
  const dead = 'http://127.0.0.1:' + await closedPort();
  const p = await newPage(b, S, { init: new Function('(' + spyInit.toString() + ')();' + 'try{localStorage.setItem("vb_api",' + JSON.stringify(dead) + ');sessionStorage.setItem("vb_token","VB-TOKENUJI000001");}catch(_){}') });
  await p.route('https://api.mymemory.translated.net/**', route => route.abort());
  await p.click('#vbMic');
  await p.waitForFunction(o => document.getElementById('live').textContent.startsWith(o), OFF, { timeout: 12000 });
  check('Server mati: pesan memuat "' + OFF + '" dan alasan tidak terjangkau', /tidak terjangkau/i.test(await txt(p, '#live')), await txt(p, '#live'));
  check('Server mati: status idle, mikrofon tidak diminta, tidak ada dialog persetujuan', (await state(p)) === 'idle' && (await p.evaluate(() => window.__gum)) === 0 && !(await p.$('#vbConsent.open')));
  check('Server mati: tidak ada kartu, tidak ada klaim berhasil', (await p.$$('article.vb-turn')).length === 0 && !/Mikrofon aktif/.test(await txt(p, '#vbTitle')));
  check('Server mati: tidak ada jalur gratis (SpeechRecognition, suara perangkat, MyMemory)', (await freeUse(p)).length === 0 && noFreeNet(p), JSON.stringify(await freeUse(p)));
  check('Server mati: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('V1.2 tanpa/salah autentikasi: akses AI ditolak server dan sesi tidak dimulai', async (b, S) => {
  const p = await newPage(b, S);
  const c0 = S.mock.calls.stt + S.mock.calls.translate + S.mock.calls.tts;
  const st = await p.evaluate(async B => {
    const call = async (path, h, body) => (await fetch(B + path, { method: 'POST', headers: Object.assign({ 'Idempotency-Key': 'uji-' + Math.random().toString(36).slice(2, 12), 'Content-Type': 'application/json' }, h), body })).status;
    return [await call('/api/translate', {}, '{"text":"hi","src":"en","tgt":"id"}'), await call('/api/translate', { Authorization: 'Bearer VB-SALAH0000000000' }, '{"text":"hi","src":"en","tgt":"id"}'),
      await call('/api/tts', {}, '{"text":"hi","lang":"en"}'), await call('/api/stt?lang=en', { 'Content-Type': 'audio/wav' }, 'x')];
  }, S.B);
  check('Auth: translate, tts, dan stt tanpa/dengan kode salah dijawab 401', st.every(x => x === 401), JSON.stringify(st));
  check('Auth: OpenAI tidak dipanggil sama sekali', S.mock.calls.stt + S.mock.calls.translate + S.mock.calls.tts === c0);
  const q = await newPage(b, S, { init: withStorage(S.B, 'VB-SALAH0000000000') });
  await q.click('#vbMic');
  await q.waitForFunction(o => document.getElementById('live').textContent.startsWith(o), OFF, { timeout: 10000 });
  check('Auth: kode akses salah -> "' + OFF + '" + penjelasan, sesi tidak dimulai', /Kode akses salah/.test(await txt(q, '#live')) && (await state(q)) === 'idle' && (await q.evaluate(() => window.__gum)) === 0, await txt(q, '#live'));
  check('Auth: kode salah dihapus dari sessionStorage dan lencana kembali "Belum terhubung"', (await q.evaluate(() => sessionStorage.getItem('vb_token'))) === null && (await txt(q, '#planBadge')) === 'Belum terhubung');
  check('Auth: kode salah tidak memicu panggilan berbayar', !q.reqs.some(r => /\/api\/(stt|translate|tts)/.test(r.url)) && S.mock.calls.stt + S.mock.calls.translate + S.mock.calls.tts === c0);
});

test('V1.2 layanan dinonaktifkan administrator (PAID_API_ENABLED=false): sesi tidak dimulai', async (b, S) => {
  const S2 = await startAll({ credits: 50, env: { PAID_API_ENABLED: 'false' } });
  try {
    const p = await newPage(b, S2); await connect(p, S2);
    await p.click('#vbMic');
    await p.waitForFunction(o => document.getElementById('live').textContent.startsWith(o), OFF, { timeout: 10000 });
    check('Dinonaktifkan: pesan memuat "' + OFF + '" dan penjelasan administrator', /dinonaktifkan oleh administrator/.test(await txt(p, '#live')), await txt(p, '#live'));
    check('Dinonaktifkan: tidak ada sesi, mikrofon, atau panggilan berbayar', (await state(p)) === 'idle' && (await p.evaluate(() => window.__gum)) === 0 && S2.mock.calls.stt + S2.mock.calls.translate + S2.mock.calls.tts === 0 && !p.reqs.some(r => /\/api\/(stt|translate|tts)/.test(r.url)));
  } finally { await S2.close(); }
});

test('V1.2 kesalahan API: kegagalan ditampilkan apa adanya, tanpa cadangan gratis', async (b, S) => {
  const p = await newPage(b, S, { init: spyInit });
  await p.route('https://api.mymemory.translated.net/**', route => route.abort());
  try {
    await connect(p, S);
    S.mock.fail.translate = 400;
    await startSession(p);
    await p.waitForFunction(() => /Gagal menerjemahkan/.test((document.querySelector('article.vb-turn.them [data-k="chip"]') || {}).textContent || ''), null, { timeout: 30000 });
    check('Galat terjemahan: kartu menampilkan kegagalan, terjemahan kosong', /Gagal menerjemahkan/.test(await txt(p, 'article.vb-turn.them [data-k="chip"]')) && (await p.evaluate(() => document.querySelector('article.vb-turn.them [data-k="tr"]').classList.contains('dim'))));
    check('Galat terjemahan: teks asli tetap ditampilkan, tombol koreksi aktif', (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Could you explain the proposal?' && !(await p.evaluate(() => document.querySelector('article.vb-turn.them [data-a="edit"]').disabled)));
    check('Galat terjemahan: tidak ada MyMemory, SpeechRecognition, atau suara perangkat', noFreeNet(p) && (await freeUse(p)).length === 0, JSON.stringify(await freeUse(p)));
    check('Galat terjemahan: sesi tetap mendengarkan (tidak macet)', (await state(p)) === 'listen');
    delete S.mock.fail.translate; S.mock.fail.tts = 400;
    await p.click('#vbMic'); await waitCard(p, 'me');
    await p.waitForFunction(() => /Suara gagal/.test((document.querySelector('article.vb-turn.me [data-k="chip"]') || {}).textContent || ''), null, { timeout: 20000 });
    check('Galat suara: terjemahan tertulis tetap tampil, kegagalan suara ditandai', (await txt(p, 'article.vb-turn.me [data-k="tr"]')) === 'I will explain the plan.' && /Suara gagal/.test(await txt(p, 'article.vb-turn.me [data-k="chip"]')));
    check('Galat suara: tidak jatuh ke suara perangkat', (await freeUse(p)).length === 0 && noFreeNet(p), JSON.stringify(await freeUse(p)));
    await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 15000 });
    check('Galat suara: kembali mendengarkan lawan', (await state(p)) === 'listen');
    check('Galat API: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
    await p.click('#vbStop');
  } finally { delete S.mock.fail.translate; delete S.mock.fail.tts; }
});

test('V1.2 kuota OpenAI (hard spend limit): pesan jelas di kartu, kredit tidak terpotong dua kali, tanpa jalur gratis', async (b, S) => {
  const p = await newPage(b, S, { init: spyInit });
  await p.route('https://api.mymemory.translated.net/**', route => route.abort());
  const code = await S.api.mkCode(30);
  try {
    await connect(p, S, code);
    S.mock.fail.translate = 429; S.mock.failCode.translate = 'project_spend_limit_exceeded';
    await startSession(p);
    await p.waitForFunction(() => /Batas biaya atau kuota/.test((document.querySelector('article.vb-turn.them [data-k="chip"]') || {}).textContent || ''), null, { timeout: 30000 });
    check('Kuota: kartu menampilkan "batas biaya atau kuota ... hubungi administrator", bukan "sibuk"', !/sibuk/i.test(await txt(p, 'article.vb-turn.them [data-k="chip"]')) && /administrator/.test(await txt(p, 'article.vb-turn.them [data-k="chip"]')), await txt(p, 'article.vb-turn.them [data-k="chip"]'));
    check('Kuota: terjemahan kosong, teks asli tetap tampil', (await p.evaluate(() => document.querySelector('article.vb-turn.them [data-k="tr"]').classList.contains('dim'))) && (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Could you explain the proposal?');
    await p.click('#vbStop');
    const left = await S.api.credits(code);
    check('Kuota: hanya STT yang ditagih (2 kredit per giliran); terjemahan ditolak dikembalikan, tidak ada potongan ganda', (30 - left) % 2 === 0 && left <= 28 && left >= 20, left);
    check('Kuota: tidak ada kunci/rahasia di halaman dan tidak ada MyMemory/SpeechRecognition/suara perangkat', !(await bodyText(p)).includes('sk-') && noFreeNet(p) && (await freeUse(p)).length === 0);
  } finally { delete S.mock.fail.translate; delete S.mock.failCode.translate; }
});

test('Suara Saya (klon suara): modul dipertahankan sebagai fitur Pro NONAKTIF, rekam sampel lokal tanpa jaringan', async (b, S) => {
  const p = await newPage(b, S); await connect(p, S);
  await p.click('#btnSettings'); await p.click('summary:has-text("Suara Saya")'); await p.click('#btnOpenVoice');
  check('Suara Saya: tampilan ada dan tombol kembali tersedia', await p.evaluate(() => document.getElementById('view-voice').classList.contains('on') && !!document.getElementById('btnBackTalk2')));
  check('Suara Saya: ditandai fitur Pro nonaktif', /Pro nonaktif|nonaktif/.test(await txt(p, '#voiceGate')) && /Pro · nonaktif/.test(await txt(p, '#view-voice')), await txt(p, '#voiceGate'));
  check('Suara Saya: tombol klon dan suara klon nonaktif, pakai-klon nonaktif', await p.evaluate(() => ['cloneBtn', 'btnPlayClone', 'useEL'].every(id => document.getElementById(id).disabled)));
  check('Suara Saya: server menyatakan fitur nonaktif lewat /api/me', (await p.evaluate(() => window.__t.VB.me.features.voice_clone.enabled)) === false);
  await p.check('#consent'); await p.evaluate(() => window.__t.renderVoiceGate());
  check('Suara Saya: persetujuan saja tidak mengaktifkan klon', await p.evaluate(() => document.getElementById('cloneBtn').disabled));
  const n0 = p.reqs.length;
  await p.click('#btnRecSample'); await sleep(4200); await p.click('#btnRecSample'); // aplikasi menolak rekaman < 3 dtk
  await p.waitForFunction(() => document.getElementById('samplePrev').style.display === 'block', null, { timeout: 8000 });
  check('Suara Saya: rekaman sampel lokal berhasil dan dapat didengar ulang', /Terekam|File|dtk/.test(await txt(p, '#recInfo')) || (await p.evaluate(() => !!document.getElementById('samplePrev').src)), await txt(p, '#recInfo'));
  check('Suara Saya: merekam sampel tidak mengirim apa pun ke jaringan', p.reqs.slice(n0).filter(r => !/^data:|^blob:/.test(r.url)).length === 0, JSON.stringify(p.reqs.slice(n0).map(r => r.url)));
  await p.click('#cloneBtn', { force: true }).catch(() => {});
  check('Suara Saya: mengeklik klon tidak memanggil /api/clone atau ElevenLabs', !p.reqs.some(r => /\/api\/clone|elevenlabs/i.test(r.url)));
  const gate = await p.evaluate(() => { window.__t.VB.me.features = { voice_clone: { enabled: true, reason: '' } }; window.__t.renderVoiceGate(); return document.getElementById('cloneBtn').disabled; });
  check('Suara Saya: gerbang mengikuti pernyataan server (aktif + sampel + persetujuan = tombol terbuka)', gate === false);
  check('Suara Saya: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('Restart backend sungguhan saat permintaan berjalan (browser): kredit ditahan, tidak ditagih ganda, sesi pulih', async (b, S) => {
  const port = await new Promise(r => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const q = sv.address().port; sv.close(() => r(q)); }); });
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vb-e2e-restart-'));
  const env = { PORT: String(port), OPENAI_BASE: S.mock.base, ALLOWED_ORIGINS: S.origin, OPENAI_TTS_FORMAT: 'wav' };
  let be = await spawnBackend(env, dir);
  const code = (await be.adm('/admin/codes', { name: 'Restart', credits: 100 })).json.code;
  const stt0 = S.mock.calls.stt, done0 = S.mock.completed.stt;
  S.mock.sttDelay = 3000;
  const p = await newPage(b, S); await connect(p, { B: be.B, code }, code); await startSession(p);
  const t0 = Date.now(); while (S.mock.calls.stt === stt0 && Date.now() - t0 < 25000) await sleep(50);
  check('Restart: permintaan STT pertama sampai ke penyedia', S.mock.calls.stt === stt0 + 1);
  await be.kill(); S.mock.sttDelay = 0;                                                         // backend mati saat penyedia sedang memproses
  await sleep(300); be = await spawnBackend(env, dir);
  check('Restart: backend baru melaporkan pemulihan 1 transaksi UNKNOWN', /"recovered":\{"failed":0,"unknown":1\}/.test(be.out()), be.out().slice(0, 200));
  const unk = (await be.adm('/admin/transactions?state=UNKNOWN')).json;
  check('Restart: transaksi UNKNOWN tercatat dan kredit ditahan (tidak dikembalikan otomatis)', unk.length === 1 && (await be.me(code)).credits === 98, JSON.stringify(unk.map(t => t.state)) + ' ' + (await be.me(code)).credits);
  check('Restart: ID transaksi = X-Client-Request-Id yang diterima penyedia', S.mock.seen[S.mock.seen.length - 1].headers['x-client-request-id'] === unk[0].txn);
  await waitCard(p, 'them', 40000);
  check('Restart: sesi pulih dan ucapan berikutnya berhasil diproses', (await txt(p, 'article.vb-turn.them [data-k="orig"]')) === 'Could you explain the proposal?');
  const me = await be.me(code);
  check('Restart: kredit terpakai = pekerjaan yang ditagih penyedia (1 hilang ditahan + 1 sukses)', me.credits === 95 && me.held === 2 && S.mock.completed.stt - done0 === 2, JSON.stringify(me) + ' completed=' + (S.mock.completed.stt - done0));
  const res = await be.adm('/admin/transactions/resolve', { txn: unk[0].txn, resolution: 'confirm', note: 'tercatat di log penyedia', request_id: 'req-e2e-restart-1' });
  check('Restart: admin merekonsiliasi (confirm) dan saldo konsisten', res.json.state === 'CONFIRMED' && (await be.me(code)).held === 0 && (await be.adm('/admin/audit')).json.issues.length === 0);
  await p.click('#vbStop'); await be.kill();
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

// ---------------------------------------------------------------------------------------------
// H1: penjaga sesi. Giliran yang antre atau sedang berjalan saat sesi dihentikan DIBUANG (tidak dirender, tidak masuk riwayat, tidak diputar);
// hasil yang sudah selesai dipertahankan. Pemberitahuan tampil SEKALI per sesi.
// BATAS YANG DIKLAIM: request yang sudah terkirim tidak dijamin bisa dibatalkan dan kredit yang terpakai TIDAK otomatis kembali.
// TIDAK diklaim: maxInflight STT global = 1 antar sesi (tidak ada antrean lintas sesi); retranslate/replay (risiko H2) belum dijaga.
async function h1Watch(p) {   // hitung pemunculan pemberitahuan "dibuang" pada #toast
  await p.evaluate(() => {
    window.__notices = 0;
    new MutationObserver(() => { if (/dibuang/.test(document.getElementById('toast').textContent)) window.__notices++; })
      .observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
  });
}
const h1Cards = p => p.evaluate(() => document.querySelectorAll('article.vb-turn').length);
const h1Hist = p => p.evaluate(() => window.__t.hist().length);
const h1Notices = p => p.evaluate(() => window.__notices);
async function h1Until(fn, ms = 25000, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; }
function h1Hold(p, pattern) {   // server SUDAH memproses (kredit terpotong); balasan ke halaman ditahan sampai release()
  const st = { entered: false, release: null }; const gate = new Promise(r => { st.release = r; });
  p.route(pattern, async route => { st.entered = true; const resp = await route.fetch(); await gate; await route.fulfill({ response: resp }); });
  return st;
}

test('H1-02: STT sedang berjalan saat sesi dihentikan: hasil dibuang, tanpa terjemahan, kredit STT tetap terpakai', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed); S.mock.sttDelay = 3000;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
    check('H1-02: STT mulai berjalan di server', await h1Until(async () => S.mock.inflight.stt === 1));
    const tr0 = S.mock.calls.translate;
    await p.click('#vbStop');
    check('H1-02: sesi berhenti (idle)', (await state(p)) === 'idle');
    await h1Until(async () => S.mock.completed.stt >= c0.stt + 1); await sleep(1200);
    check('H1-02: tidak ada panggilan terjemahan untuk giliran yang dibuang', S.mock.calls.translate === tr0, S.mock.calls.translate - tr0);
    check('H1-02: tidak ada kartu dan tidak ada riwayat', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0, (await h1Cards(p)) + '/' + (await h1Hist(p)));
    check('H1-02: pemberitahuan tampil tepat sekali', (await h1Notices(p)) === 1, await h1Notices(p));
    check('H1-02: kredit STT yang sudah terkirim TIDAK kembali otomatis (50-2)', (await S.api.credits(code)) === 48, await S.api.credits(code));
    check('H1-02: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  } finally { S.mock.sttDelay = 0; }
});

test('H1-01: giliran yang antre tidak pernah memulai STT setelah sesi dihentikan; pemberitahuan sekali meski ada dua giliran dibuang', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed); S.mock.sttDelay = 2500;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
    check('H1-01: STT pertama berjalan di server', await h1Until(async () => S.mock.inflight.stt === 1));
    const stt0 = S.mock.calls.stt;
    await p.evaluate(() => { const x = new Float32Array(48000 * 1.4); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000); window.__t.onThem(x, 48000, window.__t.analyzeFrames([x], 48000)); });
    check('H1-01: giliran kedua tersusun di antrean (kartu ada)', (await h1Cards(p)) >= 2, await h1Cards(p));
    await p.click('#vbStop');
    await h1Until(async () => S.mock.completed.stt >= c0.stt + 1); await sleep(1500);
    check('H1-01: STT tidak bertambah untuk giliran antre (hanya yang sudah berjalan)', S.mock.calls.stt === stt0, S.mock.calls.stt - stt0);
    check('H1-01: tidak ada kartu, riwayat kosong', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0);
    check('H1-01: pemberitahuan SEKALI per sesi walau dua giliran dibuang', (await h1Notices(p)) === 1, await h1Notices(p));
    check('H1-01: kredit hanya untuk STT yang sudah terkirim (50-2)', (await S.api.credits(code)) === 48, await S.api.credits(code));
  } finally { S.mock.sttDelay = 0; }
});

test('H1-03: terjemahan sedang berjalan saat sesi dihentikan: hasil dibuang, tanpa kartu/riwayat/suara', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  const hold = h1Hold(p, '**/api/translate');
  await startSession(p);
  check('H1-03: permintaan terjemahan sudah diproses server dan balasannya ditahan', await h1Until(async () => hold.entered && S.mock.completed.translate >= c0.translate + 1));
  const tts0 = S.mock.calls.tts, plays0 = await p.evaluate(() => window.__plays);
  await p.click('#vbStop'); await sleep(300); hold.release(); await sleep(1500);
  check('H1-03: tidak ada kartu dan tidak ada riwayat', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0, (await h1Cards(p)) + '/' + (await h1Hist(p)));
  check('H1-03: tidak ada suara diminta atau diputar', S.mock.calls.tts === tts0 && (await p.evaluate(() => window.__plays)) === plays0);
  check('H1-03: pemberitahuan sekali', (await h1Notices(p)) === 1, await h1Notices(p));
  check('H1-03: kredit tetap terpakai (50-3), tidak kembali otomatis', (await S.api.credits(code)) === 47, await S.api.credits(code));
  check('H1-03: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H1-04: TTS sedang berjalan saat sesi dihentikan: terjemahan selesai DIPERTAHANKAN, audio dibuang dan tidak diputar', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  await p.evaluate(() => { document.getElementById('mode').value = 'headset'; document.getElementById('mode').dispatchEvent(new Event('change')); });
  const hold = h1Hold(p, '**/api/tts');
  await startSession(p);
  check('H1-04: TTS sudah diproses server dan balasannya ditahan', await h1Until(async () => hold.entered && S.mock.completed.tts >= c0.tts + 1));
  const plays0 = await p.evaluate(() => window.__plays);
  await p.click('#vbStop'); await sleep(300); hold.release(); await sleep(1500);
  check('H1-04: kartu dengan terjemahan selesai dipertahankan (1 kartu, 1 riwayat)', (await h1Cards(p)) === 1 && (await h1Hist(p)) === 1, (await h1Cards(p)) + '/' + (await h1Hist(p)));
  check('H1-04: terjemahan di kartu terisi', (await txt(p, 'article.vb-turn.them [data-k="tr"]')) === 'Bisakah Anda menjelaskan proposal tersebut?');
  check('H1-04: audio hasil in-flight tidak diputar setelah sesi berhenti', (await p.evaluate(() => window.__plays)) === plays0, (await p.evaluate(() => window.__plays)) + ' vs ' + plays0);
  check('H1-04: tidak ada pesan "Suara gagal" pada kartu', !/Suara gagal/.test(await txt(p, 'article.vb-turn.them') || ''));
  check('H1-04: pemberitahuan sekali', (await h1Notices(p)) === 1, await h1Notices(p));
  check('H1-04: kredit (50-4: STT 2, terjemahan 1, suara 1) tidak kembali', (await S.api.credits(code)) === 46, await S.api.credits(code));
});

test('H1-05: hasil yang sudah selesai dipertahankan saat sesi dihentikan; tanpa pemberitahuan', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
  await waitCard(p, 'them', 30000); await sleep(800);
  await p.click('#vbStop'); await sleep(800);
  check('H1-05: kartu selesai tetap ada, riwayat 1', (await h1Cards(p)) === 1 && (await h1Hist(p)) === 1, (await h1Cards(p)) + '/' + (await h1Hist(p)));
  check('H1-05: isi kartu utuh', (await txt(p, 'article.vb-turn.them [data-k="tr"]')) === 'Bisakah Anda menjelaskan proposal tersebut?');
  check('H1-05: tidak ada pemberitahuan (tidak ada yang dibuang)', (await h1Notices(p)) === 0, await h1Notices(p));
  check('H1-05: kredit sesuai (50-3)', (await S.api.credits(code)) === 47, await S.api.credits(code));
});

test('H1-06: hasil sesi lama dibuang walau sesi baru sudah berjalan; sesi baru normal (TIDAK menegaskan maxInflight STT global)', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed); S.mock.sttDelay = 3000;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
    check('H1-06: STT sesi A berjalan', await h1Until(async () => S.mock.inflight.stt === 1));
    await p.click('#vbStop');
    await p.click('#vbMic');
    await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen' || document.getElementById('vbConsent').classList.contains('open'), null, { timeout: 8000 });
    if (await p.evaluate(() => document.getElementById('vbConsent').classList.contains('open'))) { await p.click('#vbConsentOk'); }
    await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 8000 });
    const trA = S.mock.calls.translate;
    await h1Until(async () => S.mock.completed.stt >= c0.stt + 1); await sleep(1200);
    check('H1-06: hasil sesi A dibuang: tidak ada terjemahan untuknya', S.mock.calls.translate === trA, S.mock.calls.translate - trA);
    check('H1-06: tidak ada kartu milik sesi A di daftar sesi B', (await p.evaluate(() => document.querySelectorAll('article.vb-turn.them [data-k="tr"]:not(.dim)').length)) === 0);
    check('H1-06: pemberitahuan sekali untuk sesi A', (await h1Notices(p)) === 1, await h1Notices(p));
    S.mock.sttDelay = 300;
    await waitCard(p, 'them', 40000);
    check('H1-06: sesi B menyelesaikan giliran normal', (await txt(p, 'article.vb-turn.them [data-k="tr"]')) === 'Bisakah Anda menjelaskan proposal tersebut?');
    check('H1-06: tidak ada galat JS', p.errors.length === 0, p.errors.join('|'));
  } finally { S.mock.sttDelay = 0; }
});

// ---------------------------------------------------------------------------------------------
// H1-c: penjaga retry. vbCall mencoba ulang sekali bila jaringan gagal. Setelah sesi dihentikan, percobaan ulang TIDAK boleh dikirim
// (bisa memotong kredit setelah sesi berhenti). Retry pada sesi yang masih hidup tetap bekerja.
// BATAS: request yang sudah sampai server tidak bisa dibatalkan; kredit yang terpakai tidak kembali otomatis.
function h1cFail(p, pattern, { reach }) {   // percobaan PERTAMA dijatuhkan; reach=true: server memproses dulu (balasan hilang), false: tidak pernah sampai
  const st = { n: 0, entered: false, release: null }; const gate = new Promise(r => { st.release = r; });
  p.route(pattern, async route => {
    st.n++;
    if (st.n === 1) { st.entered = true; if (reach) await route.fetch(); await gate; return route.abort('failed'); }
    return route.continue();
  });
  return st;
}
const h1cReqs = (p, re) => p.reqs.filter(r => re.test(r.url)).length;

test('H1c-00: vbCall dengan alive=false tidak mengirim permintaan sama sekali', async (b, S) => {
  const code = await S.api.mkCode(20);
  const p = await newPage(b, S); await connect(p, S, code);
  const n0 = h1cReqs(p, /\/api\/translate/), c0 = S.mock.calls.translate;
  const r = await p.evaluate(async () => { try { await window.__t.vbCall('/api/translate', { json: { text: 'halo', src: 'id', tgt: 'en' }, alive: () => false }); return 'terkirim'; } catch (e) { return 'stale=' + !!e.stale + ' vb=' + !!e.vb; } });
  check('H1c-00: ditolak sebagai stale tanpa jaringan', r === 'stale=true vb=true' && h1cReqs(p, /\/api\/translate/) === n0 && S.mock.calls.translate === c0, r);
  check('H1c-00: alive=true tetap mengirim', await p.evaluate(async () => { const r = await window.__t.vbCall('/api/translate', { json: { text: 'halo', src: 'id', tgt: 'en' }, alive: () => true }); return r.ok; }));
  check('H1c-00: kredit hanya untuk permintaan yang dikirim (20-1)', (await S.api.credits(code)) === 19, await S.api.credits(code));
});

test('H1c-01: terjemahan: percobaan pertama tidak sampai server, sesi dihentikan, retry TIDAK dikirim, kredit tidak terpotong lagi', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  const hold = h1cFail(p, '**/api/translate', { reach: false });
  await startSession(p);
  check('H1c-01: permintaan terjemahan pertama ditahan di browser', await h1Until(async () => hold.entered));
  const tr0 = S.mock.calls.translate;
  await p.click('#vbStop'); await sleep(300); hold.release(); await sleep(1800);
  check('H1c-01: hanya SATU permintaan terjemahan keluar dari halaman (tanpa retry)', h1cReqs(p, /\/api\/translate/) === 1, h1cReqs(p, /\/api\/translate/));
  check('H1c-01: server tidak pernah menerima terjemahan', S.mock.calls.translate === tr0, S.mock.calls.translate - tr0);
  check('H1c-01: tidak ada kartu dan riwayat; pemberitahuan sekali', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0 && (await h1Notices(p)) === 1, (await h1Cards(p)) + '/' + (await h1Hist(p)) + '/' + (await h1Notices(p)));
  check('H1c-01: kredit hanya STT (50-2), terjemahan tidak dipotong setelah sesi berhenti', (await S.api.credits(code)) === 48, await S.api.credits(code));
  check('H1c-01: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H1c-02: terjemahan: balasan hilang setelah server memproses, sesi dihentikan, retry TIDAK dikirim (tanpa replay), kredit tidak kembali', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  const hold = h1cFail(p, '**/api/translate', { reach: true });
  await startSession(p);
  check('H1c-02: server sudah memproses terjemahan pertama', await h1Until(async () => hold.entered && S.mock.completed.translate >= 1));
  await p.click('#vbStop'); await sleep(300); hold.release(); await sleep(1800);
  check('H1c-02: hanya SATU permintaan keluar dari halaman, tidak ada balasan idempotent-replay', h1cReqs(p, /\/api\/translate/) === 1 && !p.resps.some(r => /\/api\/translate/.test(r.url) && r.h['idempotent-replay'] === 'true'), h1cReqs(p, /\/api\/translate/));
  check('H1c-02: tidak ada kartu dan riwayat; pemberitahuan sekali', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0 && (await h1Notices(p)) === 1);
  check('H1c-02: kredit yang sudah terpakai TIDAK kembali otomatis (50-3)', (await S.api.credits(code)) === 47, await S.api.credits(code));
});

test('H1c-03: STT: percobaan pertama tidak sampai server, sesi dihentikan, retry TIDAK dikirim, kredit utuh', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  const hold = h1cFail(p, '**/api/stt**', { reach: false });
  await startSession(p);
  check('H1c-03: permintaan STT pertama ditahan di browser', await h1Until(async () => hold.entered));
  const stt0 = S.mock.calls.stt;
  await p.click('#vbStop'); await sleep(300); hold.release(); await sleep(1800);
  check('H1c-03: hanya SATU permintaan STT keluar dari halaman', h1cReqs(p, /\/api\/stt/) === 1, h1cReqs(p, /\/api\/stt/));
  check('H1c-03: server tidak menerima STT; kredit utuh (50)', S.mock.calls.stt === stt0 && (await S.api.credits(code)) === 50, S.mock.calls.stt - stt0);
  check('H1c-03: pemberitahuan sekali; tidak ada kartu', (await h1Notices(p)) === 1 && (await h1Cards(p)) === 0);
});

test('H1c-04: TTS: percobaan pertama tidak sampai server, sesi dihentikan, retry TIDAK dikirim; terjemahan selesai dipertahankan', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  await p.evaluate(() => { document.getElementById('mode').value = 'headset'; document.getElementById('mode').dispatchEvent(new Event('change')); });
  const hold = h1cFail(p, '**/api/tts', { reach: false });
  await startSession(p);
  check('H1c-04: permintaan TTS pertama ditahan di browser', await h1Until(async () => hold.entered));
  const tts0 = S.mock.calls.tts, plays0 = await p.evaluate(() => window.__plays);
  await p.click('#vbStop'); await sleep(300); hold.release(); await sleep(1800);
  check('H1c-04: hanya SATU permintaan TTS keluar dari halaman; server tidak menerima TTS', h1cReqs(p, /\/api\/tts/) === 1 && S.mock.calls.tts === tts0, h1cReqs(p, /\/api\/tts/));
  check('H1c-04: kartu selesai dipertahankan, tidak ada suara diputar', (await h1Cards(p)) === 1 && (await h1Hist(p)) === 1 && (await p.evaluate(() => window.__plays)) === plays0);
  check('H1c-04: kredit hanya STT+terjemahan (50-3); pemberitahuan sekali', (await S.api.credits(code)) === 47 && (await h1Notices(p)) === 1, await S.api.credits(code));
});

test('H1c-05: regresi: retry pada sesi yang MASIH hidup tetap bekerja (percobaan pertama jatuh sebelum server, retry sukses)', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  const hold = h1cFail(p, '**/api/translate', { reach: false });
  await startSession(p);
  check('H1c-05: percobaan pertama ditahan', await h1Until(async () => hold.entered));
  hold.release();
  await waitCard(p, 'them', 30000);
  check('H1c-05: retry dikirim (2 permintaan dari halaman) dan berhasil', h1cReqs(p, /\/api\/translate/) === 2, h1cReqs(p, /\/api\/translate/));
  check('H1c-05: terjemahan tampil; kredit dipotong sekali (50-3)', (await txt(p, 'article.vb-turn.them [data-k="tr"]')) === 'Bisakah Anda menjelaskan proposal tersebut?' && (await S.api.credits(code)) === 47, await S.api.credits(code));
  check('H1c-05: tanpa pemberitahuan pembuangan', (await h1Notices(p)) === 0);
});

// ---------------------------------------------------------------------------------------------
// KOREKSI-A (temuan audit VB-PATCH-01/02/04): Hapus sesi, kepemilikan state oleh giliran, deduplikasi notifikasi lintas sesi.
// Aturan: pekerjaan yang dimulai SEBELUM "Hapus sesi" tidak boleh menulis kartu, riwayat, konteks terjemahan, atau memutar audio SESUDAHNYA,
// tetapi sesi tetap hidup dan mendengar lagi. Hasil yang tiba setelah sesi lama berakhir tidak boleh mengubah speaking/Conv.cool milik sesi baru.
const kClear = p => p.evaluate(() => document.getElementById('btnDelSession').click());
const kSpeech = (p, side) => p.evaluate(s => { const x = new Float32Array(48000 * 1.5); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000); (s === 'me' ? window.__t.onMeSpeech : window.__t.onThem)(x, 48000, window.__t.analyzeFrames([x], 48000)); }, side);
const kHeadset = p => p.evaluate(() => { document.getElementById('mode').value = 'headset'; document.getElementById('mode').dispatchEvent(new Event('change')); });
const kCtx = p => p.evaluate(() => window.__t.Conv.on);

test('KA-01: Hapus sesi saat STT berjalan: hasil lama tidak muncul lagi (kartu/riwayat/terjemahan), sesi tetap hidup', async (b, S) => {
  const code = await S.api.mkCode(50); const c0 = Object.assign({}, S.mock.completed); S.mock.sttDelay = 3000;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
    check('KA-01: STT berjalan di server', await h1Until(async () => S.mock.inflight.stt === 1));
    const tr0 = S.mock.calls.translate;
    const oldId = await p.evaluate(() => { const a = document.querySelector('article.vb-turn'); return a && a.dataset.id; });
    await kClear(p);
    check('KA-01: setelah Hapus: tidak ada kartu', (await h1Cards(p)) === 0, await h1Cards(p));
    await h1Until(async () => S.mock.completed.stt >= c0.stt + 1); await sleep(1500);
    check('KA-01: tidak ada terjemahan diminta untuk giliran yang dihapus', S.mock.calls.translate === tr0, S.mock.calls.translate - tr0);
    check('KA-01: kartu lama tidak muncul lagi dan tidak masuk riwayat (dinilai per id)', !!oldId && (await p.evaluate(id => !document.querySelector('[data-id="' + id + '"]') && window.__t.hist().every(h => h.id !== id), oldId)), oldId);
    check('KA-01: sesi tetap hidup dan mendengar (listen)', (await kCtx(p)) === true && (await state(p)) === 'listen', await state(p));
    check('KA-01: pemberitahuan pembuangan tepat sekali', (await h1Notices(p)) === 1, await h1Notices(p));
    S.mock.sttDelay = 300;
    await waitCard(p, 'them', 40000);
    check('KA-01: giliran BARU setelah Hapus tetap jalan normal (1 kartu, 1 riwayat)', (await h1Cards(p)) === 1 && (await h1Hist(p)) === 1, (await h1Cards(p)) + '/' + (await h1Hist(p)));
    check('KA-01: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  } finally { S.mock.sttDelay = 0; }
});

test('KA-02: Hapus sesi saat terjemahan berjalan: tidak ada kartu, riwayat, konteks, atau suara', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await kHeadset(p);
  const hold = h1Hold(p, '**/api/translate');
  await startSession(p);
  check('KA-02: terjemahan diproses server, balasan ditahan', await h1Until(async () => hold.entered && S.mock.completed.translate >= 1));
  const tts0 = S.mock.calls.tts, plays0 = await p.evaluate(() => window.__plays);
  await kClear(p); hold.release(); await sleep(1800);
  check('KA-02: tidak ada kartu dan tidak ada riwayat', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0, (await h1Cards(p)) + '/' + (await h1Hist(p)));
  check('KA-02: tidak ada TTS diminta dan tidak ada audio diputar', S.mock.calls.tts === tts0 && (await p.evaluate(() => window.__plays)) === plays0, S.mock.calls.tts - tts0);
  check('KA-02: konteks terjemahan berikutnya tidak membawa giliran yang dihapus', await p.evaluate(() => window.__t.hist().length === 0 && window.__t.CONV.length === 0));
  check('KA-02: pemberitahuan sekali', (await h1Notices(p)) === 1, await h1Notices(p));
  check('KA-02: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('KA-03: Hapus sesi saat TTS in-flight: audio lama tidak diputar, kartu tidak kembali', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await kHeadset(p);
  const hold = h1Hold(p, '**/api/tts');
  await startSession(p);
  check('KA-03: TTS diproses server, balasan ditahan', await h1Until(async () => hold.entered && S.mock.completed.tts >= 1));
  const plays0 = await p.evaluate(() => window.__plays);
  await kClear(p); hold.release(); await sleep(1800);
  check('KA-03: audio hasil in-flight TIDAK diputar', (await p.evaluate(() => window.__plays)) === plays0, (await p.evaluate(() => window.__plays)) + ' vs ' + plays0);
  check('KA-03: tidak ada kartu, riwayat kosong', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0, (await h1Cards(p)) + '/' + (await h1Hist(p)));
  check('KA-03: speaking dilepas dan sesi mendengar lagi (listen)', (await p.evaluate(() => window.__t.getSpeaking())) === false && (await state(p)) === 'listen', await state(p));
  check('KA-03: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('KA-04: Hapus sesi saat retry tertahan: tidak ada permintaan baru setelah Hapus', async (b, S) => {
  const code = await S.api.mkCode(50);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p);
  const hold = h1cFail(p, '**/api/translate', { reach: false });
  await startSession(p);
  check('KA-04: percobaan pertama ditahan', await h1Until(async () => hold.entered));
  const tr0 = S.mock.calls.translate;
  await kClear(p); await sleep(300); hold.release(); await sleep(1800);
  check('KA-04: hanya SATU permintaan terjemahan keluar (tanpa retry)', h1cReqs(p, /\/api\/translate/) === 1 && S.mock.calls.translate === tr0, h1cReqs(p, /\/api\/translate/));
  check('KA-04: tidak ada kartu dan riwayat', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0);
  check('KA-04: kredit hanya STT (50-2); tidak terpotong setelah Hapus', (await S.api.credits(code)) === 48, await S.api.credits(code));
});

test('KA-05: Hapus sesi saat giliran Saya (state proc): state pulih ke listen, tombol aktif, Saya Bicara bisa dipakai lagi', async (b, S) => {
  const code = await S.api.mkCode(50); S.mock.sttDelay = 2500;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
    await p.click('#vbMic'); check('KA-05: state me', (await state(p)) === 'me');
    await kSpeech(p, 'me');
    const oldId = await p.evaluate(() => { const a = document.querySelector('article.vb-turn.me'); return a && a.dataset.id; });
    check('KA-05: state proc', (await state(p)) === 'proc', await state(p));
    await kClear(p);
    check('KA-05: setelah Hapus state pulih ke listen (tidak macet di proc)', await h1Until(async () => (await state(p)) === 'listen', 1200), await state(p));
    check('KA-05: tombol utama tidak disabled', (await p.evaluate(() => document.getElementById('vbMic').disabled)) === false);
    await h1Until(async () => S.mock.inflight.stt === 0, 8000); await sleep(1500);
    check('KA-05: hasil STT lama tidak memunculkan kartu/riwayat (dinilai per id)', !!oldId && (await p.evaluate(id => !document.querySelector('[data-id="' + id + '"]') && window.__t.hist().every(h => h.id !== id), oldId)), oldId);
    check('KA-05: hasil lama tidak mengubah state sesi yang sudah pulih (tetap listen)', (await state(p)) === 'listen', await state(p));
    await p.click('#vbMic'); check('KA-05: Saya Bicara bisa dimulai lagi (state me)', (await state(p)) === 'me', await state(p));
    check('KA-05: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  } finally { S.mock.sttDelay = 0; }
});

test('KA-06: giliran BARU setelah Hapus tidak ikut dibuang dan tidak tercampur dengan giliran lama', async (b, S) => {
  const code = await S.api.mkCode(50); S.mock.sttDelay = 2500;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p);
    check('KA-06: STT lama berjalan', await h1Until(async () => S.mock.inflight.stt === 1));
    await kClear(p); S.mock.sttDelay = 200;
    await kSpeech(p, 'them');   // giliran baru, antre di belakang yang lama
    await h1Until(async () => (await h1Hist(p)) >= 1, 30000); await sleep(1200);
    check('KA-06: tepat satu kartu selesai dan satu riwayat (milik giliran baru)', (await h1Hist(p)) === 1 && (await p.evaluate(() => document.querySelectorAll('article.vb-turn [data-k="tr"]:not(.dim)').length)) === 1, (await h1Hist(p)) + '/' + (await h1Cards(p)));
    check('KA-06: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
  } finally { S.mock.sttDelay = 0; }
});

test('KA-07: speakFor: pemutaran lama yang selesai TERLAMBAT (stop lalu start cepat) tidak mengubah speaking/Conv.cool sesi baru', async (b, S) => {
  const code = await S.api.mkCode(60);
  const p = await newPage(b, S, { init: () => { HTMLMediaElement.prototype.pause = function () {}; HTMLMediaElement.prototype.play = function () { window.__plays++; return Promise.resolve(); }; } });
  await connect(p, S, code); await kHeadset(p); await startSession(p);
  check('KA-07: sesi A: pemutaran dimulai dan tertahan (pause ditiadakan)', await h1Until(async () => (await p.evaluate(() => window.__plays)) >= 1 && (await p.evaluate(() => window.__t.getSpeaking())) === true));
  await p.click('#vbStop');
  await p.evaluate(() => { document.getElementById('mode').value = 'text'; document.getElementById('mode').dispatchEvent(new Event('change')); });
  await p.click('#vbMic');
  await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen' || document.getElementById('vbConsent').classList.contains('open'), null, { timeout: 8000 });
  if (await p.evaluate(() => document.getElementById('vbConsent').classList.contains('open'))) await p.click('#vbConsentOk');
  await p.waitForFunction(() => document.getElementById('vbStatus').dataset.s === 'listen', null, { timeout: 8000 });
  await p.evaluate(() => { window.__t.setSpeaking(true); window.__t.Conv.cool = 0; });   // keadaan sesi B: sedang berbicara sendiri
  await p.evaluate(() => window.__t.player.onended && window.__t.player.onended());     // pemutaran sesi A baru selesai sekarang
  await sleep(500);
  check('KA-07: speaking milik sesi B tidak dilepas oleh sesi A', (await p.evaluate(() => window.__t.getSpeaking())) === true);
  check('KA-07: Conv.cool milik sesi B tidak diubah oleh sesi A', (await p.evaluate(() => window.__t.Conv.cool)) === 0, await p.evaluate(() => window.__t.Conv.cool));
  check('KA-07: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('KA-08: speakFor: Hapus sesi saat audio diputar menghentikan pemutaran; selesai terlambat tidak mengubah state', async (b, S) => {
  const code = await S.api.mkCode(60);
  const p = await newPage(b, S, { init: () => { HTMLMediaElement.prototype.pause = function () {}; HTMLMediaElement.prototype.play = function () { window.__plays++; return Promise.resolve(); }; } });
  await connect(p, S, code); await kHeadset(p); await startSession(p);
  check('KA-08: audio diputar (tertahan)', await h1Until(async () => (await p.evaluate(() => window.__plays)) >= 1 && (await p.evaluate(() => window.__t.getSpeaking())) === true));
  await kClear(p);
  check('KA-08: setelah Hapus: speaking dilepas dan state pulih ke listen', await h1Until(async () => (await p.evaluate(() => window.__t.getSpeaking())) === false && (await state(p)) === 'listen', 3000), await state(p));
  await p.evaluate(() => { window.__t.setSpeaking(true); window.__t.Conv.cool = 0; });   // giliran baru mulai berbicara
  await p.evaluate(() => window.__t.player.onended && window.__t.player.onended());     // pemutaran lama selesai terlambat
  await sleep(500);
  check('KA-08: pemutaran lama yang terlambat tidak melepas speaking giliran baru', (await p.evaluate(() => window.__t.getSpeaking())) === true);
  check('KA-08: Conv.cool tidak diubah oleh pemutaran lama', (await p.evaluate(() => window.__t.Conv.cool)) === 0, await p.evaluate(() => window.__t.Conv.cool));
});

test('KA-09: notifikasi pembuangan: dedup lintas sesi bila hasil berselang-seling A,B,A', async (b, S) => {
  const p = await newPage(b, S); await h1Watch(p);
  await p.evaluate(async () => { const n = window.__t.noteDiscard, w = () => new Promise(r => setTimeout(r, 40)); for (const g of [101, 102, 101, 102, 101]) { n(g, 0); await w(); } });
  await sleep(300);
  check('KA-09: A,B,A,B,A menghasilkan tepat 2 pemberitahuan (satu per sesi), bukan 5', (await h1Notices(p)) === 2, await h1Notices(p));
  await sleep(4200);
  await p.evaluate(() => { for (let g = 200; g < 400; g++) window.__t.noteDiscard(g, 0); });
  check('KA-09: catatan sesi yang sudah diberitahu dibatasi ukurannya (<= 64)', await p.evaluate(() => typeof window.__t.noticedSize === 'function' && window.__t.noticedSize() <= 64 && window.__t.noticedSize() > 0), await p.evaluate(() => typeof window.__t.noticedSize));
});

test('KA-10: pemberitahuan menyebut penyebab yang benar (Hapus sesi vs sesi dihentikan)', async (b, S) => {
  const code = await S.api.mkCode(50); S.mock.sttDelay = 2000;
  try {
    const p = await newPage(b, S); await connect(p, S, code); await startSession(p);
    check('KA-10: STT berjalan', await h1Until(async () => S.mock.inflight.stt === 1));
    await kClear(p);
    await p.waitForFunction(() => /dibuang/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    const t = await txt(p, '#toast');
    check('KA-10: setelah Hapus sesi, pesan tidak menyebut "Sesi dihentikan"', /dihapus/i.test(t) && !/Sesi dihentikan/.test(t), t);
  } finally { S.mock.sttDelay = 0; }
});

// ---------------------------------------------------------------------------------------------
// H2-A: aksi per kartu (Terjemahkan ulang, Putar ulang). Aturan: hasil operasi lama tidak boleh menulis kartu, riwayat, konteks,
// rec.audio, memutar audio, atau mengubah speaking/Conv.cool milik operasi lain; edit TERBARU menang; tidak ada retry setelah invalidasi.
// BATAS: request yang sudah terkirim tidak dapat dibatalkan dan kreditnya tidak kembali otomatis.
const h2Sentinel = 3.6e6;
async function h2Card(b, S) {   // satu kartu "lawan" selesai; giliran otomatis berikutnya dikunci (Conv.cool jauh di depan) agar tes deterministik
  const code = await S.api.mkCode(60);
  const p = await newPage(b, S); await connect(p, S, code); await h1Watch(p); await startSession(p); await waitCard(p, 'them', 40000);
  await p.evaluate(ms => { window.__t.Conv.cool = Date.now() + ms; }, h2Sentinel);
  return { p, code };
}
const h2Cool = p => p.evaluate(() => window.__t.Conv.cool);
const h2Plays = p => p.evaluate(() => window.__plays);
const h2Rec = p => p.evaluate(() => { const r = window.__t.CONV[0]; return r && { heard: r.heard, translation: r.translation, corrected: r.corrected, hasAudio: !!r.audio }; });
const h2Chip = p => p.evaluate(() => { const c = document.querySelector('article.vb-turn [data-k="chip"]'); return c ? c.textContent : null; });
const h2Orig = p => txt(p, 'article.vb-turn [data-k="orig"]');
const h2Tr = p => txt(p, 'article.vb-turn [data-k="tr"]');
async function h2Edit(p, text) {
  await p.click('article.vb-turn [data-a="edit"]'); await p.fill('article.vb-turn .vb-edit textarea', text); await p.click('article.vb-turn .vb-edit .pri');
}
const h2Play = p => p.click('article.vb-turn [data-a="play"]');
function h2Hold(p, pattern, pred) {   // balasan ditahan hanya untuk permintaan yang cocok pred(postData); lainnya lewat
  const st = { entered: 0, release: null }; const gate = new Promise(r => { st.release = r; });
  p.route(pattern, async route => {
    if (!pred(route.request().postData() || '')) return route.continue();
    st.entered++; const resp = await route.fetch(); await gate; await route.fulfill({ response: resp });
  });
  return st;
}
const h2Badge = async p => { const m = /(\d+) kredit/.exec(await txt(p, '#planBadge') || ''); return m ? +m[1] : null; };

test('H2A-01: Hapus sesi saat Terjemahkan ulang in-flight: kartu tidak kembali, riwayat/konteks bersih, kredit tetap akurat', async (b, S) => {
  const { p, code } = await h2Card(b, S);
  const hold = h2Hold(p, '**/api/translate', d => /EditSatu/.test(d));
  await h2Edit(p, 'EditSatu');
  check('H2A-01: terjemahan ulang diproses server, balasan ditahan', await h1Until(async () => hold.entered === 1));
  await kClear(p); hold.release(); await sleep(900);
  check('H2A-01: tidak ada kartu, riwayat, dan konteks', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0 && (await p.evaluate(() => window.__t.CONV.length)) === 0, (await h1Cards(p)) + '/' + (await h1Hist(p)));
  check('H2A-01: pemberitahuan pembuangan tepat sekali', (await h1Notices(p)) === 1, await h1Notices(p));
  check('H2A-01: kredit di lencana = kredit server (respons lama tetap mencatat saldo)', (await h2Badge(p)) === (await S.api.credits(code)), (await h2Badge(p)) + ' vs ' + (await S.api.credits(code)));
  check('H2A-01: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-02: edit A lalu edit B (balasan B lebih dulu): yang terbaru menang', async (b, S) => {
  const { p } = await h2Card(b, S);
  const hold = h2Hold(p, '**/api/translate', d => /EditAAA/.test(d));
  await h2Edit(p, 'EditAAA');
  check('H2A-02: edit A diproses server, balasan ditahan', await h1Until(async () => hold.entered === 1));
  await h2Edit(p, 'EditBBB');
  check('H2A-02: edit B selesai lebih dulu', await h1Until(async () => (await h2Tr(p)) === 'T:EditBBB'), await h2Tr(p));
  hold.release(); await sleep(900);
  const r = await h2Rec(p), h = await p.evaluate(() => window.__t.hist().map(x => [x.orig, x.tr]));
  check('H2A-02: balasan A yang terlambat TIDAK menimpa kartu', (await h2Tr(p)) === 'T:EditBBB' && (await h2Orig(p)) === 'EditBBB' && r.translation === 'T:EditBBB' && r.heard === 'EditBBB', JSON.stringify(r));
  check('H2A-02: riwayat terjemahan memuat edit B, bukan A', h.length === 1 && h[0][0] === 'EditBBB' && h[0][1] === 'T:EditBBB', JSON.stringify(h));
  check('H2A-02: chip menunjukkan "Dikoreksi"', (await h2Chip(p)) === 'Dikoreksi', await h2Chip(p));
  check('H2A-02: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-03: Hapus sesi saat TTS putar-ulang tertahan: audio lama tidak diputar, speaking/cool milik operasi lain tidak diubah', async (b, S) => {
  const { p } = await h2Card(b, S);
  const hold = h2Hold(p, '**/api/tts', () => true);
  await h2Play(p);
  check('H2A-03: TTS diproses server, balasan ditahan', await h1Until(async () => hold.entered === 1));
  const plays0 = await h2Plays(p);
  await kClear(p);
  await p.evaluate(ms => { window.__t.setSpeaking(true); window.__t.Conv.cool = Date.now() + ms; }, h2Sentinel);   // simulasi operasi BARU yang memegang speaking/cool
  const cool0 = await h2Cool(p);
  hold.release(); await sleep(900);
  check('H2A-03: audio hasil in-flight TIDAK diputar', (await h2Plays(p)) === plays0, (await h2Plays(p)) + ' vs ' + plays0);
  check('H2A-03: speaking dan Conv.cool milik operasi baru tidak disentuh', (await p.evaluate(() => window.__t.getSpeaking())) === true && (await h2Cool(p)) === cool0);
  check('H2A-03: kartu tidak kembali', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0);
  check('H2A-03: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-04: Hentikan sesi saat TTS putar-ulang tertahan: tidak diputar, chip tidak macet, audio tidak tersimpan', async (b, S) => {
  const { p } = await h2Card(b, S);
  const hold = h2Hold(p, '**/api/tts', () => true);
  await h2Play(p);
  check('H2A-04: TTS ditahan', await h1Until(async () => hold.entered === 1));
  const plays0 = await h2Plays(p);
  await p.click('#vbStop'); hold.release(); await sleep(900);
  check('H2A-04: audio hasil in-flight TIDAK diputar', (await h2Plays(p)) === plays0, (await h2Plays(p)) + ' vs ' + plays0);
  check('H2A-04: audio tidak disimpan ke kartu', (await h2Rec(p)).hasAudio === false);
  check('H2A-04: chip tidak macet "Menyiapkan suara…"/"Memutar…"', !/Menyiapkan|Memutar/.test(await h2Chip(p)), await h2Chip(p));
  check('H2A-04: speaking dilepas', (await p.evaluate(() => window.__t.getSpeaking())) === false);
  check('H2A-04: pemberitahuan sekali', (await h1Notices(p)) === 1, await h1Notices(p));
  check('H2A-04: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-05: retry setelah invalidasi: Hapus saat percobaan pertama terjemahan ulang tertahan tidak memicu permintaan baru', async (b, S) => {
  const { p } = await h2Card(b, S);
  const drop = h1cFail(p, '**/api/translate', { reach: false });
  await h2Edit(p, 'EditRetry');
  check('H2A-05: percobaan pertama ditahan', await h1Until(async () => drop.entered));
  const n0 = h1cReqs(p, /\/api\/translate/);
  await kClear(p); await sleep(200); drop.release(); await sleep(1500);
  check('H2A-05: tidak ada permintaan terjemahan baru (tanpa retry)', h1cReqs(p, /\/api\/translate/) === n0, h1cReqs(p, /\/api\/translate/) - n0);
  check('H2A-05: tidak ada kartu dan riwayat', (await h1Cards(p)) === 0 && (await h1Hist(p)) === 0);
});

test('H2A-06: ketuk ▶ saat edit berjalan tidak boleh membuang hasil edit', async (b, S) => {
  const { p } = await h2Card(b, S);
  const hold = h2Hold(p, '**/api/translate', d => /EditEnam/.test(d));
  await h2Edit(p, 'EditEnam');
  check('H2A-06: edit ditahan', await h1Until(async () => hold.entered === 1));
  await h2Play(p);
  check('H2A-06: putar ulang (terjemahan lama) selesai', await h1Until(async () => !(await p.evaluate(() => window.__t.getSpeaking()))) && (await h2Plays(p)) >= 1);
  hold.release();
  check('H2A-06: hasil edit tetap diterapkan', await h1Until(async () => (await h2Tr(p)) === 'T:EditEnam'), await h2Tr(p));
  check('H2A-06: riwayat memuat edit', await p.evaluate(() => window.__t.hist().some(x => x.tr === 'T:EditEnam')));
  check('H2A-06: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-07: TTS putar-ulang tertahan lalu edit selesai: audio lama tidak disimpan ataupun diputar', async (b, S) => {
  const { p } = await h2Card(b, S);
  const hold = h2Hold(p, '**/api/tts', () => true);
  await h2Play(p);
  check('H2A-07: TTS (terjemahan lama) ditahan', await h1Until(async () => hold.entered === 1));
  const plays0 = await h2Plays(p);
  await h2Edit(p, 'EditTujuh');
  check('H2A-07: edit selesai', await h1Until(async () => (await h2Tr(p)) === 'T:EditTujuh'), await h2Tr(p));
  hold.release(); await sleep(900);
  check('H2A-07: audio terjemahan lama TIDAK diputar', (await h2Plays(p)) === plays0, (await h2Plays(p)) + ' vs ' + plays0);
  check('H2A-07: rec.audio tidak berisi audio terjemahan lama', (await h2Rec(p)).hasAudio === false);
  check('H2A-07: speaking dilepas', (await p.evaluate(() => window.__t.getSpeaking())) === false);
  check('H2A-07: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-08: Hentikan sesi saat Terjemahkan ulang in-flight: hasil dibuang, kartu kembali ke teks semula, chip tidak macet', async (b, S) => {
  const { p } = await h2Card(b, S);
  const before = await h2Rec(p);
  const hold = h2Hold(p, '**/api/translate', d => /EditDelapan/.test(d));
  await h2Edit(p, 'EditDelapan');
  check('H2A-08: edit ditahan', await h1Until(async () => hold.entered === 1));
  await p.click('#vbStop'); hold.release(); await sleep(900);
  const r = await h2Rec(p);
  check('H2A-08: terjemahan dan teks asli kembali seperti sebelum edit', r.translation === before.translation && r.heard === before.heard && (await h2Orig(p)) === before.heard && (await h2Tr(p)) === before.translation, JSON.stringify(r));
  check('H2A-08: chip tidak macet "Menerjemahkan ulang…"', !/Menerjemahkan/.test(await h2Chip(p)), await h2Chip(p));
  check('H2A-08: riwayat tidak berubah', await p.evaluate(b0 => window.__t.hist().every(x => x.tr === b0), before.translation));
  check('H2A-08: pemberitahuan sekali', (await h1Notices(p)) === 1, await h1Notices(p));
  check('H2A-08: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2A-09: jalur normal tidak berubah: edit selesai, riwayat diperbarui, putar ulang memutar audio baru', async (b, S) => {
  const { p, code } = await h2Card(b, S);
  const tts0 = S.mock.calls.tts, plays0 = await h2Plays(p);
  await h2Edit(p, 'EditNormal');
  check('H2A-09: terjemahan diperbarui, ditandai dikoreksi', await h1Until(async () => (await h2Tr(p)) === 'T:EditNormal') && (await h2Rec(p)).corrected === true && (await h2Chip(p)) === 'Dikoreksi');
  check('H2A-09: riwayat diperbarui', await p.evaluate(() => window.__t.hist().some(x => x.orig === 'EditNormal' && x.tr === 'T:EditNormal')));
  await h2Play(p);
  check('H2A-09: audio diminta dan diputar', await h1Until(async () => S.mock.calls.tts === tts0 + 1 && (await h2Plays(p)) === plays0 + 1), S.mock.calls.tts - tts0);
  check('H2A-09: speaking dilepas, chip bersih', await h1Until(async () => !(await p.evaluate(() => window.__t.getSpeaking())) && (await h2Chip(p)) === 'Dikoreksi' || (await h2Chip(p)) === ''), await h2Chip(p));
  check('H2A-09: kredit lencana = kredit server', (await h2Badge(p)) === (await S.api.credits(code)));
  check('H2A-09: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

// ---------------------------------------------------------------------------------------------
// H2-B: QA Lab punya identitas operasi sendiri (QA.run), TERPISAH dari Conv.gen/Conv.epoch (alur berbeda dari percakapan).
// Aturan: Berhenti / ganti dialog / sesi penguji baru / hapus catatan / rekam baru saat STT, terjemahan, atau TTS masih berjalan harus mencegah hasil usang
// menulis LOG, history, laporan, UI, atau memutar audio, dan tidak boleh memicu permintaan/retry baru. Penyerahan hasil otomatis oleh VAD (Listen.once) tetap sah.
// BATAS: request yang sudah terkirim tidak dapat dibatalkan dan kreditnya tidak kembali otomatis.
const h2bInit = () => { const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async c => { if (window.__gumDelay) await new Promise(r => setTimeout(r, window.__gumDelay)); return g(c); }; };
async function h2bLab(b, S, opts) {
  const code = await S.api.mkCode(60);
  const p = await newPage(b, S, opts); await connect(p, S, code);
  await p.click('#btnSettings'); await p.click('summary:has-text("Alat uji")'); await p.click('#btnOpenLab');
  await p.fill('#testerName', 'Penguji H2');
  return { p, code };
}
function h2bHold(p, pattern, nth) {   // hanya permintaan ke-nth yang balasannya ditahan (server tetap memproses); lainnya lewat
  const st = { n: 0, entered: false, release: null }; const gate = new Promise(r => { st.release = r; });
  p.route(pattern, async route => {
    const my = ++st.n; if (my !== nth) return route.continue();
    st.entered = true; const resp = await route.fetch(); await gate; await route.fulfill({ response: resp });
  });
  return st;
}
const h2bLog = p => p.evaluate(() => JSON.parse(localStorage.getItem('tr_log') || '[]'));
const h2bMem = p => p.evaluate(() => window.__t.LOG().length);
const h2bStatus = p => txt(p, '#scriptStatus');
const h2bResult = async p => (await txt(p, '#scriptResult') || '').length;
const h2bReqs = (p, re) => p.reqs.filter(r => re.test(r.url)).length;
const h2bLive = p => p.evaluate(() => window.__streams.filter(s => s.getTracks().some(t => t.readyState === 'live')).length);

test('H2B-01: Berhenti saat STT in-flight lalu Rekam lagi: hasil STT lama tidak diserahkan ke rekaman baru', async (b, S) => {
  const { p } = await h2bLab(b, S);
  const hold = h2bHold(p, '**/api/stt**', 1);
  await p.click('#btnRec');
  check('H2B-01: STT pertama diproses server, balasan ditahan', await h1Until(async () => hold.entered, 40000));
  await p.click('#btnRec');                                   // Berhenti
  await p.click('#btnRec');                                   // Rekam baru
  check('H2B-01: rekaman baru mendengarkan', await h1Until(async () => await p.evaluate(() => window.__t.Listen.active)), 8000);
  const tr0 = h2bReqs(p, /\/api\/translate/);
  hold.release(); await sleep(700);
  check('H2B-01: hasil STT lama TIDAK memicu terjemahan', h2bReqs(p, /\/api\/translate/) === tr0, h2bReqs(p, /\/api\/translate/) - tr0);
  check('H2B-01: tidak ada catatan, status bukan "Menerjemahkan…"', (await h2bMem(p)) === 0 && !/Menerjemahkan/.test(await h2bStatus(p)), await h2bStatus(p));
  check('H2B-01: rekaman baru masih mendengarkan (tidak dihentikan oleh hasil lama)', await p.evaluate(() => window.__t.Listen.active));
  check('H2B-01: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-02: ganti dialog saat terjemahan in-flight: tidak ada catatan, history, hasil, atau suara', async (b, S) => {
  const { p } = await h2bLab(b, S);
  await p.check('#testSpeak');
  const hold = h2bHold(p, '**/api/translate', 1);
  await p.click('#btnRec');
  check('H2B-02: terjemahan diproses server, balasan ditahan', await h1Until(async () => hold.entered, 40000));
  const tts0 = S.mock.calls.tts, plays0 = await h2Plays(p), hist0 = await h1Hist(p);
  await p.selectOption('#scriptSel', 'B'); hold.release(); await sleep(900);
  check('H2B-02: tidak ada catatan (LOG di memori dan localStorage)', (await h2bMem(p)) === 0 && (await h2bLog(p)).length === 0, (await h2bMem(p)) + '/' + (await h2bLog(p)).length);
  check('H2B-02: history terjemahan tidak bertambah', (await h1Hist(p)) === hist0, (await h1Hist(p)) + ' vs ' + hist0);
  check('H2B-02: UI tidak menulis hasil/status "Selesai"', (await h2bResult(p)) === 0 && !/Selesai|Menerjemahkan/.test(await h2bStatus(p)), await h2bStatus(p));
  check('H2B-02: tidak ada TTS diminta dan tidak ada audio diputar', S.mock.calls.tts === tts0 && (await h2Plays(p)) === plays0, S.mock.calls.tts - tts0);
  check('H2B-02: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-03: Hapus catatan saat terjemahan in-flight: catatan yang dihapus tidak hidup kembali', async (b, S) => {
  const { p } = await h2bLab(b, S);
  const hold = h2bHold(p, '**/api/translate', 1);
  await p.click('#btnRec');
  check('H2B-03: terjemahan ditahan', await h1Until(async () => hold.entered, 40000));
  await p.click('#expClear'); hold.release(); await sleep(900);
  check('H2B-03: LOG tetap kosong (memori dan localStorage)', (await h2bMem(p)) === 0 && (await h2bLog(p)).length === 0, (await h2bMem(p)) + '/' + (await h2bLog(p)).length);
  check('H2B-03: UI tidak menampilkan hasil usang', (await h2bResult(p)) === 0 && !/Selesai/.test(await h2bStatus(p)), await h2bStatus(p));
  check('H2B-03: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-04: mulai sesi penguji baru saat terjemahan in-flight: hasil lama tidak masuk sesi mana pun', async (b, S) => {
  const { p } = await h2bLab(b, S);
  const hold = h2bHold(p, '**/api/translate', 1);
  await p.click('#btnRec');
  check('H2B-04: terjemahan ditahan', await h1Until(async () => hold.entered, 40000));
  await p.click('#btnNewSession'); hold.release(); await sleep(900);
  check('H2B-04: tidak ada catatan di sesi lama maupun baru', (await h2bMem(p)) === 0 && (await h2bLog(p)).length === 0, (await h2bMem(p)) + '/' + (await h2bLog(p)).length);
  check('H2B-04: UI tidak menampilkan hasil usang', (await h2bResult(p)) === 0 && !/Selesai/.test(await h2bStatus(p)), await h2bStatus(p));
  check('H2B-04: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-05: TTS QA Lab in-flight lalu ganti dialog: audio tidak diputar, speaking dilepas, UI bersih', async (b, S) => {
  const { p } = await h2bLab(b, S);
  await p.check('#testSpeak');
  const hold = h2bHold(p, '**/api/tts', 1);
  await p.click('#btnRec');
  check('H2B-05: TTS diproses server, balasan ditahan', await h1Until(async () => hold.entered, 40000));
  const plays0 = await h2Plays(p);
  await p.selectOption('#scriptSel', 'B');
  hold.release(); await sleep(900);
  check('H2B-05: audio hasil in-flight TIDAK diputar', (await h2Plays(p)) === plays0, (await h2Plays(p)) + ' vs ' + plays0);
  check('H2B-05: speaking dilepas', (await p.evaluate(() => window.__t.getSpeaking())) === false);
  check('H2B-05: UI tidak menulis hasil usang', (await h2bResult(p)) === 0 && !/Selesai/.test(await h2bStatus(p)), await h2bStatus(p));
  const log = await h2bLog(p);
  check('H2B-05: catatan yang sudah valid (terjemahan selesai) tidak dihapus, suara ditandai tidak selesai', log.length === 1 && log[0].translation && log[0].voice !== '' && log[0].voice !== 'OpenAI (backend)', JSON.stringify(log.map(x => x.voice)));
  check('H2B-05: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-06: Berhenti saat mikrofon masih disiapkan: mikrofon tidak bocor, status tidak ditimpa', async (b, S) => {
  const { p } = await h2bLab(b, S, { init: h2bInit });
  await p.evaluate(() => { window.__gumDelay = 1500; });
  await p.click('#btnRec'); await sleep(150); await p.click('#btnRec');   // Rekam lalu Berhenti sebelum izin mikrofon selesai
  await sleep(2800);
  check('H2B-06: tidak ada track mikrofon yang masih hidup', (await h2bLive(p)) === 0, await h2bLive(p));
  check('H2B-06: Listen tidak aktif, tombol kembali "Rekam"', !(await p.evaluate(() => window.__t.Listen.active)) && /Rekam/.test(await txt(p, '#btnRec')), await txt(p, '#btnRec'));
  check('H2B-06: status tetap "Dihentikan." (tidak ditimpa "Mendengarkan…")', /Dihentikan/.test(await h2bStatus(p)), await h2bStatus(p));
  check('H2B-06: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-07: dua operasi QA bertumpuk: hanya rekaman terbaru yang menulis hasil; hasil lama yang terlambat dibuang', async (b, S) => {
  const { p } = await h2bLab(b, S);
  const hold = h2bHold(p, '**/api/translate', 1);
  await p.click('#btnRec');
  check('H2B-07: terjemahan operasi 1 ditahan', await h1Until(async () => hold.entered, 40000));
  await p.click('#btnRec');   // operasi 2 (rekam baru)
  await p.waitForFunction(() => /Selesai\./.test(document.getElementById('scriptStatus').textContent), null, { timeout: 45000 });
  check('H2B-07: operasi 2 selesai dan tercatat sekali', (await h2bMem(p)) === 1, await h2bMem(p));
  const res0 = await txt(p, '#scriptResult');
  hold.release(); await sleep(900);
  check('H2B-07: hasil operasi 1 yang terlambat TIDAK menambah catatan', (await h2bMem(p)) === 1 && (await h2bLog(p)).length === 1, (await h2bMem(p)) + '/' + (await h2bLog(p)).length);
  check('H2B-07: UI hasil tidak berubah oleh operasi lama', (await txt(p, '#scriptResult')) === res0 && /Selesai\./.test(await h2bStatus(p)));
  check('H2B-07: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
});

test('H2B-08: jalur normal tidak berubah: Rekam otomatis berhenti saat VAD menyerahkan hasil, tercatat, UI selesai, suara dimainkan', async (b, S) => {
  const { p, code } = await h2bLab(b, S);
  await p.check('#testSpeak');
  const tts0 = S.mock.calls.tts;
  await p.click('#btnRec'); const plays0 = await h2Plays(p);   // unlockAudio() saat klik ikut memanggil play(); hitung setelahnya
  await p.waitForFunction(() => /Selesai\./.test(document.getElementById('scriptStatus').textContent), null, { timeout: 45000 });
  const log = await h2bLog(p);
  check('H2B-08: satu catatan lengkap (teks, terjemahan, suara)', log.length === 1 && log[0].heard && log[0].translation && log[0].voiced === true && log[0].voice === 'OpenAI (backend)', JSON.stringify(log[0] || {}).slice(0, 200));
  check('H2B-08: TTS diminta sekali dan diputar', S.mock.calls.tts === tts0 + 1 && (await h2Plays(p)) === plays0 + 1);
  check('H2B-08: mendengarkan berhenti otomatis, speaking dilepas, hasil tampil', !(await p.evaluate(() => window.__t.Listen.active)) && !(await p.evaluate(() => window.__t.getSpeaking())) && (await h2bResult(p)) > 10);
  check('H2B-08: tanpa galat JS', p.errors.length === 0, p.errors.join('|'));
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
