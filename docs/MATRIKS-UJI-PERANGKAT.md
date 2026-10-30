# Matriks uji perangkat dan skenario (V1.2 API-only)

**Belum dijalankan.** Semua sel hasil kosong sampai pemilik mengujinya di perangkat nyata setelah tahap 3-4 `docs/RUNBOOK-UJI-LIVE.md`. Matriks ini melengkapi `docs/CHECKLIST-UJI-OPENAI.md` (daftar periksa) dan tidak menggantikannya. Tes otomatis (Chromium emulasi dan server tiruan) bukan bukti untuk sel-sel di sini.

Cara mengisi sel: `L` = lulus, `G` = gagal (catat di kolom catatan), `N/A` = tidak berlaku, kosong = belum diuji.
Kolom perangkat: **C** = Chrome desktop (Windows), **F** = Firefox desktop, **A** = Android Chrome (HP).

## Prasyarat umum
- Tahap 0-3 runbook selesai. Untuk kolom berbayar (bagian 2 dan seterusnya) ada persetujuan tertulis dan kode uji berkredit.
- Earphone kabel tersedia untuk uji anti-echo. Ruang sunyi untuk bagian 2; ruang bising hanya untuk S-12.
- DevTools terbuka di desktop (Network, Application). Di Android pakai remote debugging bila perlu.

## 1. Tanpa biaya (PAID_API_ENABLED=false)
| ID | Skenario | Hasil yang diharapkan | C | F | A | Catatan |
|---|---|---|---|---|---|---|
| S-01 | Buka aplikasi tanpa alamat server/kode | Layar menampilkan "Layanan AI belum terhubung."; Saya Bicara tidak meminta izin mikrofon dan tidak memulai sesi | | | | |
| S-02 | Isi alamat server dan kode benar, layanan berbayar mati | Pesan diawali "Layanan AI belum terhubung." + "Layanan AI sedang dinonaktifkan oleh administrator."; mikrofon tidak diminta | | | | |
| S-03 | Kode salah/kedaluwarsa | Ditolak, kode dihapus dari tab, pesan layanan belum terhubung | | | | |
| S-04 | Network (desktop) saat S-01 sampai S-03 | Tidak ada permintaan ke api.openai.com, MyMemory, atau layanan pengenal suara; penyimpanan lokal tanpa kunci/kode | | N/A | | |
| S-05 | Alamat server salah/server mati | "Layanan AI belum terhubung. Server tidak terjangkau"; tidak ada kartu terjemahan palsu | | | | |

## 2. Fungsi inti (berbayar, kode uji; mulai dari smoke test)
| ID | Skenario | Cara | Hasil yang diharapkan | C | F | A | Catatan |
|---|---|---|---|---|---|---|---|
| S-06 | Indonesia ke Inggris | Ketuk Saya Bicara, ucapkan 5 kalimat Dialog A satu per satu | Teks asli benar; terjemahan Inggris wajar; suara terdengar utuh tanpa terpotong di akhir; 4 kredit per kalimat pendek | | | | |
| S-07 | Inggris ke Indonesia | Putar 5 kalimat Inggris dari HP/speaker lain | Lawan terdengar otomatis tanpa tombol; kartu Lawan berisi teks asli dan terjemahan Indonesia | | | | |
| S-08 | Bergantian 10 giliran | Selang-seling S-06 dan S-07 | Tidak ada dua proses STT bersamaan; kembali mendengar lawan tiap giliran; tombol tidak bisa ditekan ganda saat "Memproses" | | | | |
| S-09 | Saya Bicara saat lawan bicara | Ketuk saat suara lawan masuk | Lawan dijeda, ucapan tidak tercampur | | | | |
| S-10 | Angka dan nama | Ucapkan angka, tanggal, nama orang | Terjemahan mempertahankan makna; catat kesalahan | | | | |
| S-11 | Hening lalu bising | Diam 10 dtk, lalu derau | Tidak muncul kartu palsu ("thanks for watching" disaring) | | | | |
| S-12 | Ruang bising | Ulangi S-06 dengan latar bising | Catat kualitas STT; bukan kriteria lulus/gagal ketat | | | | |

## 3. Mikrofon, speaker, dan anti-echo
| ID | Skenario | Hasil yang diharapkan | C | F | A | Catatan |
|---|---|---|---|---|---|---|
| S-13 | Izin mikrofon: izinkan | Sesi mulai; indikator mikrofon aktif | | | | |
| S-14 | Izin mikrofon: tolak | Pesan jelas; tidak crash; bisa coba lagi setelah izin diberikan | | | | |
| S-15 | Izin dicabut saat sesi | Sesi gagal bersih dengan pesan; tidak ada kartu palsu | | | | |
| S-16 | Speaker bawaan (tanpa earphone) | Suara terjemahan tidak dikenali ulang sebagai ucapan lawan (tidak ada kartu Lawan berisi terjemahan sendiri). Catat apakah jeda 0,7 dtk cukup | | | | |
| S-17 | Earphone kabel | Sama dengan S-16; kualitas lebih baik | | | | |
| S-18 | Earphone Bluetooth | Catat: apakah mikrofon mulai; Firefox bisa menolak stream beda laju sampel (risiko dari analisis kode) | | | | |
| S-19 | Audio tab (Meet/YouTube) | Chrome desktop: "terverifikasi" hanya setelah suara terdeteksi. Firefox: pesan "Tidak ada audio yang dibagikan", lalu memakai mikrofon | | | N/A | |
| S-20 | Pemutaran suara pertama (autoplay) | Suara terjemahan terdengar setelah ketukan pertama; Android: tidak diblokir autoplay | | | | |

## 4. Koneksi terputus dan pemulihan
| ID | Skenario | Hasil yang diharapkan | C | F | A | Catatan |
|---|---|---|---|---|---|---|
| S-21 | Putus internet sebelum mulai sesi | Pesan layanan belum terhubung; tidak ada jalur gratis | | | | |
| S-22 | Putus internet di tengah giliran (STT/terjemahan/suara sedang jalan) | Kartu menampilkan kegagalan; tidak ada teks palsu; kredit tidak terpotong ganda (percobaan ulang memakai kunci idempotensi yang sama) | | | | |
| S-23 | Internet kembali | Giliran berikutnya berjalan normal tanpa memuat ulang halaman; cek kredit (hanya giliran sukses yang memotong) | | | | |
| S-24 | Jaringan lambat (throttle atau sinyal lemah) | Tidak macet; bila melewati batas waktu, kegagalan jelas; kredit konsisten | | | | |
| S-25 | Muat ulang halaman di tengah sesi | Kembali ke keadaan awal; kode akses tetap hanya di sessionStorage tab; mulai ulang sesi berjalan | | | | |
| S-26 | Kill switch dari admin di tengah sesi | Giliran berjalan gagal bersih; sesi baru diblokir "Layanan AI sedang dinonaktifkan" | | | | |
| S-27 | Restart backend di tengah permintaan (pemilik, via Railway) | Status transaksi UNKNOWN atau pulih sesuai desain; kredit ditahan, tidak ditagih ganda; `GET /admin/transactions?state=UNKNOWN` ditinjau | | | | |
| S-28 | Kredit habis | "Kredit habis. Minta administrator mengisi ulang."; tidak negatif; tidak ada panggilan | | | | |
| S-29 | Batas harian/anggaran tercapai | "Batas pemakaian harian tercapai." / "Batas anggaran layanan tercapai. Hubungi administrator." | | | | |
| S-30 | Hard limit OpenAI tercapai | Hanya diuji bila aman (project uji dengan batas sangat kecil): "Batas biaya atau kuota layanan AI tercapai. Hubungi administrator; mencoba lagi tidak membantu."; kredit kembali | | | | |

## 5. Khusus HP (Android)
| ID | Skenario | Hasil yang diharapkan | A | Catatan |
|---|---|---|---|---|
| S-31 | Layar dikunci/dimatikan saat sesi | Catat perilaku (mikrofon biasanya berhenti); setelah dibuka, sesi bisa dilanjutkan atau dimulai ulang dengan pesan jelas | | |
| S-32 | Pindah aplikasi / tab di latar | Sama seperti S-31 | | |
| S-33 | Rotasi layar | Tata letak tidak pecah, tidak ada scroll horizontal, tombol utama terjangkau | | |
| S-34 | Telepon masuk saat sesi | Catat; sesi tidak crash | | |

## 6. Meeting (hanya setelah bagian 1-5 lulus)
| ID | Skenario | Status | Catatan |
|---|---|---|---|
| M1 | Chrome desktop + Google Meet, Audio tab | belum diuji | |
| M2 | Zoom aplikasi + audio sistem (kabel virtual) | belum diuji | |
| M3 | Android + Meet di speaker | belum diuji | |
Jangan menyatakan integrasi Meet atau Zoom selesai sebelum M1-M3 tercatat.

## Rekap (diisi pemilik)
| Perangkat | Lulus | Gagal | Belum diuji |
|---|---|---|---|
| Chrome desktop (C) | | | |
| Firefox desktop (F) | | | |
| Android Chrome (A) | | | |

Kegagalan dicatat di `docs/BACKLOG.md` (satu butir per temuan, dengan ID skenario, perangkat, dan bukti).
