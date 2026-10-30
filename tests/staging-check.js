'use strict';
// Verifikasi backend gaya staging. TIDAK PERNAH memanggil OpenAI: berhenti bila layanan berbayar menyala.
//   node tests/staging-check.js --local
//       Menjalankan backend sungguhan di folder sementara dengan konfigurasi mirip Railway (tanpa kunci OpenAI,
//       PAID_API_ENABLED=false) dan memeriksa health, CORS, auth, kredit, kill switch, rate limit, restart/persistensi,
//       penjaga satu instance, redaksi log. Ikut node tests/run-all.js.
//   VB_ADMIN_TOKEN=... node tests/staging-check.js --url https://ALAMAT --origin https://victorhome0209-gif.github.io
//       Memeriksa server yang sudah dipasang (Railway). Token admin hanya dari environment, tidak pernah dicetak.
//       Menolak jalan bila /api/health melaporkan paid_enabled:true. Membuat satu kode uji 10 kredit lalu menonaktifkannya.
//   ... --persist create   (sebelum redeploy)   lalu   ... --persist check   (sesudah redeploy): bukti Volume.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };
const LOCAL = !!arg('--local'), URLARG = arg('--url'), ORIGIN = arg('--origin') || 'https://victorhome0209-gif.github.io', PERSIST = arg('--persist');
const BACKEND = path.join(__dirname, '..', 'backend');
let ok = 0, bad = 0;
const check = (n, c, d) => { c ? ok++ : bad++; console.log((c ? 'LULUS ' : 'GAGAL ') + n + (c ? '' : '  | ' + (d || ''))); };
const J = async r => { try { return await r.json(); } catch (_) { return {}; } };
const hdrA = (t, x) => Object.assign({ 'X-Admin-Token': t }, x || {});

function startLocal(dir, admin, logs, extra) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { PORT: '0', DATA_DIR: dir, ADMIN_TOKEN: admin, ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY: 'true', PAID_API_ENABLED: 'false', MONTHLY_BUDGET_USD: '0.05', OPENAI_API_KEY: '' }, extra || {});
    delete env.OPENAI_BASE;
    const p = spawn('node', ['server.js'], { cwd: BACKEND, env }); let buf = '', done = false;
    const on = d => { buf += d; for (const l of String(d).split('\n')) if (l.trim()) logs.push(l); const m = /"port":(\d+)/.exec(buf); if (m && !done) { done = true; resolve({ p, B: 'http://127.0.0.1:' + m[1] }); } };
    p.stdout.on('data', on); p.stderr.on('data', on); p.on('exit', c => { if (!done) { done = true; reject(new Error('keluar ' + c)); } });
  });
}
const stop = p => new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 6000).unref(); });

// Pemeriksaan yang aman dijalankan di server mana pun (lokal atau Railway). Mengembalikan { code, id }.
async function common(B, admin, opts) {
  let r = await fetch(B + '/api/health'), j = await J(r);
  check('Health: 200, ok, store_ok', r.status === 200 && j.ok === true && j.store_ok === true, JSON.stringify(j));
  if (j.paid_enabled !== false) { console.log('BERHENTI: paid_enabled bukan false. Skrip ini tidak pernah dijalankan pada layanan berbayar aktif.'); process.exit(2); }
  check('Health: paid_enabled=false', true);
  const ver = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8')).version;
  check('Health: versi backend sama dengan backend/package.json (' + ver + ')', j.version === ver, 'server=' + j.version);
  r = await fetch(B + '/api/health', { headers: { Origin: ORIGIN } });
  check('CORS: origin frontend diizinkan', r.status === 200 && r.headers.get('access-control-allow-origin') === ORIGIN);
  r = await fetch(B + '/api/me', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  check('CORS: preflight 204 dan mengizinkan Authorization', r.status === 204 && /Authorization/i.test(r.headers.get('access-control-allow-headers') || ''));
  r = await fetch(B + '/api/health', { headers: { Origin: 'https://evil.example' } }); j = await J(r);
  check('CORS: origin asing ditolak 403', r.status === 403 && j.code === 'origin_denied');
  r = await fetch(B + '/api/me'); check('Auth: /api/me tanpa kode = 401', r.status === 401);
  r = await fetch(B + '/admin/codes'); check('Admin: tanpa token ditolak', r.status === 401 || r.status === 403, 'status ' + r.status);
  r = await fetch(B + '/admin/codes', { headers: hdrA('salah-' + crypto.randomBytes(4).toString('hex')) }); check('Admin: token salah ditolak', r.status === 401 || r.status === 403, 'status ' + r.status);
  r = await fetch(B + '/admin/audit', { headers: hdrA(admin) }); j = await J(r);
  check('Admin: token benar diterima (audit tanpa isu)', r.status === 200 && Array.isArray(j.issues) && j.issues.length === 0, 'status ' + r.status);
  r = await fetch(B + '/admin/codes', { method: 'POST', headers: hdrA(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name: opts.name, credits: 10, expires_days: 1, daily_calls: 10 }) }); j = await J(r);
  const code = j.code, id = j.id; check('Kode akses: dibuat (10 kredit, kedaluwarsa 1 hari, batas harian 10)', r.status === 200 && !!code && j.credits === 10 && !!j.expires, 'status ' + r.status);
  r = await fetch(B + '/api/me', { headers: { Authorization: 'Bearer ' + code } }); j = await J(r);
  check('Auth: kode benar = 200, paid_enabled=false, kredit 10', r.status === 200 && j.paid_enabled === false && j.credits === 10);
  r = await fetch(B + '/api/translate', { method: 'POST', headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json', 'Idempotency-Key': 'chk-' + crypto.randomBytes(6).toString('hex') }, body: JSON.stringify({ text: 'halo', src: 'id', tgt: 'en' }) }); j = await J(r);
  check('Berbayar mati: terjemahan 503 paid_disabled', r.status === 503 && j.code === 'paid_disabled', 'status ' + r.status + ' code ' + j.code);
  r = await fetch(B + '/api/me', { headers: { Authorization: 'Bearer ' + code } }); j = await J(r);
  check('Kredit tetap 10 setelah penolakan (tidak terpotong)', j.credits === 10);
  r = await fetch(B + '/admin/transactions', { headers: hdrA(admin) }); j = await J(r);
  check('Transaksi: tidak ada transaksi (tidak ada panggilan penyedia)', r.status === 200 && Array.isArray(j) && j.length === 0, JSON.stringify(j).slice(0, 80));
  // kill switch: simpan status awal lalu pulihkan
  const u0 = await J(await fetch(B + '/admin/usage', { headers: hdrA(admin) })); const was = !!u0.killed;
  r = await fetch(B + '/admin/kill', { method: 'POST', headers: hdrA(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled: false }) }); j = await J(r);
  check('Kill switch: dapat dimatikan (killed=true)', r.status === 200 && j.killed === true);
  r = await fetch(B + '/admin/kill', { method: 'POST', headers: hdrA(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled: !was }) }); j = await J(r);
  check('Kill switch: status awal dipulihkan', r.status === 200 && j.killed === was);
  r = await fetch(B + '/admin/usage', { headers: hdrA(admin) }); j = await J(r);
  check('Anggaran: /admin/usage menyatakan perkiraan internal dan paid_env_enabled=false', r.status === 200 && j.paid_env_enabled === false && /perkiraan/i.test(JSON.stringify(j)));
  return { code, id };
}

(async () => {
  if (!LOCAL && !URLARG) { console.error('Pakai --local atau --url https://ALAMAT (lihat komentar di atas berkas).'); process.exit(2); }
  if (LOCAL) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-stg-')), admin = 'adm-' + crypto.randomBytes(16).toString('hex'), logs = [];
    try {
      let s = await startLocal(dir, admin, logs); const { code } = await common(s.B, admin, { name: 'staging-check' });
      let got429 = false; for (let i = 0; i < 40 && !got429; i++) { const x = await fetch(s.B + '/api/me', { headers: { Authorization: 'Bearer salah' + i, 'X-Forwarded-For': '203.0.113.9' } }); if (x.status === 429) got429 = true; }
      check('Rate limit: percobaan kode salah beruntun menghasilkan 429', got429);
      let second = 'MULAI'; try { const s2 = await startLocal(dir, admin, []); await stop(s2.p); } catch (_) { second = 'menolak'; }
      check('Penjaga satu instance: proses kedua pada DATA_DIR yang sama menolak start', second === 'menolak', second);
      await stop(s.p); s = await startLocal(dir, admin, logs);
      let r = await fetch(s.B + '/admin/codes', { headers: hdrA(admin) }), j = await J(r);
      check('Persistensi: setelah restart kode masih ada', r.status === 200 && JSON.stringify(j).includes('staging-check'));
      r = await fetch(s.B + '/api/me', { headers: { Authorization: 'Bearer ' + code } }); j = await J(r);
      check('Persistensi: kode lama valid dan kredit 10 setelah restart', r.status === 200 && j.credits === 10);
      await stop(s.p);
      const all = logs.join('\n');
      check('Log: tanpa kode akses, token admin, teks percakapan', !all.includes(code) && !all.includes(admin) && !all.includes('halo'));
      check('Log: tanpa "Bearer " atau pola sk-', !/Bearer |sk-[A-Za-z0-9]{8,}/.test(all));
      check('Penyimpanan: kode akses tidak tersimpan polos (hanya hash)', !fs.readFileSync(path.join(dir, 'vocalbridge.json'), 'utf8').includes(code));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } else {
    const B = String(URLARG).replace(/\/+$/, ''), admin = process.env.VB_ADMIN_TOKEN || '';
    if (!/^https:\/\//.test(B) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(B)) { console.error('Alamat harus HTTPS.'); process.exit(2); }
    if (!admin) { console.error('Isi VB_ADMIN_TOKEN di environment (jangan di baris perintah atau chat).'); process.exit(2); }
    if (PERSIST) {
      const h = await J(await fetch(B + '/api/health')); if (h.paid_enabled !== false) { console.log('BERHENTI: paid_enabled bukan false.'); process.exit(2); }
      if (PERSIST === 'create') {
        const r = await fetch(B + '/admin/codes', { method: 'POST', headers: hdrA(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'staging-persist', credits: 1, expires_days: 1, daily_calls: 1 }) });
        check('Persistensi: kode "staging-persist" dibuat. Sekarang redeploy/restart layanan, lalu jalankan --persist check', r.status === 200);
      } else {
        const r = await fetch(B + '/admin/codes', { headers: hdrA(admin) }), j = await J(r);
        check('Persistensi: kode "staging-persist" masih ada setelah redeploy (Volume bekerja)', r.status === 200 && JSON.stringify(j).includes('staging-persist'), 'Jika GAGAL: Volume tidak terpasang di /data. BERHENTI.');
      }
    } else {
      const { id } = await common(B, admin, { name: 'staging-check-' + Date.now() });
      if (id) { const r = await fetch(B + '/admin/disable', { method: 'POST', headers: hdrA(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ id, disabled: true, request_id: 'stg-' + crypto.randomBytes(8).toString('hex') }) }); check('Pembersihan: kode uji dinonaktifkan', r.status === 200, 'status ' + r.status); }
    }
  }
  console.log('\n' + ok + '/' + (ok + bad) + ' lulus'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('GALAT', e.message); process.exit(2); });
