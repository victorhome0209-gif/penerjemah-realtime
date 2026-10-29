> V1.2 (API-only): gunakan `docs/CHECKLIST-UJI-OPENAI.md` sebagai daftar periksa utama. Dokumen ini dipertahankan sebagai prosedur rinci.

# Prosedur uji OpenAI nyata dengan biaya terbatas (P7)

**Belum dijalankan.** Prosedur ini hanya boleh dimulai setelah Anda memberi izin uji. Tujuan: membuktikan alur nyata dengan biaya kurang dari sekitar US$0,50.

## A. Prasyarat (langkah Anda)
1. Di dashboard OpenAI, pasang **batas belanja bulanan** kecil (mis. US$5).
2. Backend di-deploy (setelah persetujuan) dengan: `PAID_API_ENABLED=false`, `MONTHLY_BUDGET_USD=2`, `ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `TRUST_PROXY=true`, Volume `/data`, dan `OPENAI_API_KEY` yang Anda isi sendiri di hosting.
3. `GET /api/health` menampilkan `"paid_enabled": false`.

## B. Uji keamanan pada server sungguhan (gratis, sebelum menyalakan biaya)
| # | Perintah | Hasil yang benar |
|---|---|---|
| S1 | `curl -i https://ALAMAT/api/me` | 401 |
| S2 | `curl -i -H "Origin: https://jahat.example" https://ALAMAT/api/health` | 403 |
| S3 | `curl -i -X POST https://ALAMAT/admin/codes` (tanpa token) | 401 |
| S4 | Buat kode tester (lihat BACKEND.md), lalu panggil `/api/translate` dengan kode itu | 503 `paid_disabled` (belum ada biaya) |
| S5 | Buka DevTools di aplikasi: Application → localStorage | tidak ada kunci atau kode akses |
| S6 | DevTools → Network | tidak ada permintaan ke api.openai.com dari browser |

## C. Menyalakan biaya terbatas
1. Buat kode tester: `POST /admin/codes` dengan `credits` 60, `expires_days` 3, `daily_calls` 100 (nilai harus bilangan bulat; lihat BACKEND.md bagian 7).
2. Ubah `PAID_API_ENABLED=true` dan restart. Catat `GET /admin/usage` (harus mendekati 0).
3. Di aplikasi: Pengaturan → isi alamat server dan kode akses → "Simpan dan cek". Badge harus menampilkan kredit.

## D. Uji fungsional nyata (kira-kira 30 ucapan, perkiraan biaya < US$0,05)
Pakai earphone. Catat hasil di `docs/HASIL-UJI.md`.
| # | Skenario | Lulus bila |
|---|---|---|
| F1 | Ucapkan 5 kalimat Indonesia dari Dialog A | Teks asli benar, terjemahan Inggris wajar, suara Inggris terdengar |
| F2 | Putar 5 kalimat Inggris (video/rekaman) di speaker | Teks asli Inggris benar, terjemahan Indonesia wajar |
| F3 | Tekan Saya Bicara saat lawan berbicara | Lawan dijeda, ucapan Anda tidak tercampur |
| F4 | Giliran bergantian 10 kali | Tidak ada benturan; kembali mendengar lawan tiap kali |
| F5 | Angka, tanggal, nama ("Rp 1.250.000", "12 November") | Dicatat akurasinya; konfirmasi tertulis tetap wajib |
| F6 | Cek tagihan | `GET /admin/usage` mendekati angka di dashboard OpenAI (selisih dicatat; ingat itu perkiraan) |
| F7 | `GET /admin/transactions?state=UNKNOWN` dan `GET /admin/audit` setelah sesi | Tidak ada UNKNOWN tak terduga; audit `issues: []` |
| F8 | Restart backend (hosting) saat tidak ada pemakaian, lalu cek saldo | Saldo dan jumlah transaksi sama |

Hal yang diverifikasi untuk pertama kali pada OpenAI sungguhan (belum pernah dipanggil):
- Model `gpt-transcribe` menerima kolom `languages[]` (bila ditolak 400, transaksi gagal bersih dan kredit dikembalikan; server TIDAK mencoba lagi dengan cara lain. Set `OPENAI_STT_LANG_FIELD=language` lalu restart).
- Model `gpt-6-luna` menerima `reasoning_effort: none`, `store:false`, `safety_identifier`, peran `developer` (bila ada yang ditolak 400, transaksi gagal bersih dan dikembalikan; ubah lewat variabel `OPENAI_*` di BACKEND.md).
- Header `X-Client-Request-Id` diterima endpoint audio (bila tidak, set `OPENAI_CLIENT_REQUEST_ID=false`) dan ID transaksi muncul di log OpenAI.
- `gpt-4o-mini-tts` dengan suara `marin` menghasilkan suara Indonesia dan Inggris yang layak.
- Latensi per giliran (target 1 sampai 3 detik) dan biaya per jam.

## E. Uji audio dan perangkat (nyata)
| # | Perangkat | Skenario | Catat |
|---|---|---|---|
| A1 | Android Chrome (HP Anda) | Mikrofon bawaan, ruangan sunyi dan bising, earphone | Terbaca atau tidak; pesan "terlalu pelan/keras" muncul wajar |
| A2 | Laptop Windows 10 Chrome | Mikrofon bawaan | Sama seperti A1 |
| A3 | Firefox desktop | Seluruh alur | Tidak diuji di sesi pengembangan (hanya Chromium tersedia) |
| A4 | Cabut izin mikrofon di tengah sesi | Sesi berhenti dengan pesan jelas |
| M1 | Chrome desktop + Google Meet | Sumber "Audio tab", centang "Bagikan audio tab" | Status "terverifikasi" muncul hanya saat suara peserta terdeteksi |
| M2 | Windows + Zoom aplikasi | Bagikan layar penuh dengan audio sistem | Berhasil atau tidak didukung (catat) |
| M3 | Android Chrome | Meet di HP + speaker | Lawan terdengar lewat mikrofon atau tidak |
Jangan menyatakan integrasi Meet atau Zoom selesai sebelum M1 sampai M3 dicatat dari uji nyata.

## F. Menghentikan
Selesai uji: `POST /admin/kill {"enabled":false}` atau `PAID_API_ENABLED=false`, nonaktifkan kode tester, dan cek dashboard OpenAI.
