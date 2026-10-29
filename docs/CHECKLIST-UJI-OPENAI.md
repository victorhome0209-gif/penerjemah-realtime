# Daftar periksa uji OpenAI nyata (V1.2 API-only)

**Belum dijalankan.** Mulai hanya setelah pemilik akun memberi izin. Jangan menempelkan API key di chat; isi hanya di Railway.
Biaya acuan: satu giliran kalimat pendek = 4 kredit (STT 2 + terjemahan 1 + suara 1). Anggaran internal hanya perkiraan; batas di dashboard OpenAI yang mengikat.

## 0. Prasyarat (tindakan pemilik)
- [ ] OpenAI: buat **project khusus** VocalBridge dan kunci BARU di project itu. Project settings > Limits > Spend > Edit spend limit > isi Monthly spend limit kecil (mis. US$5) > nyalakan **Enforce a hard limit** > Save. Itu satu-satunya yang benar-benar menghentikan biaya (429 `project_spend_limit_exceeded`).
- [ ] Pasang **spend alert** di bawah hard limit (mis. 50% dan 80%). Alert HANYA notifikasi; lalu lintas tetap jalan. Jangan dianggap batas.
- [ ] Pertahankan budget guard internal `MONTHLY_BUDGET_USD` (perkiraan, ikut berhenti sendiri) di bawah separuh hard limit.
- [ ] Ingat: penegakan hard limit tidak instan, pengeluaran bisa sedikit melampaui angka batas; ada juga batas penggunaan per tier dari OpenAI yang terpisah.
- [ ] Railway, proyek TERPISAH `vocalbridge-backend`: Root Directory `/backend`, satu instance, Volume `/data`, `DATA_DIR=/data`, `ALLOWED_ORIGINS=https://victorhome0209-gif.github.io`, `TRUST_PROXY=true`, `MONTHLY_BUDGET_USD=2`, `PAID_API_ENABLED=false`.
- [ ] `OPENAI_API_KEY` dan `ADMIN_TOKEN` diisi di Railway lalu di-Seal (tidak pernah di chat, GitHub, atau frontend).
- [ ] `GET /api/health` menjawab `paid_enabled:false`; log start memuat `"data_lock":true`.
- [ ] Bukti Volume: buat kode uji, redeploy, kode masih ada.

## 1. Keamanan tanpa biaya (PAID_API_ENABLED=false)
- [ ] `GET /api/me` tanpa token -> 401; Origin asing -> 403; `/admin/codes` tanpa token -> 401.
- [ ] Dengan kode valid, `/api/translate` -> 503 `paid_disabled`; kredit tidak berubah.
- [ ] Di aplikasi: Saya Bicara menampilkan "Layanan AI belum terhubung. Layanan AI sedang dinonaktifkan oleh administrator."; mikrofon tidak diminta.
- [ ] DevTools: localStorage tanpa kunci/kode; Network tanpa permintaan ke api.openai.com atau MyMemory.

## 2. Menyalakan biaya terbatas (setelah izin)
- [ ] Kode uji: 60 kredit, kedaluwarsa 3 hari, `daily_calls` 100. `PAID_API_ENABLED=true`, restart. `/admin/usage` mendekati 0.
- [ ] Aplikasi terhubung, lencana menampilkan kredit.

## 3. Fungsi dan akurasi (sekitar 30 ucapan, perkiraan < US$0,05)
| # | Area | Cara uji | Lulus bila | Hasil |
|---|---|---|---|---|
| T1 | STT Indonesia | 5 kalimat Dialog A | Teks benar; angka dan nama dicatat | |
| T2 | STT Inggris | 5 kalimat dari rekaman/speaker | Teks benar | |
| T3 | STT hening/derau | Diam 10 dtk, lalu bising | Tidak ada kartu palsu ("thanks for watching" disaring) | |
| T4 | Terjemahan | Hasil T1/T2 | Wajar; konteks 4 giliran terakhir dipakai | |
| T5 | TTS Inggris dan Indonesia | Dengar suara tiap giliran | Terdengar, dapat dimengerti, tanpa terpotong | |
| T6 | Parameter OpenAI pertama kali | Lihat log OpenAI/server | `gpt-transcribe` menerima `languages[]`; `gpt-6-luna` menerima `reasoning_effort`, `store:false`, peran developer; `X-Client-Request-Id` diterima. Ditolak 400 = gagal bersih, ubah variabel `OPENAI_*` | |

## 4. Latensi (catat tiap giliran, 10 giliran)
- [ ] Ucapan selesai -> teks asli tampil: target < 2 dtk (STT).
- [ ] -> terjemahan tampil: target total < 3 dtk.
- [ ] -> suara mulai: target total < 4 dtk. Catat median dan terburuk. Di atas 6 dtk = tidak layak untuk rapat.

## 5. Giliran bicara
- [ ] Sesi dimulai: lawan didengar otomatis tanpa tombol.
- [ ] Tekan Saya Bicara saat lawan bicara: lawan dijeda, ucapan tidak tercampur.
- [ ] 10 giliran bergantian: tidak ada dua pemrosesan STT bersamaan, tidak macet, kembali mendengar lawan tiap kali.
- [ ] Tekan Selesai Bicara / diam 1 dtk: pindah ke proses; tombol "Memproses" tidak bisa ditekan ganda.

## 6. Anti-echo
- [ ] Dengan speaker (tanpa earphone): suara terjemahan tidak dikenali lagi sebagai ucapan lawan (tidak ada kartu "Lawan" berisi terjemahan sendiri).
- [ ] Dengan earphone: sama. Catat jeda 0,7 dtk setelah suara selesai sudah cukup atau perlu dinaikkan.
- [ ] Audio tab (Chrome desktop, Meet): "terverifikasi" hanya muncul saat suara peserta terdeteksi.

## 7. Kredit dan batas biaya
- [ ] Kredit berkurang sesuai (kalimat pendek = 4); `/admin/usage` vs dashboard OpenAI: catat selisih.
- [ ] Kredit habis: kartu menampilkan "Kredit habis", tidak negatif, tidak ada panggilan.
- [ ] `daily_calls` terlampaui: pesan batas harian.
- [ ] `MONTHLY_BUDGET_USD` rendah sengaja: layanan berhenti dengan pesan anggaran.
- [ ] Hard limit tercapai (uji hanya bila aman, mis. batas sangat kecil di project uji): aplikasi menampilkan "batas biaya atau kuota ... hubungi administrator" (bukan "sibuk"); kredit tidak terpotong.
- [ ] `POST /admin/kill {"enabled":false}`: sesi berikutnya diblokir dengan pesan jelas; sesi berjalan gagal bersih.
- [ ] `/admin/transactions?state=UNKNOWN` kosong; `/admin/audit` `issues: []`.

## 8. Kegagalan layanan (tiap butir: pesan jelas, tidak ada jalur gratis)
- [ ] Matikan Railway/ubah alamat: "Layanan AI belum terhubung. Server tidak terjangkau".
- [ ] Kode akses salah/kedaluwarsa: ditolak, kode dihapus dari tab.
- [ ] Putus internet saat giliran: kartu gagal, kredit tidak terpotong ganda (kunci idempotensi sama).
- [ ] Restart backend saat request berjalan: status UNKNOWN atau pulih sesuai desain; kredit ditahan, tidak ditagih ganda.
- [ ] Tidak ada panggilan ke MyMemory, SpeechRecognition, atau suara perangkat dalam kondisi apa pun.

## 9. Perangkat (nyata)
| # | Perangkat | Status |
|---|---|---|
| A1 | Android Chrome (HP): mikrofon, earphone, ruang bising | belum diuji |
| A2 | Windows Chrome desktop | belum diuji |
| A3 | Firefox desktop (lihat catatan kompatibilitas) | belum diuji |
| M1 | Chrome desktop + Google Meet, Audio tab | belum diuji |
| M2 | Zoom aplikasi + audio sistem | belum diuji |
| M3 | Android + Meet di speaker | belum diuji |
Jangan menyatakan integrasi Meet/Zoom selesai sebelum M1 sampai M3 dicatat.

## 10. Menghentikan
`POST /admin/kill {"enabled":false}` atau `PAID_API_ENABLED=false`, nonaktifkan kode uji, cek dashboard OpenAI.

## Catatan kompatibilitas (analisis kode, BUKAN hasil uji nyata)
- **Firefox:** Playwright Firefox tidak dapat dipasang di lingkungan pengembangan. Dari kode: pemrosesan audio memakai `AudioContext` + `ScriptProcessor` (didukung tetapi usang), `echoCancellation` dll. didukung. Risiko: Firefox menolak menyambungkan stream yang laju sampelnya berbeda dari `AudioContext` (kasus Bluetooth); pilihan "Audio tab" tersedia di Firefox desktop tetapi Firefox tidak membagikan audio tab, jadi aplikasi menampilkan "Tidak ada audio yang dibagikan" lalu memakai mikrofon; `permissions.query('microphone')` tidak didukung dan ditangani (tulisan "tidak bisa diperiksa").
- **Android Chrome:** diemulasikan hanya di Chromium (profil Pixel 7: tanpa scroll horizontal, opsi Audio tab dinonaktifkan). Pemutaran suara memakai satu elemen audio yang dibuka saat ketukan pertama; perlu dibuktikan di HP nyata (autoplay, layar mati, kunci layar).
