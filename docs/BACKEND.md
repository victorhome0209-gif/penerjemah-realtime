# Panduan backend VocalBridge

Backend ada di folder `backend/`. Dasarnya adalah backend tanpa dependensi dari sesi sebelumnya (kode akses ber-hash, kredit, endpoint admin), kini dengan tahan/kembalikan kredit, idempotensi, batas anggaran, validasi audio, timeout, dan kontrak provider.

## 1. Di mana memasukkan OPENAI_API_KEY
Hanya di **Variables / Secrets** hosting backend (Railway: tab Variables). Jangan di GitHub, `index.html`, atau GitHub Actions variables.
Untuk uji lokal: salin `backend/.env.example` menjadi `backend/.env`, isi nilainya, lalu jalankan `node --env-file=.env server.js` di folder `backend`. File `.env` diabaikan git.

Variabel penting (daftar lengkap di `backend/.env.example`):
| Variabel | Fungsi |
|---|---|
| `OPENAI_API_KEY` | Kunci OpenAI (rahasia). |
| `ADMIN_TOKEN` | Token admin, acak minimal 24 karakter (rahasia). |
| `ALLOWED_ORIGINS` | Alamat frontend yang boleh memanggil, mis. `https://victorhome0209-gif.github.io`. |
| `PAID_API_ENABLED` | **Bawaan `false`.** Panggilan berbayar mati sampai diubah `true`. |
| `MONTHLY_BUDGET_USD` | Batas perkiraan pengeluaran API per bulan. Layanan berhenti otomatis bila terlampaui. |
| `DATA_DIR` | Folder penyimpanan kredit. Di hosting arahkan ke Volume permanen, mis. `/data`. |
| `TRUST_PROXY` | `true` bila di belakang proxy hosting agar IP klien terbaca. |

`ANTHROPIC_API_KEY` dan `ELEVENLABS_API_KEY` boleh dikosongkan. Providernya mati di V1 (`ENABLE_ANTHROPIC=false`, `ENABLE_ELEVENLABS=false`).

## 2. Menetapkan origin frontend
Isi `ALLOWED_ORIGINS` dengan alamat GitHub Pages Anda tanpa garis miring di akhir. Beberapa alamat dipisah koma. Origin lain ditolak 403. CORS **bukan** pengganti autentikasi: semua endpoint `/api/*` tetap butuh kode akses.

## 3. Menyewa di Railway (disarankan, belum dilakukan)
1. Railway: New Project → Deploy from GitHub repo → pilih repo ini, lalu atur **Root Directory** ke `backend` (menu bisa berbeda, cek dokumentasi Railway).
2. Tab Variables: isi variabel di atas. Biarkan `PAID_API_ENABLED=false` dulu.
3. Tab Volumes: tambahkan Volume di `/data` dan set `DATA_DIR=/data`.
4. Generate Domain. Buka `https://ALAMAT/api/health`: harus tampil `"ok": true, "paid_enabled": false`.
5. Isi alamat itu di `index.html` (`VB_CONFIG.API_BASE`) atau di Pengaturan aplikasi.
Jangan men-deploy sebelum Anda menyetujui. Domain khusus dan pembelian domain tidak termasuk.

## 4. Membuat kode akses tester
```
curl -X POST https://ALAMAT/admin/codes \
  -H "X-Admin-Token: ADMIN_TOKEN_ANDA" -H "Content-Type: application/json" \
  -d '{"name":"Tester 1","credits":60,"expires_days":3,"daily_calls":100}'
```
Balasan memuat `code` (`VB-...`). Tampil **sekali**. Daftar kode: `GET /admin/codes`. Isi ulang atau nonaktifkan: `POST /admin/topup` dengan `{"id":"...","credits":50}` atau `{"id":"...","credits":0,"disabled":true}`.

## 5. Menonaktifkan API bila biaya melebihi batas
Dari yang tercepat:
1. `curl -X POST https://ALAMAT/admin/kill -H "X-Admin-Token: ..." -d '{"enabled":false}'` (tombol darurat, tersimpan di berkas data). Aktifkan lagi dengan `{"enabled":true}`.
2. Ubah `PAID_API_ENABLED=false` di hosting lalu restart.
3. Hapus atau ganti `OPENAI_API_KEY`.
4. Pasang juga **batas belanja di dashboard OpenAI** sebagai pengaman terakhir (langkah Anda sendiri).
Pantau: `GET /admin/usage` menampilkan perkiraan pengeluaran bulan ini terhadap batas.

## 6. Mengganti API key tanpa mengubah frontend
Buat kunci baru di dashboard OpenAI, ganti nilai `OPENAI_API_KEY` di hosting, restart, lalu cabut kunci lama. Frontend tidak berubah karena tidak pernah memegang kunci.

## 7. Menjalankan pengujian
```
cd backend && node --test test/*.test.js     # 43 tes, layanan OpenAI palsu, tanpa biaya
node tests/static-check.js                   # pemindai rahasia
node tests/regress.js                        # regresi QA Lab vs versi lama
npm run test:e2e                             # tes browser (butuh Playwright)
```

## 8. Perlindungan yang ada
Autentikasi kode akses ber-hash; batas laju per kode dan per IP; batas percobaan salah per IP; validasi WAV (header, durasi maksimal 30 detik, ukuran); batas teks; timeout 20 detik ke OpenAI; **tahan lalu konfirmasi atau kembalikan kredit**; `Idempotency-Key` wajib (pengulangan tidak memotong dua kali); batas harian per kode; batas anggaran bulanan dan tombol darurat; CORS terbatas; log satu baris tanpa audio, teks, header, atau kunci (kunci disamarkan bila muncul di galat penyedia).

## 9. Model OpenAI (diperiksa 29 Okt 2026, verifikasi ulang sebelum uji nyata)
| Fungsi | Model | Catatan |
|---|---|---|
| Pengenal suara | `gpt-transcribe` | Model lama `gpt-4o-mini-transcribe` deprecated, berhenti 26 Feb 2027. Kolom bahasa dikirim sebagai `languages[]`; bila ditolak, otomatis dicoba `language`. |
| Terjemahan | `gpt-6-luna` | Lewat `/v1/chat/completions` dengan `reasoning_effort: none`. Bila parameter ditolak, dicoba tanpa itu. |
| Suara | `gpt-4o-mini-tts` | **Deprecated, berhenti 6 Jan 2027.** Penggantinya memakai Realtime API sehingga perlu `TTSProvider` baru sebelum tanggal itu. |
Harga bisa berubah. Anggaran di `.env.example` adalah perkiraan.
Keluaran suara OpenAI wajib diberi tahu kepada pengguna sebagai suara AI (sudah ada di persetujuan dan Pengaturan).
