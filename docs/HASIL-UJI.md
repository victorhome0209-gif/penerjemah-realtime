# Hasil uji VocalBridge V1

Tiga jenis bukti dipisahkan. Hanya yang bertanda NYATA membuktikan perilaku di dunia nyata.

## 1. Tes OTOMATIS (tanpa jaringan penyedia, tanpa biaya) — LULUS
| Rangkaian | Perintah | Hasil |
|---|---|---|
| Backend: autentikasi, CORS, kredit, idempotensi, batas, log aman | `cd backend && node --test test/*.test.js` | 43/43 |
| Pemindai keamanan statis | `node tests/static-check.js` | 17/17 |
| Regresi QA Lab vs versi lama (commit 243b77b) | `node tests/regress.js` | 20/20 |
Uji mutasi dilakukan: kode dirusak sengaja (refund dimatikan, cache idempotensi dimatikan, kunci dibocorkan ke log, kunci ditanam di frontend) dan tes terkait gagal sebagaimana mestinya.

## 2. Tes SIMULASI (Chromium + mikrofon palsu + OpenAI palsu) — LULUS
`npm run test:e2e` : 82/82. Memakai halaman asli dan backend asli, tetapi OpenAI dipalsukan, mikrofon adalah file nada berulang, dan SpeechRecognition serta getDisplayMedia dipalsukan di tes tertentu.
Mencakup: konsen sebelum izin audio; lawan otomatis; Saya Bicara menjeda lawan; empat teks; satu STT pada satu waktu; salin, putar ulang (cache tanpa biaya), koreksi; riwayat opt-in, ekspor, hapus; tidak ada panggilan ke penyedia dari browser; tidak ada kunci di localStorage; Hentikan melepas mikrofon; tab "terverifikasi" hanya setelah sinyal; kredit habis dan layanan nonaktif; respons hilang lalu retry tanpa potong ganda; mode Gratis; layout HP (Pixel 7) dan desktop; QA Lab.

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
