'use strict';
// Reproduksi masalah P0/P1 (restart saat in-flight, topup tidak valid, fallback berulang) dengan backend sebagai PROSES TERPISAH.
// Pemakaian: node tests/repro-masalah.js <folder-backend>   (OpenAI palsu, tanpa biaya)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const DIR = process.argv[2];
const ADMIN = 'admin-token-for-repro-0123456789abcdef', FAKEKEY = 'sk-REPRO-FAKE-KEY-1234567890';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function wav(sec = 1, rate = 16000) { const n = sec * rate, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2); return b; }

const mock = { received: 0, completed: 0, delay: 0, status: 0, calls: { stt: 0, translate: 0 } };
const mockSrv = http.createServer((req, res) => {
  const ch = []; req.on('data', c => ch.push(c)); req.on('end', async () => {
    const kind = req.url.includes('transcriptions') ? 'stt' : req.url.includes('chat/completions') ? 'translate' : 'tts';
    mock.received++; mock.calls[kind] = (mock.calls[kind] || 0) + 1;
    if (mock.delay) await sleep(mock.delay);
    if (mock.status) { res.writeHead(mock.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'language'" } })); }
    mock.completed++; // di sisi penyedia: pekerjaan selesai dan DITAGIH walau klien sudah mati
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(kind === 'stt' ? { text: 'halo' } : { choices: [{ message: { content: 'hello' } }] }));
  });
});

async function startBackend(dataDir, extra = {}) {
  const port = await freePort();
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, OPENAI_API_KEY: FAKEKEY, OPENAI_BASE: 'http://127.0.0.1:' + mock.port,
    PAID_API_ENABLED: 'true', MONTHLY_BUDGET_USD: '5', ALLOWED_ORIGINS: 'https://x.example', UPSTREAM_TIMEOUT_MS: '20000' }, extra);
  const p = spawn(process.execPath, [path.join(DIR, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) break; } catch (_) {} await sleep(100); }
  return { p, B: 'http://127.0.0.1:' + port, log: () => out };
}
const adm = (B, p, body) => fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'application/json' }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
const me = async (B, code) => (await (await fetch(B + '/api/me', { headers: { Authorization: 'Bearer ' + code } })).json());
const tr = (B, code, key, text = 'Selamat pagi') => fetch(B + '/api/translate', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, src: 'id', tgt: 'en' }) });

(async () => {
  await new Promise(r => mockSrv.listen(0, '127.0.0.1', r)); mock.port = mockSrv.address().port;
  console.log('Backend diuji: ' + DIR + '\n');

  // ---------- R1: restart saat permintaan sedang berjalan di penyedia ----------
  { console.log('## R1. Backend mati di tengah permintaan, lalu restart');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-')); mock.received = mock.completed = 0; mock.delay = 2500; mock.status = 0;
    let b = await startBackend(dir);
    const code = (await (await adm(b.B, '/admin/codes', { name: 'T', credits: 10 })).json()).code;
    const pending = tr(b.B, code, 'kunci-r1-0001').catch(() => null);
    for (let i = 0; i < 40 && mock.received < 1; i++) await sleep(50);
    b.p.kill('SIGKILL'); await pending; await sleep(200);
    await new Promise(r => { const t = setInterval(() => { if (mock.completed >= 1) { clearInterval(t); r(); } }, 50); setTimeout(r, 4000); });
    console.log('penyedia memproses dan menagih sebelum klien mati : completed=' + mock.completed);
    b = await startBackend(dir); mock.delay = 0;
    const m1 = await me(b.B, code);
    console.log('setelah restart, kredit pengguna                  : ' + m1.credits + ' (awal 10)' + (m1.credits === 10 ? '  <- DIKEMBALIKAN padahal penyedia sudah menagih' : ''));
    const r2 = await tr(b.B, code, 'kunci-r1-0001'); const j2 = await r2.text();
    const m2 = await me(b.B, code);
    console.log('kirim ulang dengan kunci yang sama                : HTTP ' + r2.status + ' ' + j2.slice(0, 80).replace(/\n/g, ' '));
    console.log('RINGKASAN: penyedia menagih ' + mock.completed + 'x, pengguna dipotong ' + (10 - m2.credits) + ' kredit' + (mock.completed > (10 - m2.credits) ? '  <- BIAYA GANDA TIDAK TERTAGIH KE PENGGUNA' : ''));
    b.p.kill('SIGKILL'); }

  // ---------- R2: admin/topup dengan nilai tidak valid ----------
  { console.log('\n## R2. /admin/topup dengan nilai tidak valid');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-')); const b = await startBackend(dir);
    const code = (await (await adm(b.B, '/admin/codes', { name: 'T', credits: 10 })).json()).code;
    const id = (await (await adm(b.B, '/admin/codes')).json())[0].id;
    let n = 0; const show = async (label, body, rid) => { if (typeof body === 'object') body = Object.assign({ request_id: rid || ('req-r2-' + (++n) + '-abcdef') }, body); else body = body.replace('{', '{"request_id":"' + ('req-r2-' + (++n) + '-abcdef') + '",'); const r = await adm(b.B, '/admin/topup', body); const t = (await r.text()).replace(/\n/g, ' ').slice(0, 90); let c; try { c = (await me(b.B, code)).credits; } catch (e) { c = 'tidak terbaca'; }
      console.log(label.padEnd(34) + 'HTTP ' + r.status + '  saldo sekarang=' + c + '  ' + t); };
    await show('topup -1000', { id, credits: -1000 });
    await show('topup 1e999 (tak hingga)', '{"id":"' + id + '","credits":1e999}');
    const raw = fs.readFileSync(path.join(dir, fs.existsSync(path.join(dir, 'vocalbridge.json')) ? 'vocalbridge.json' : 'codes.json'), 'utf8');
    console.log('berkas data setelah itu mengandung "credits":null : ' + /"credits":null/.test(raw));
    await show('topup "abc"', { id, credits: 'abc' });
    await show('disabled:"false" (string)', { id, credits: 0, disabled: 'false' });
    console.log('kode sekarang dapat dipakai? HTTP ' + (await fetch(b.B + '/api/me', { headers: { Authorization: 'Bearer ' + code } })).status + '  (401 = kode ikut nonaktif karena string "false")');
    await show('topup +5 (request_id sama, ke-1)', { id, credits: 5 }, 'req-sama-0001'); await show('  diulang (Enter dua kali, ke-2)', { id, credits: 5 }, 'req-sama-0001');
    b.p.kill('SIGKILL'); }

  // ---------- R3: fallback berulang saat penyedia menolak ----------
  { console.log('\n## R3. Penyedia menolak permintaan (400): berapa kali penyedia dipanggil?');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-')); const b = await startBackend(dir);
    const code = (await (await adm(b.B, '/admin/codes', { name: 'T', credits: 10 })).json()).code;
    mock.status = 400; mock.calls = { stt: 0, translate: 0 };
    const rs = await fetch(b.B + '/api/stt?lang=id', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Idempotency-Key': 'kunci-r3-stt-1', 'Content-Type': 'audio/wav' }, body: wav(1) });
    console.log('1 permintaan STT  -> panggilan ke penyedia: ' + mock.calls.stt + '  (HTTP ' + rs.status + ')');
    const rt = await tr(b.B, code, 'kunci-r3-tr-01');
    console.log('1 permintaan terjemahan -> panggilan ke penyedia: ' + mock.calls.translate + '  (HTTP ' + rt.status + ')');
    mock.status = 0; b.p.kill('SIGKILL'); }
  mockSrv.close(); process.exit(0);
})().catch(e => { console.error('GALAT SKRIP', e); process.exit(1); });
