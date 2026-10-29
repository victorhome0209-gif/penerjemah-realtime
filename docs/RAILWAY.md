# Panduan Railway untuk backend VocalBridge

**Status: belum ada proyek Railway untuk VocalBridge. Dokumen ini hanya rencana. Tidak ada yang dibuat, di-deploy, atau diberi kunci oleh saya.** Semua langkah di bawah dilakukan oleh Anda setelah menyetujui PR V1.1.
**Proyek Railway TERPISAH:** buat proyek baru bernama `vocalbridge-backend`. Jangan memakai proyek, Volume, variabel, atau domain milik aplikasi lain (mis. Belimint). Satu proyek = satu layanan = satu Volume.
Sumber yang diverifikasi dari dokumentasi Railway (29-30 Okt 2026): Volumes, Config as Code, Monorepo, Variables, Healthchecks. Yang **belum** terverifikasi ditandai ⚠: apakah layanan ber-Volume boleh punya banyak replika (dokumen tidak menyatakan; tetap satu instance) dan pengaturan PR environments.

## 1. Rencana konfigurasi
| Pengaturan | Nilai | Catatan |
|---|---|---|
| Proyek / layanan | proyek `vocalbridge-backend`, satu layanan di dalamnya | Frontend tetap di GitHub Pages, bukan di Railway |
| Sumber | repo `victorhome0209-gif/penerjemah-realtime`, branch **`main` saja**, dan hanya setelah Anda me-merge PR | **Jangan** hubungkan `vocalbridge-v1.1` atau branch percobaan lain. Matikan PR environments bila ada di Settings ⚠ (tidak dijelaskan di dokumen Variables) |
| **Root Directory** | `/backend` | Settings layanan. Railway hanya mengambil berkas di folder itu |
| Builder | Dockerfile (`backend/Dockerfile`) | Railway memakai Dockerfile bila ada. Image `node:22-slim`, tanpa `npm install` |
| **Jumlah instance** | **1** | Jangan menaikkan replika. Lihat bagian 3 |
| **Volume** | mount path **`/data`** | Tanpa Volume, saldo dan transaksi hilang saat deploy ulang |
| Watch Paths | `/backend/**` | Perubahan frontend/docs tidak memicu deploy backend |
| Healthcheck path | `/api/health` | Terverifikasi di dokumentasi Railway (30 Okt 2026): cukup balasan 2xx; batas waktu bawaan 300 dtk; hanya dipakai saat deploy (bukan pemantauan berkelanjutan); permintaan datang dari host `healthcheck.railway.app` dan server tidak menyaring host |
| Domain | Generate Domain (Settings → Networking) | Alamat inilah yang diisi di `VB_CONFIG.API_BASE` |
| Restart policy | bawaan | `railway.json` tidak dipakai: dokumentasi Railway menandai config-as-code deprecated (berkas lama jalan sampai 2026-12-01) dan path-nya tidak mengikuti Root Directory |
`PORT` disuntikkan Railway; server membacanya otomatis. **Jangan** mengisi `PORT`.

## 2. Variabel (Service → Variables)
Rahasia: isi sendiri di Railway. Jangan menempelkannya ke chat, GitHub, atau GitHub Actions variables.
| Variabel | Nilai | Jenis |
|---|---|---|
| `OPENAI_API_KEY` | kunci OpenAI **baru**, khusus VocalBridge | **Rahasia**: isi lalu **Seal** (lihat catatan di bawah) |
| `ADMIN_TOKEN` | teks acak ≥ 24 karakter, mis. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` | **Rahasia**: isi lalu **Seal**; simpan salinan di pengelola kata sandi Anda |
| `DATA_DIR` | `/data` | biasa |
| `ALLOWED_ORIGINS` | `https://victorhome0209-gif.github.io` | biasa |
| `TRUST_PROXY` | `true` | biasa |
| `PAID_API_ENABLED` | `false` dulu | biasa |
| `MONTHLY_BUDGET_USD` | `2` untuk fase uji | biasa |
| `REFUND_ON_PROVIDER_5XX` | `false` | biasa |
- **`ALLOWED_ORIGINS` adalah origin, bukan URL halaman:** hanya skema dan host, tanpa `/penerjemah-realtime/` dan tanpa garis miring di akhir. Alamat halaman `https://victorhome0209-gif.github.io/penerjemah-realtime/` menghasilkan origin `https://victorhome0209-gif.github.io`. Origin lain (termasuk domain khusus di masa depan) ditolak 403.
- Biarkan **tidak ada**: `PORT`, `ALLOW_ANY_ORIGIN`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ENABLE_ANTHROPIC`, `ENABLE_ELEVENLABS`, `DATA_LOCK` (bawaan `true`).
- **Seal (terverifikasi di dokumentasi Railway):** menu titik tiga di samping variabel → Seal. Nilai tersegel tidak pernah terlihat lagi di UI maupun API, tetap diteruskan ke deployment, **tidak bisa di-unseal**, tidak bisa diubah lewat Raw Editor (ubah lewat menu titik tiga), dan tidak disalin ke PR environment. Karena nilainya tak terbaca lagi, simpan `ADMIN_TOKEN` di tempat Anda sendiri.
- Perubahan variabel **tidak otomatis men-deploy**: Railway menampung sebagai perubahan bertahap yang harus Anda tinjau lalu deploy.
- Tulis kunci OpenAI **hanya** di Railway. Frontend tidak pernah memegang kunci; ia memakai kode akses `VB-…`.

## 3. Satu instance dan Volume
- **Mengapa satu:** penyimpanan berkas JSON hanya aman untuk satu proses. Dokumentasi Railway tidak menyatakan apakah layanan ber-Volume boleh punya banyak replika, jadi jangan dinaikkan.
- **Pengaman di aplikasi (V1.1.1):** backend membuat `/data/vocalbridge.lock` dengan detak berkala. Proses kedua pada Volume yang sama **menolak start** dengan pesan "folder data dikunci oleh proses lain". Ini melindungi data bila dua deploy sempat bertumpang tindih. Setelah crash atau SIGKILL, restart menunggu paling lama `LOCK_STALE_MS` (15 detik) lalu mengambil alih. Ini normal.
- **Izin Volume:** dokumentasi Railway: Volume dipasang sebagai `root`; bila image berjalan sebagai non-root, set `RAILWAY_RUN_UID=0`. Dockerfile saat ini berjalan sebagai root, jadi tidak perlu. Bila nanti diubah ke non-root, tambahkan variabel itu.
- **Volume dipasang saat container start, bukan saat build.** Jangan menulis ke `/data` saat build.
- **Cadangan:** layanan ber-Volume mendukung cadangan manual dan otomatis (lihat referensi Backups Railway). Aktifkan sebelum menerima saldo nyata. Ubah ukuran Volume hanya di paket berbayar.
- **Sebelum menerima saldo nyata:** bukti Volume bekerja (bagian 4, langkah 7).

## 4. Urutan langkah (Anda yang menjalankan, setelah PR disetujui)
1. Tinjau dan **merge PR V1.1 sendiri** ke `main` (saya tidak merge).
2. Railway → New Project → Deploy from GitHub repo → pilih repo. Segera set **Root Directory** `/backend` sebelum deploy pertama berjalan (atau batalkan deploy pertama yang gagal).
3. Tambahkan **Volume**, mount `/data`.
4. Isi variabel bagian 2. Biarkan `PAID_API_ENABLED=false`.
5. Deploy. Pastikan jumlah replika **1**.
6. Cek log, harus ada baris JSON `"msg":"VocalBridge backend jalan"` dengan `"data_lock":true` dan `"recovered":{"failed":0,"unknown":0}`. Peringatan yang **wajar**: model `gpt-4o-mini-tts` deprecated (berhenti 2027-01-06). Tidak boleh ada `fatal`.
7. **Bukti Volume:** `POST /admin/codes` membuat kode uji, lalu **restart/redeploy**, lalu `GET /admin/codes` masih memuat kode itu. Bila hilang, **berhenti**: Volume belum terpasang di `/data`.
8. `GET https://ALAMAT/api/health` → `{"ok":true,"paid_enabled":false,"store_ok":true}`.
9. Uji keamanan S1–S6 di `docs/UJI-NYATA.md` bagian B (tanpa biaya).
10. (V1.2: tanpa alamat ini aplikasi hanya menampilkan "Layanan AI belum terhubung." dan tidak menerjemahkan apa pun.) Isi `VB_CONFIG.API_BASE` di `index.html` dengan alamat Railway (alamat publik, bukan rahasia) melalui PR terpisah, atau tempel di Pengaturan aplikasi.
11. Pasang **hard spend limit (Enforce a hard limit) dan spend alert di project OpenAI khusus**, lalu baru ikuti `docs/UJI-NYATA.md` bagian C untuk menyalakan `PAID_API_ENABLED=true` dengan biaya terbatas.

## 5. Healthcheck dan pengamanan
- Endpoint `/api/health` publik dan tidak membocorkan kunci. Permintaan tanpa header `Origin` (healthcheck, curl) diizinkan; hanya permintaan yang membawa `Origin` asing yang ditolak 403, dan server tidak menyaring header Host. Dokumentasi Railway tidak membahas header Origin pada healthcheck, jadi cukup pastikan deploy pertama lulus. Layanan ber-Volume dapat mengalami henti singkat saat deploy ulang (menurut Railway, agar data tidak rusak); penjaga satu instance menahan proses baru sampai kunci lama bebas.
- Kunci admin dan kode akses hanya lewat HTTPS (domain Railway bersertifikat). `TRUST_PROXY=true` agar pembatas per IP membaca IP klien dari proxy Railway.

## 6. Operasi
- **Matikan darurat:** `POST /admin/kill {"enabled":false}`, atau `PAID_API_ENABLED=false`, atau cabut `OPENAI_API_KEY`.
- **Ganti kunci:** buat kunci baru, ganti `OPENAI_API_KEY`, redeploy, cabut kunci lama (lihat `docs/BACKEND.md` bagian 9).
- **Rollback:** deploy ulang commit sebelumnya dari Railway. Format data v3 kompatibel mundur untuk bacaan v2 tidak dijamin: **cadangkan Volume sebelum memperbarui versi**.
- **Pantau:** `GET /admin/usage`, `GET /admin/transactions?state=UNKNOWN`, `GET /admin/audit`.
- **Biaya Railway** (layanan + Volume) terpisah dari biaya OpenAI; cek halaman harga Railway sebelum membuat proyek.

## 7. Tanpa deploy otomatis dari branch pengembangan
- Workflow GitHub di repo ini hanya menjalankan tes (`contents: read`, tanpa secrets, tanpa langkah deploy). Ada pemeriksaan otomatis (`tests/dependency-check.js`) yang gagal bila workflow memuat deploy atau izin tulis.
- GitHub Pages tidak diubah oleh PR ini; Pages tetap mengikuti pengaturan yang sudah ada. Periksa Settings → Pages bahwa sumbernya `main`, bukan `vocalbridge-v1.1`.
- Di Railway, hubungkan hanya `main`, dan kebijakan merge ke `main` ada di tangan Anda.

## 8. Yang tidak dilakukan
Tidak membuat proyek Railway, Volume, domain, atau variabel; tidak memasukkan kunci; tidak men-deploy; tidak mengubah DNS. Semuanya menunggu persetujuan Anda.
