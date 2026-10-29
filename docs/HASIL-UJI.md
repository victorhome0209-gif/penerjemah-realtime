> V1.2: hasil terbaru ada di `docs/V1.2.md` dan `docs/bukti/ringkasan-validasi.txt`. Angka di bawah adalah catatan versi sebelumnya.

# Hasil uji VocalBridge V1

## Validasi terbaru (V1.1.1, `node tests/run-all.js`, 29 Okt 2026) — exit akhir 0
| Rangkaian | Exit | PASS | FAIL |
|---|---|---|---|
| Backend (`node --test`) | 0 | 95 | 0 |
| Pemindai keamanan statis | 0 | 23 | 0 |
| Inventaris dependensi | 0 | 7 | 0 |
| Regresi QA Lab (Chromium) | 0 | 20 | 0 |
| E2E Chromium (simulasi) | 0 | 99 | 0 |
| `npm audit` backend (runtime) | 0 | 0 kerentanan | - |
| `npm audit` akar/dev | 1 | tidak bisa dijalankan: registri npm tidak terjangkau dan tanpa lockfile akar | - |
Ringkasan mentah: `docs/bukti/ringkasan-validasi.txt`. Tes browser butuh Playwright (`npm install && npx playwright install chromium`); tanpa itu `run-all` berhenti dengan exit 2 dan petunjuk, bukan lulus diam-diam. Angka di bagian bawah dokumen ini adalah catatan versi sebelumnya.

Tiga jenis bukti dipisahkan. Hanya yang bertanda NYATA membuktikan perilaku di dunia nyata.

## 1. Tes OTOMATIS (tanpa jaringan penyedia, tanpa biaya) — LULUS (setelah remediasi, backend 1.1.0)
| Rangkaian | Perintah | Hasil |
|---|---|---|
| Backend: autentikasi, CORS, kredit, mesin status transaksi, restart SIGKILL nyata, admin, kontrak OpenAI | `cd backend && node --test test/*.test.js` | 88/88 |
| Pemindai keamanan statis dan penjaga regresi | `node tests/static-check.js` | 23/23 |
| Regresi QA Lab vs versi lama (commit 243b77b) | `node tests/regress.js` | 20/20 |
Uji mutasi: kode dirusak sengaja dan tes terkait gagal sebagaimana mestinya (V1: refund, cache idempotensi, log, kunci di frontend; remediasi: lihat `bukti/mutasi.txt`). Log mentah: `docs/bukti/`.

## 2. Tes SIMULASI (Chromium + mikrofon palsu + OpenAI palsu) — LULUS
`npm run test:e2e` : 99/99 (termasuk restart backend sungguhan saat permintaan berjalan dan modul Suara Saya nonaktif). Memakai halaman asli dan backend asli, tetapi OpenAI dipalsukan, mikrofon adalah file nada berulang, dan SpeechRecognition serta getDisplayMedia dipalsukan di tes tertentu.
Mencakup (selain yang di atas): konsen sebelum izin audio; lawan otomatis; Saya Bicara menjeda lawan; empat teks; satu STT pada satu waktu; salin, putar ulang (cache tanpa biaya), koreksi; riwayat opt-in, ekspor, hapus; tidak ada panggilan ke penyedia dari browser; tidak ada kunci di localStorage; Hentikan melepas mikrofon; tab "terverifikasi" hanya setelah sinyal; kredit habis dan layanan nonaktif; respons hilang lalu retry tanpa potong ganda; mode Gratis; layout HP (Pixel 7) dan desktop; QA Lab.

## 3. Tes NYATA — BELUM DIJALANKAN
Tidak ada panggilan ke OpenAI, tidak ada uji di HP atau Firefox, tidak ada uji dengan Meet atau Zoom. Prosedur: [UJI-NYATA.md](UJI-NYATA.md).
| Uji nyata | Hasil | Tanggal | Catatan |
|---|---|---|---|
| F1–F6 fungsional OpenAI | belum | | |
| A1 Android Chrome | belum | | |
| A2 Laptop Chrome | belum | | |
| A3 Firefox | belum | | |
| M1 Meet tab | belum | | |
| M2 Zoom sistem | belum | | |
| M3 Meet di HP | belum | | |
