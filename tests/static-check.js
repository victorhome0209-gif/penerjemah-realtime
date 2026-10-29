'use strict';
// Pemindai statis: rahasia tidak boleh ada di frontend, repositori, atau penyimpanan browser.
// Tes ini otomatis (tanpa jaringan dan tanpa biaya).
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let ok = 0, bad = 0;
const check = (n, c, x) => { c ? ok++ : bad++; console.log((c ? 'LULUS ' : 'GAGAL ') + n + (c ? '' : '  | ' + x)); };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const noComments = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('Frontend: tidak memanggil api.openai.com, api.anthropic.com, atau api.elevenlabs.io', !/api\.openai\.com|api\.anthropic\.com|api\.elevenlabs\.io/i.test(html), (html.match(/api\.(openai|anthropic|elevenlabs)[^\s'"]*/i) || [])[0]);
check('Frontend: tanpa header kunci penyedia (x-api-key, xi-api-key)', !/x-api-key|xi-api-key/i.test(html));
check('Frontend: tanpa kunci bergaya sk-... atau sk_...', !/sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9]{12,}/.test(html));
check('Frontend: tidak ada kolom isian API key', !/id="(keyOpenAI|keyClaude|elkey)"|placeholder="sk-/.test(html));
check('Frontend: satu-satunya kolom password adalah kode akses uji', (html.match(/type="password"[^>]*/g) || []).length === 1 && /id="vbCode"/.test(html.match(/<input[^>]*type="password"[^>]*>/)[0]), html.match(/<input[^>]*type="password"[^>]*>/g));
const lsKeys = [...noComments.matchAll(/(?:lsSet|bind)\(\s*(?:'[^']+'\s*,\s*)?'([^']+)'/g)].map(m => m[1]).concat([...noComments.matchAll(/localStorage\.setItem\(\s*'([^']+)'/g)].map(m => m[1]));
const sus = lsKeys.filter(k => /key|token|secret|code|passw|bearer/i.test(k));
check('Frontend: tidak ada kunci localStorage bernama key/token/code/secret', sus.length === 0, sus.join());
check('Frontend: token akses hanya ditulis ke sessionStorage', [...noComments.matchAll(/sessionStorage\.setItem\(\s*'([^']+)'/g)].every(m => m[1] === 'vb_token') && !/localStorage\.setItem\([^)]*token/i.test(noComments));
const legacy = [...noComments.matchAll(/tr_key_openai|tr_key_claude|tr_elkey/g)].length;
check('Frontend: nama kunci lama hanya muncul di daftar penghapusan', legacy === 3 && /LEGACY_KEYS = \['tr_key_openai', 'tr_key_claude', 'tr_elkey'\]/.test(noComments), legacy);
check('Frontend: CSP membatasi sumber skrip dan objek', /Content-Security-Policy/.test(html) && /object-src 'none'/.test(html) && !/script-src[^;]*https:/.test(html.match(/Content-Security-Policy" content="([^"]+)"/)[1]));
check('Frontend: alamat backend bawaan kosong (tidak ada alamat tersembunyi)', /VB_CONFIG = \{ API_BASE: "" \}/.test(html));
check('Frontend: tidak ada tombol "Lawan Bicara"', !/<button[^>]*>[^<]*Lawan bicara/i.test(html));

// pindai semua berkas terlacak git (kecuali tes yang sengaja memakai kunci palsu)
let files;
try { files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard']).toString().split('\n').filter(Boolean); }
catch (_) { files = []; }
const SKIP = f => /^backend\/test\//.test(f) || /^tests\/(static-check|e2e|regress|repro-masalah)/.test(f) || /\.(png|jpg|zip)$/.test(f);
const PATS = [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /sk_[a-f0-9]{30,}/, /xi-api-key\s*[:=]\s*['"][A-Za-z0-9]{16,}/, /OPENAI_API_KEY[ \t]*=[ \t]*\S{12,}/, /ELEVENLABS_API_KEY[ \t]*=[ \t]*\S{12,}/, /ANTHROPIC_API_KEY[ \t]*=[ \t]*\S{12,}/, /ADMIN_TOKEN[ \t]*=[ \t]*\S{12,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const hits = [];
for (const f of files) { if (SKIP(f)) continue; let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; } for (const re of PATS) if (re.test(t)) hits.push(f + ' ~ ' + re); }
check('Repositori: tidak ada kunci atau token di ' + files.length + ' berkas (di luar tes dengan kunci palsu)', hits.length === 0, hits.join('; '));
check('Repositori: .env tidak ikut terlacak dan .gitignore mengabaikannya', !files.some(f => /(^|\/)\.env($|\.)/.test(f) && !/\.example$/.test(f)) && /^\.env$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
const ex = fs.readFileSync(path.join(ROOT, 'backend', '.env.example'), 'utf8');
check('.env.example hanya berisi placeholder kosong untuk rahasia', /^OPENAI_API_KEY=$/m.test(ex) && /^ANTHROPIC_API_KEY=$/m.test(ex) && /^ELEVENLABS_API_KEY=$/m.test(ex) && /^ADMIN_TOKEN=$/m.test(ex) && /^PAID_API_ENABLED=false$/m.test(ex));
const be = ['server.js', ...fs.readdirSync(path.join(ROOT, 'backend', 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f), ...fs.readdirSync(path.join(ROOT, 'backend', 'lib', 'providers')).map(f => 'lib/providers/' + f)].map(f => fs.readFileSync(path.join(ROOT, 'backend', f), 'utf8')).join('\n');
check('Backend: tidak ada nilai kunci di kode (hanya nama variabel)', !/['"]sk-[A-Za-z0-9]{8,}/.test(be));
check('Backend: log tidak mencetak kunci (tidak ada console.log berisi key)', !/console\.(log|error|warn)\([^)]*(openai\.key|\.key\b|adminToken|authorization)/i.test(be));
check('Backend: Dockerfile tidak menyalin .env atau data', !/COPY[^\n]*\.env|COPY[^\n]*data/.test(fs.readFileSync(path.join(ROOT, 'backend', 'Dockerfile'), 'utf8')));

const bk = ['server.js', 'lib/store.js', 'lib/util.js', 'lib/config.js', 'lib/providers/openai.js', 'lib/providers/common.js'].map(f => fs.readFileSync(path.join(ROOT, 'backend', f), 'utf8')).join('\n');
check('Backend: tidak ada pengembalian massal saat start (sweep(0) dari V1)', !/sweep\(\s*0\s*\)/.test(bk));
check('Backend: tidak ada pembulatan diam-diam nilai admin (Math.floor(+...))', !/Math\.floor\(\s*\+/.test(bk));
check('Backend: provider tanpa loop percobaan ulang atau fallback', !/for\s*\(\s*(const|let)\s+(body|attempt)\b[^)]*\)\s*\{[^}]*await send/.test(bk) && !/\btries\b/.test(bk));
check('Backend: konfigurasi ketat (ConfigError) dan kunci admin wajib request_id', /class ConfigError/.test(bk) && /request_id/.test(bk));
check('Frontend: modul Suara Saya ada tetapi tombol klon nonaktif secara bawaan', /id="view-voice"/.test(html) && /id="cloneBtn"[^>]*disabled/.test(html) && /id="btnPlayClone"[^>]*disabled/.test(html));
check('Frontend: klon suara hanya lewat backend dan bergantung gerbang server', /features\.voice_clone|voice_clone/.test(js) && !/elevenlabs/i.test(js.replace(/ElevenLabs|ELEVENLABS/g, '')));
// ---- V1.2 API-only: tidak ada mode Gratis ----
const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
check('V1.2: tidak ada tombol, label, atau teks "Gratis" di UI', !/gratis/i.test(visible), (visible.match(/.{0,30}gratis.{0,30}/i) || [])[0]);
check('V1.2: MyMemory dihapus total (tanpa host, fungsi, atau CSP khusus)', !/mymemory|translated\.net|translateFree/i.test(html));
check('V1.2: tidak memakai Browser Speech Recognition', !/SpeechRecognition|webkitSpeechRecognition/.test(noComments));
check('V1.2: tidak memakai suara perangkat (speechSynthesis) sebagai cadangan', !/speechSynthesis|SpeechSynthesisUtterance/.test(noComments));
check('V1.2: pesan "Layanan AI belum terhubung." ada dan dipakai untuk tombol utama', /const MSG_OFF = 'Layanan AI belum terhubung\.'/.test(noComments) && /serviceGate\(\)/.test(noComments));
check('V1.2: sesi diperiksa layanan (serviceGate) SEBELUM persetujuan dan mikrofon', /await serviceGate\(\)\)\) return;\s*if\(!\(await ensureConsent/.test(noComments) && noComments.indexOf('await serviceGate()') < noComments.indexOf('getUserMedia(micConstraints(micProfile()))'));
check('V1.2: translate, STT, dan TTS menolak bila layanan belum terhubung (tanpa cadangan)', (noComments.match(/if\(!VB\.ready\(\)\) throw offError/g) || []).length === 3);
check('V1.2: tidak ada percobaan ulang atau cadangan lain di frontend selain idempotensi vbCall (maks 2 percobaan, kunci sama)', (noComments.match(/vbCall\(/g) || []).length >= 5 && !/catch\([^)]*\)\s*\{[^}]*translateFree/.test(noComments));
console.log('\n' + ok + '/' + (ok + bad) + ' lulus'); process.exit(bad ? 1 : 0);
