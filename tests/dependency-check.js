'use strict';
// Inventaris dependensi tanpa jaringan: backend harus nol dependensi pihak ketiga; daftar dependensi tes dan sumber eksternal.
const fs = require('fs'), path = require('path'), { builtinModules } = require('module');
const ROOT = path.join(__dirname, '..');
let ok = 0, bad = 0; const warn = [];
const check = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'LULUS ' : 'GAGAL ') + n + (c ? '' : '  | ' + x)); };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'package.json'), 'utf8'));
check('Backend: package.json tanpa dependencies/devDependencies/optionalDependencies', !pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies);
function walk(d, out = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'data') continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : /\.js$/.test(e.name) && out.push(p); } return out; }
const builtins = new Set(builtinModules.concat(builtinModules.map(m => 'node:' + m)));
const third = new Set();
for (const f of walk(path.join(ROOT, 'backend'))) for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) if (!m[1].startsWith('.') && !m[1].startsWith('node:') && !builtins.has(m[1])) third.add(m[1] + ' (' + path.relative(ROOT, f) + ')');
check('Backend: semua require adalah modul bawaan Node atau berkas lokal', third.size === 0, [...third].join(', '));
check('Backend: Node minimum dinyatakan (engines.node)', !!(pkg.engines && pkg.engines.node));
const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log('INFO  Dependensi akar (hanya untuk tes browser, tidak dikirim ke produksi): ' + JSON.stringify(root.devDependencies || {}) + '; runtime: ' + JSON.stringify(root.dependencies || {}));
check('Akar: tidak ada dependensi runtime', !root.dependencies);
// Frontend: tanpa skrip/gaya/font eksternal (CDN), CSP membatasi sumber.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('Frontend: tidak ada <script>/<link>/<img>/<iframe> ke alamat http(s) eksternal', !/<(script|link|img|iframe|source|video|audio)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html));
check('Frontend: tidak ada @import atau url(http...) di CSS', !/@import|url\(\s*["']?(https?:)?\/\//i.test(html));
check('Frontend: CSP script-src hanya self/inline (tanpa host luar)', /script-src 'self' 'unsafe-inline';/.test(html));
check('Frontend: CSP object-src none dan base-uri none', /object-src 'none'/.test(html) && /base-uri 'none'/.test(html));
const ext = [...new Set([...html.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)].map(m => m[0]))].filter(u => !/^https?:\/\/(localhost|127\.0\.0\.1)$/.test(u));
check('Frontend: tidak menyebut host eksternal apa pun (V1.2: semua lewat backend sendiri)', ext.length === 0, ext.join(', '));
const lockPath = path.join(ROOT, 'package-lock.json');
check('Akar: package-lock.json ada', fs.existsSync(lockPath));
if (fs.existsSync(lockPath)) {
  const lk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const rootPkg = lk.packages && lk.packages[''];
  check('Lockfile: devDependencies cocok dengan package.json', !!rootPkg && JSON.stringify(rootPkg.devDependencies) === JSON.stringify(root.devDependencies || {}));
  const ents = Object.entries(lk.packages || {}).filter(([k]) => k);
  check('Lockfile: setiap paket berasal dari registry.npmjs.org dengan integrity sha512', ents.length > 0 && ents.every(([, v]) => /^https:\/\/registry\.npmjs\.org\//.test(v.resolved || '') && /^sha512-/.test(v.integrity || '')));
}
const df = fs.readFileSync(path.join(ROOT, 'backend', 'Dockerfile'), 'utf8'); const from = (/^FROM\s+(\S+)/m.exec(df) || [])[1];
console.log('INFO  Image dasar: ' + from + (/@sha256:/.test(from) ? ' (dikunci digest)' : ' (hanya tag; pertimbangkan mengunci digest dan memantau pembaruan keamanan)'));
check('Dockerfile: image dasar Node LTS bertag versi (bukan latest)', /^node:\d+/.test(from || ''), from);
check('Dockerfile: tanpa npm install (tidak ada dependensi yang diunduh saat build)', !/npm\s+(ci|install|i)\b/.test(df));
const wf = fs.existsSync(path.join(ROOT, '.github', 'workflows')) ? fs.readdirSync(path.join(ROOT, '.github', 'workflows')).map(f => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8')).join('\n') : '';
const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map(m => m[1]);
for (const u of uses) if (!/@[0-9a-f]{40}$/.test(u)) warn.push(u);
console.log('INFO  GitHub Actions: ' + uses.join(', ') + (warn.length ? '  [saran: kunci ke SHA commit, saat ini hanya tag mayor]' : ''));
check('Actions: tidak memakai secrets', !/secrets\./.test(wf));
check('Actions: tidak ada langkah deploy (pages/railway/docker push/ssh/curl POST)', !/deploy-pages|configure-pages|railway|docker\s+push|\bssh\b|curl\s+[^\n]*-X\s*POST/i.test(wf));
check('Actions: izin hanya contents: read', /permissions:\s*\n\s*contents: read/.test(wf) && !/contents:\s*write|id-token|pages:\s*write/.test(wf));
console.log('\n' + ok + '/' + (ok + bad) + ' lulus'); process.exit(bad ? 1 : 0);
