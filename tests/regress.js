'use strict';
// Regresi: fungsi murni QA Lab pada index.html BARU harus memberi hasil identik dengan index.html LAMA (commit 243b77b).
// Perbedaan yang disengaja: baris "Pengenal suara: ... | Terjemahan: ..." pada laporan (mesin kini backend/browser).
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { console.error('Playwright belum terpasang. Jalankan: npm install && npx playwright install chromium'); process.exit(2); }
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const OLD_REF = process.env.OLD_REF || '243b77b';

const battery = () => {
  const T = window.__t, out = {};
  const seed = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const pairs = []; T.SCRIPTS && Object.keys(T.SCRIPTS).forEach(() => {});
  const items = T.DIALOGS.A.items.concat(T.DIALOGS.B.items);
  items.forEach(it => { const en = it[0] === 'me' ? it[1] : it[1]; pairs.push([en, en], [en, en.split(' ').slice(1).join(' ')], [en, en.toLowerCase().replace(/[.,?!]/g, '')], [en, en + ' extra words here']); });
  pairs.push(['Rapat dimulai jam 08.30', 'rapat dimulai jam delapan tiga puluh'], ['It costs $1,250 per month', 'it costs one thousand two hundred fifty dollars per month']);
  out.norm = pairs.map(([a, b]) => [T.normText(a, 'en'), T.normText(b, 'id')]);
  out.wer = pairs.map(([a, b]) => [T.wer(a, b, 'en'), T.accuracy(a, b, 'id'), T.tokenF1(a, b, 'en')]);
  out.diff = pairs.slice(0, 12).map(([a, b]) => T.diffHtml(a, b, 'en'));
  out.dialogs = JSON.stringify(T.DIALOGS);
  out.parse = T.parseDialog('Saya: Halo | Hello\nLawan: How are you? | Apa kabar?\nTanpa awalan\n\nSaya: Terima kasih');
  const frames = []; for (let c = 0; c < 40; c++) { const f = new Float32Array(2048); for (let i = 0; i < f.length; i++) f[i] = (seed() - 0.5) * (c > 10 && c < 30 ? 0.6 : 0.01) * (c === 20 ? 4 : 1); frames.push(f); }
  const a = T.analyzeFrames(frames, 48000); out.analyze = a; out.verdict = T.verdictFor(a); out.verdictNull = T.verdictFor(null);
  const x = new Float32Array(4800); for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.5;
  out.resample = Array.from(T.resample(x, 48000, 16000).slice(0, 50)).map(v => +v.toFixed(6)); out.resampleLen = T.resample(x, 48000, 16000).length;
  const wav = new Uint8Array(T.encodeWav(T.resample(x, 48000, 16000), 16000)); let h = 0; for (const b of wav) h = (h * 31 + b) >>> 0; out.wavHash = h; out.wavLen = wav.length;
  const L = T.LOG(); L.length = 0;
  L.push({ id: 'a1', t: '2026-10-29T01:00:00Z', tester: 'Budi', session: 'S1', view: 'test', side: 'me', target: 'Selamat pagi', ref: 'Good morning', heard: 'selamat pagi', translation: 'Good morning', engine: 'X', stt: 'browser', latency_ms: 900, acc: 100, tsim: 100, line: 1, dialog: 'A', role: 'Tanya', pair: 1, voiced: true, spoken_text: 'Good morning', voice: 'suara HP', mic: { dur: 2, level_db: -20, noise_db: -50, snr_db: 30, clip_pct: 0 }, pron: 'ok', trans: 'ok', note: 'bagus' },
         { id: 'a2', t: '2026-10-29T01:00:05Z', tester: 'Budi', session: 'S1', view: 'test', side: 'them', target: 'How are you?', ref: 'Apa kabar?', heard: 'how are you', translation: 'Apa kabar', engine: 'X', stt: 'browser', latency_ms: 1200, acc: 90, tsim: 80, line: 2, dialog: 'A', role: 'Jawab', pair: 1, voiced: false, spoken_text: '', voice: '', mic: null, pron: null, trans: 'bad', note: '' });
  out.csv = T.buildCsv(L); const mask = t => t.split('\n').filter(l => !/^Pengenal suara:|^Dibuat:/.test(l)).join('\n'); // jam pembuatan laporan berbeda tiap detik
  out.text = mask(T.buildText(L)); out.transcript = mask(T.buildTranscript(L));
  out.scopeLen = T.scopeLogs().length; out.ttsFlags = T.ttsFlags();
  out.scriptItemsA = (T.Script.mode = 'A', T.scriptItems().length);
  out.keys = Object.keys(T).sort();
  return out;
};

(async () => {
  // Mode offline: snapshot ZIP tidak punya riwayat Git. VB_OLD_INDEX_HTML menunjuk berkas index.html commit 243b77b;
  // isinya wajib punya Git blob SHA yang tepat (fail-closed), jika tidak tes berhenti tanpa membandingkan apa pun.
  const LEGACY_BLOB = '6c9fca1ed9cd318237185e79a844b695d7ce722c';
  let oldHtml;
  if (process.env.VB_OLD_INDEX_HTML) {
    const buf = fs.readFileSync(process.env.VB_OLD_INDEX_HTML);
    const blob = require('crypto').createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
    if (blob !== LEGACY_BLOB) { console.error('GAGAL: Git blob SHA berkas legacy ' + blob + ' != ' + LEGACY_BLOB); process.exit(2); }
    oldHtml = buf.toString();
  } else {
    oldHtml = execFileSync('git', ['-C', ROOT, 'show', OLD_REF + ':index.html']).toString();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-reg-')); fs.writeFileSync(path.join(dir, 'old.html'), oldHtml); fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(dir, 'new.html'));
  const browser = await chromium.launch(); const res = {};
  for (const name of ['old', 'new']) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } }); await ctx.addInitScript(() => { window.__TEST__ = true; });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(String(e)));
    await page.goto('file://' + path.join(dir, name + '.html')); await page.waitForFunction(() => !!window.__t);
    res[name] = await page.evaluate(battery); res[name + 'Errs'] = errs; await ctx.close();
  }
  await browser.close();
  let ok = 0, bad = 0; const report = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'LULUS ' : 'GAGAL ') + n + (c ? '' : '  | ' + x)); };
  for (const k of Object.keys(res.old)) { if (k === 'keys') continue; const a = JSON.stringify(res.old[k]), b = JSON.stringify(res.new[k]); report('Regresi ' + k + ': hasil identik dengan versi lama', a === b, a.slice(0, 120) + ' <> ' + b.slice(0, 120)); }
  const missing = res.old.keys.filter(k => !res.new.keys.includes(k));
  report('Regresi: semua fungsi uji lama masih tersedia (kecuali elSpeak dan speak: suara perangkat sengaja dihapus di V1.2)', missing.every(k => k === 'elSpeak' || k === 'speak'), missing.join());
  report('Regresi: tanpa galat JS di kedua versi', res.oldErrs.length === 0 && res.newErrs.length === 0, JSON.stringify([res.oldErrs, res.newErrs]));
  console.log('\n' + ok + '/' + (ok + bad) + ' lulus'); process.exit(bad ? 1 : 0);
})();
