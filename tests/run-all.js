'use strict';
// Menjalankan SEMUA validasi, mencatat exit code dan hitungan PASS/FAIL, menulis docs/bukti/ringkasan-validasi.txt.
// Pemakaian: node tests/run-all.js [--no-browser]   (exit 0 = semua lulus, 1 = ada gagal, 2 = dependensi lingkungan hilang)
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const noBrowser = process.argv.includes('--no-browser');
let hasPw = true; try { require.resolve('playwright'); } catch (_) { hasPw = false; }

const suites = [
  { name: 'Backend (node --test)', cwd: 'backend', cmd: ['node', '--test', '--test-timeout=60000', ...fs.readdirSync(path.join(ROOT, 'backend', 'test')).filter(f => f.endsWith('.test.js')).map(f => 'test/' + f)], parse: o => ({ pass: +(/^# pass (\d+)/m.exec(o) || [])[1], fail: +(/^# fail (\d+)/m.exec(o) || [])[1] }) },
  { name: 'Pemindai keamanan statis', cmd: ['node', 'tests/static-check.js'], parse: o => lulus(o) },
  { name: 'Inventaris dependensi', cmd: ['node', 'tests/dependency-check.js'], parse: o => lulus(o) },
  { name: 'Backend gaya staging (lokal, tanpa OpenAI)', cmd: ['node', 'tests/staging-check.js', '--local'], parse: o => lulus(o) },
  { name: 'Regresi QA Lab (Chromium)', cmd: ['node', 'tests/regress.js'], browser: true, parse: o => lulus(o) },
  { name: 'E2E Chromium (simulasi)', cmd: ['node', 'tests/e2e/run.js'], browser: true, parse: o => lulus(o) },
  { name: 'npm audit backend (butuh registri npm)', cwd: 'backend', cmd: ['npm', 'audit', '--omit=dev'], audit: true },
  { name: 'npm audit akar/dev (butuh registri npm)', cmd: ['npm', 'audit'], audit: true }
];
function lulus(o) { const m = /(\d+)\/(\d+) lulus/.exec(o); return m ? { pass: +m[1], fail: +m[2] - +m[1] } : { pass: NaN, fail: NaN }; }

const rows = []; let worst = 0;
for (const s of suites) {
  const t0 = Date.now();
  if (s.browser && (noBrowser || !hasPw)) {
    const why = noBrowser ? 'DILEWATI (--no-browser)' : 'TIDAK BISA DIJALANKAN: Playwright belum terpasang (npm install && npx playwright install chromium)';
    rows.push({ name: s.name, exit: noBrowser ? '-' : 2, pass: '-', fail: '-', status: why, sec: 0 }); if (!noBrowser) worst = Math.max(worst, 2); continue;
  }
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: path.join(ROOT, s.cwd || ''), encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || ''); const sec = Math.round((Date.now() - t0) / 1000);
  if (s.audit) {
    const net = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|ENOLOCK|audit endpoint|proxy|shrinkwrap|package-lock/i.test(out);
    rows.push({ name: s.name, exit: r.status, pass: '-', fail: '-', status: r.status === 0 ? 'LULUS (0 kerentanan dilaporkan)' : net ? 'TIDAK BISA DIJALANKAN di lingkungan ini (registri tidak terjangkau atau tanpa lockfile); jalankan di mesin dengan internet' : 'GAGAL: kerentanan terdeteksi', sec, tail: out.trim().split('\n').slice(-3).join(' | ') });
    if (r.status !== 0 && !net) worst = Math.max(worst, 1); continue;
  }
  const c = s.parse(out); const okExit = r.status === 0 && c.fail === 0;
  rows.push({ name: s.name, exit: r.status, pass: c.pass, fail: c.fail, status: okExit ? 'LULUS' : 'GAGAL', sec }); if (!okExit) worst = Math.max(worst, 1);
  if (!okExit) fs.writeFileSync(path.join(os.tmpdir(), 'vb-gagal-' + s.name.replace(/\W+/g, '_') + '.log'), out);
}
const lines = ['RINGKASAN VALIDASI VOCALBRIDGE', 'Waktu: ' + new Date().toISOString(), 'Node: ' + process.version + '  Playwright: ' + (hasPw ? 'ada' : 'tidak ada'), 'Commit: ' + (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim(), '',
  'Rangkaian'.padEnd(44) + 'Exit'.padEnd(6) + 'PASS'.padEnd(7) + 'FAIL'.padEnd(7) + 'Detik'.padEnd(7) + 'Status'];
for (const r of rows) lines.push(r.name.padEnd(44) + String(r.exit).padEnd(6) + String(r.pass).padEnd(7) + String(r.fail).padEnd(7) + String(r.sec).padEnd(7) + r.status);
const aud = rows.filter(r => r.tail).map(r => '  ' + r.name + ': ' + r.tail); if (aud.length) lines.push('', 'Keluaran npm audit (potongan):', ...aud);
lines.push('', 'Exit akhir: ' + worst + (worst === 0 ? ' (semua lulus)' : worst === 2 ? ' (dependensi lingkungan hilang)' : ' (ada yang gagal)'));
const txt = lines.join('\n'); console.log(txt);
try { fs.mkdirSync(path.join(ROOT, 'docs', 'bukti'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'docs', 'bukti', 'ringkasan-validasi.txt'), txt.replace(/\/(?:home|Users|root|tmp)\/[^\s|]*/g, '<jalur-lokal>') + '\n'); } catch (_) {}
process.exit(worst);
