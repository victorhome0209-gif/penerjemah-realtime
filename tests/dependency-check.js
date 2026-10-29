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
const df = fs.readFileSync(path.join(ROOT, 'backend', 'Dockerfile'), 'utf8'); const from = (/^FROM\s+(\S+)/m.exec(df) || [])[1];
console.log('INFO  Image dasar: ' + from + (/@sha256:/.test(from) ? ' (dikunci digest)' : ' (hanya tag; pertimbangkan mengunci digest dan memantau pembaruan keamanan)'));
check('Dockerfile: image dasar Node LTS bertag versi (bukan latest)', /^node:\d+/.test(from || ''), from);
check('Dockerfile: tanpa npm install (tidak ada dependensi yang diunduh saat build)', !/npm\s+(ci|install|i)\b/.test(df));
const wf = fs.existsSync(path.join(ROOT, '.github', 'workflows')) ? fs.readdirSync(path.join(ROOT, '.github', 'workflows')).map(f => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8')).join('\n') : '';
const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map(m => m[1]);
for (const u of uses) if (!/@[0-9a-f]{40}$/.test(u)) warn.push(u);
console.log('INFO  GitHub Actions: ' + uses.join(', ') + (warn.length ? '  [saran: kunci ke SHA commit, saat ini hanya tag mayor]' : ''));
check('Actions: tidak memakai secrets', !/secrets\./.test(wf));
console.log('\n' + ok + '/' + (ok + bad) + ' lulus'); process.exit(bad ? 1 : 0);
