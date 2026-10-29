# Panduan backend VocalBridge (diperbarui setelah remediasi)

Backend ada di folder `backend/`. Dasarnya adalah backend tanpa dependensi dari sesi sebelumnya (kode akses ber-hash, kredit, endpoint admin). Versi 1.1.0 menambah mesin status transaksi, pemulihan aman saat restart, rekonsiliasi admin, validasi admin dan konfigurasi yang ketat, serta provider OpenAI tanpa percobaan ulang.

## 1. Di mana memasukkan OPENAI_API_KEY
Hanya di **Variables / Secrets** hosting backend (Railway: tab Variables). Jangan di GitHub, `index.html`, atau GitHub Actions variables.
Uji lokal: salin `backend/.env.example` menjadi `backend/.env`, isi nilainya, lalu `node --env-file=.env server.js` di folder `backend`. File `.env` diabaikan git.

Server **menolak start** bila ada nilai konfigurasi yang ditulis tetapi rusak (huruf pada angka, biaya nol atau negatif, boolean ambigu, format suara tidak dikenal). Pesan alasannya dicetak sebelum keluar.

| Variabel | Fungsi |
|---|---|
| `OPENAI_API_KEY` | Kunci OpenAI (rahasia). |
| `ADMIN_TOKEN` | Token admin, acak minimal 24 karakter (rahasia). |
| `ALLOWED_ORIGINS` | Alamat frontend yang boleh memanggil, mis. `https://victorhome0209-gif.github.io`. |
| `PAID_API_ENABLED` | **Bawaan `false`.** Panggilan berbayar mati sampai diubah `true`. |
| `MONTHLY_BUDGET_USD` | Batas INTERNAL berbasis perkiraan (lihat bagian 6). |
| `REFUND_ON_PROVIDER_5XX` | Bawaan `false`: 5xx dari OpenAI = status belum pasti (UNKNOWN). |
| `MAX_BALANCE`, `ADMIN_MAX_CREDITS_PER_OP` | Batas saldo total per kode dan kredit per operasi admin. |
| `DATA_DIR` | Folder data. Di hosting arahkan ke Volume permanen, mis. `/data`. |
| `TRUST_PROXY` | `true` bila di belakang proxy hosting agar IP klien terbaca. |
Daftar lengkap dengan komentar ada di `backend/.env.example`. `ANTHROPIC_API_KEY` dan `ELEVENLABS_API_KEY` boleh kosong: providernya mati di V1.

## 2. Menetapkan origin frontend
Isi `ALLOWED_ORIGINS` dengan alamat GitHub Pages tanpa garis miring di akhir; beberapa alamat dipisah koma. Origin lain ditolak 403. CORS **bukan** pengganti autentikasi: semua `/api/*` tetap butuh kode akses, semua `/admin/*` butuh token admin.

## 3. Menyewa di Railway (disarankan, belum dilakukan)
1. New Project → Deploy from GitHub repo → pilih repo ini, **Root Directory** `backend` (menu bisa berbeda, cek dokumentasi Railway).
2. Variables: isi variabel di atas. Biarkan `PAID_API_ENABLED=false` dulu.
3. Volumes: tambahkan Volume di `/data` dan set `DATA_DIR=/data`. **Tanpa Volume, saldo dan transaksi hilang saat restart.** Panduan lengkap: `docs/RAILWAY.md`.
4. Generate Domain, lalu `https://ALAMAT/api/health` harus menampilkan `"ok": true, "paid_enabled": false, "store_ok": true`.
5. Jalankan **hanya satu instance**. Backend menegakkannya sendiri: `vocalbridge.lock` di `DATA_DIR` membuat proses kedua menolak start (`DATA_LOCK`, `LOCK_STALE_MS`, `LOCK_WAIT_MS`).
Jangan men-deploy sebelum Anda menyetujui.

## 4. Mesin status transaksi
Setiap permintaan berbayar (STT, terjemahan, suara) adalah satu transaksi dengan satu `Idempotency-Key`.

| Status | Arti | Kredit |
|---|---|---|
| PENDING | Sedang diproses. `sent_at` ditulis ke disk **sebelum** permintaan keluar ke OpenAI | ditahan |
| CONFIRMED | OpenAI berhasil | terpakai |
| FAILED | **Pasti** tidak ditagih: OpenAI menolak (4xx) atau permintaan pasti tidak terkirim (koneksi ditolak, DNS, TLS) | dikembalikan |
| UNKNOWN | Hasil di OpenAI **tidak diketahui**: timeout, koneksi putus, 5xx, respons rusak, atau server mati saat memproses | **tetap ditahan** |

Transisi sah: PENDING → CONFIRMED / FAILED / UNKNOWN, dan UNKNOWN → CONFIRMED / FAILED (hanya admin). Kode menolak transisi lain.
Aturan keselamatan: kredit **tidak pernah** dikembalikan otomatis untuk permintaan yang statusnya belum pasti, dan kunci idempotensi UNKNOWN terkunci (409 `txn_unknown`) sehingga tidak bisa ditagihkan lagi dengan kunci yang sama.

### Saat backend restart
Saat start, `store.recover()` memeriksa transaksi PENDING warisan: yang **belum dikirim** menjadi FAILED dan dikembalikan (OpenAI tidak pernah dihubungi); yang **sudah dikirim** menjadi UNKNOWN dan kreditnya tetap ditahan. Hasilnya dicetak di log start (`recovered`). Penyapu berkala hanya memeriksa transaksi yatim, tidak menyentuh transaksi yang sedang dikerjakan proses itu.

### Kegagalan penyimpanan
Bila data tidak dapat ditulis, permintaan baru ditolak (503 `store_unavailable`) **sebelum** menghubungi OpenAI. `/api/health` menampilkan `store_ok:false`.

### Hasil permintaan yang hilang
Server tidak menyimpan hasil (teks) ke disk. Bila respons CONFIRMED hilang dan server restart, kirim ulang kunci yang sama dijawab 409 `idem_conflict` (tidak dipotong lagi); pengguna mengulang ucapan dengan kunci baru (kredit dihitung lagi, sama seperti pekerjaan yang memang ditagih OpenAI dua kali).

## 5. Rekonsiliasi transaksi UNKNOWN (admin)
Pantau: `GET /admin/usage` (jumlah per status dan `unknownCredits`) dan `GET /admin/transactions?state=UNKNOWN`.
Backend mengirim **ID transaksi** sebagai header `X-Client-Request-Id` ke OpenAI. Dokumentasi OpenAI menyatakan nilai ini dicatat dan dapat dibagikan ke dukungan OpenAI untuk memeriksa apakah dan kapan permintaan diterima. Dokumentasi menyebut dukungan untuk chat/completions, embeddings, dan responses; untuk endpoint audio **belum terkonfirmasi**, jadi perlu diverifikasi saat uji nyata.
Langkah:
1. Ambil daftar UNKNOWN (`txn`, `created`, `sent_at`, `kind`, `reason`).
2. Cocokkan dengan log atau penggunaan di dashboard OpenAI pada waktu yang sama, atau tanyakan ke dukungan OpenAI dengan ID transaksi.
3. Putuskan:
   - `confirm`: OpenAI menagih dan hasilnya hilang. Kredit pengguna terpakai.
   - `refund`: OpenAI **tidak** menagih. Kredit kembali dan anggaran estimasi dilepas.
   - `refund_keep_cost`: OpenAI menagih, tetapi Anda mengganti kredit pengguna (itikad baik). Kredit kembali, estimasi biaya tetap tercatat.
```
curl -X POST https://ALAMAT/admin/transactions/resolve -H "X-Admin-Token: ..." -H "Content-Type: application/json" \
  -d '{"txn":"ID_TRANSAKSI","resolution":"confirm","note":"terlihat di log OpenAI","request_id":"resolve-0001"}'
```
`request_id` wajib (8-64 karakter) agar pengulangan perintah tidak mengubah saldo dua kali; `note` wajib. Hanya UNKNOWN yang dapat direkonsiliasi. Tidak ada penyelesaian otomatis berdasarkan waktu.
`GET /admin/audit` memeriksa konsistensi (saldo, kredit ditahan, status) dan harus mengembalikan `{"issues":[]}`.

## 6. Dua lapis batas biaya: jangan disamakan
| | Batas INTERNAL (`MONTHLY_BUDGET_USD`) | Batas di DASHBOARD OpenAI |
|---|---|---|
| Dasar | **Perkiraan** dari durasi audio, jumlah karakter, harga yang Anda isi | Tagihan nyata OpenAI |
| Bisa salah | Ya: harga berubah, estimasi TTS dari karakter, model baru | Tidak (ini angka resmi) |
| Mengikat | Hanya menghentikan backend ini | Menghentikan semua pemakaian kunci |
| Siapa yang mengatur | Variabel hosting | **Anda, manual**, di dashboard OpenAI |
Backend tidak dapat membaca batas dashboard. Pasang **keduanya**; isi batas internal tidak lebih dari separuh batas dashboard. `/admin/usage` menampilkan `estimate.basis = "perkiraan internal, bukan tagihan"`, bagian UNKNOWN (`includesUnknownUsd`), dan `reportedByProvider` (detik audio dan token yang dilaporkan OpenAI di respons) sebagai pembanding, tetapi semuanya tetap bukan tagihan. Transaksi UNKNOWN **tetap dihitung** dalam estimasi.

## 7. Admin API
Semua endpoint admin memakai header `X-Admin-Token`, dibatasi percobaan salah per IP, dan perubahan dicatat di `GET /admin/log` (tanpa kode akses atau token).
| Endpoint | Fungsi |
|---|---|
| `POST /admin/codes` `{name, credits, expires_days?, daily_calls?}` | Buat kode. `credits` bilangan bulat 1..`ADMIN_MAX_CREDITS_PER_OP`. |
| `GET /admin/codes` | Daftar (id 8 karakter, saldo, ditahan, UNKNOWN). |
| `POST /admin/topup` `{id, credits, request_id}` | **Hanya menambah**. `request_id` wajib. Pengulangan = `replayed:true`, saldo tidak berubah. |
| `POST /admin/adjust` `{id, delta, reason, request_id}` | Mengurangi (`delta` negatif). Tidak boleh membuat saldo negatif, tidak menyentuh kredit ditahan, alasan wajib. |
| `POST /admin/disable` `{id, disabled, request_id}` | `disabled` harus `true`/`false` sungguhan (teks `"false"` ditolak). |
| `GET /admin/transactions?state=` | Daftar transaksi. |
| `POST /admin/transactions/resolve` | Rekonsiliasi UNKNOWN (bagian 5). |
| `GET /admin/usage`, `/admin/log`, `/admin/audit` | Ringkasan biaya, log admin, pemeriksaan konsistensi. |
| `POST /admin/kill` `{enabled:false}` | Tombol darurat. |
**Perubahan yang memecahkan kompatibilitas** dibanding V1: `topup` kini butuh `request_id`, tidak menerima `disabled`, dan menolak nilai selain bilangan bulat positif; id harus 8+ karakter heksadesimal dan cocok persis satu kode.

## 8. Menonaktifkan API bila biaya melebihi batas
1. `POST /admin/kill {"enabled":false}` (tersimpan; aktifkan lagi dengan `true`).
2. `PAID_API_ENABLED=false` di hosting lalu restart.
3. Hapus atau ganti `OPENAI_API_KEY`.
4. Batas belanja di dashboard OpenAI.

## 9. Mengganti API key tanpa mengubah frontend
Buat kunci baru, ganti `OPENAI_API_KEY` di hosting, restart, cabut kunci lama. Restart aman: transaksi yang sedang berjalan menjadi UNKNOWN (bagian 4), bukan hilang atau ganda. Sebaiknya ganti kunci saat tidak ada pemakaian.

## 10. Provider OpenAI: satu permintaan, tanpa fallback
- Setiap transaksi = tepat **satu** permintaan HTTP ke OpenAI. Tidak ada percobaan ulang atau fallback otomatis. Penolakan 400 = gagal, kredit kembali, pesan jelas.
- Parameter eksplisit dari konfigurasi (bagian `.env.example`), diverifikasi 29 Okt 2026 terhadap referensi API dan sumber SDK `openai-node`:

| Fungsi | Model | Permintaan |
|---|---|---|
| STT | `gpt-transcribe` | multipart: `file`, `model`, `languages[]` (model lama: `language`; tidak pernah keduanya). `response_format` dihilangkan. |
| Terjemahan | `gpt-6-luna` | `/v1/chat/completions`: `model`, `messages` (peran `developer`), `max_completion_tokens`, `reasoning_effort: none`, `store: false`, `safety_identifier`. Tanpa `temperature`. |
| Suara | `gpt-4o-mini-tts` | `/v1/audio/speech`: `model`, `voice`, `input`, `response_format`, `instructions`. |
- Peringatan saat start dan di `/admin/usage`: model **deprecated** (`gpt-4o-mini-tts` berhenti 2027-01-06; model STT lama 2027-02-26) dan model tak dikenal.
- Hal yang baru terbukti saat uji nyata: `reasoning_effort: none` pada `gpt-6-luna`, header `X-Client-Request-Id` pada endpoint audio, dan kualitas suara.

## 11. Klon suara (fitur Pro nonaktif)
Modul Suara Saya dipertahankan di aplikasi, tetapi pembuatan klon hanya bisa berjalan bila server menyatakan `features.voice_clone.enabled` pada `/api/me`. Saat ini selalu `false` dan `POST /api/clone` membalas 503 `feature_disabled`. Mengaktifkannya butuh implementasi backend (ElevenLabs lewat transaksi yang sama) dan persetujuan.

## 12. Menjalankan pengujian
```
cd backend && node --test test/*.test.js      # 88 tes, OpenAI palsu ketat, tanpa biaya (termasuk restart SIGKILL sungguhan)
node tests/static-check.js                    # pemindai rahasia dan penjaga regresi
node tests/regress.js                         # regresi QA Lab vs versi lama
npm install && npx playwright install chromium && npm run test:e2e   # 99 tes browser (simulasi)
node tests/repro-masalah.js backend           # reproduksi masalah P0/P1 (harus menunjukkan kondisi aman)
```
Log mentah hasil terakhir ada di `docs/bukti/`.
