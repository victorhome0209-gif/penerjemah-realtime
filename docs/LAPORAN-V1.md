> Catatan V1.2: laporan ini bersejarah. Mode Gratis yang disebut di bawah sudah DIHAPUS di V1.2 (lihat `docs/V1.2.md`).

# Laporan VocalBridge V1 (29 Oktober 2026)

> **Diperbarui:** setelah pemeriksaan ulang, masalah P0/P1 diperbaiki. Lihat `REMEDIASI.md` (per masalah) dan `BACKEND.md` (panduan terbaru). Angka tes terbaru: backend 88, statis 23, regresi 20, E2E 99. Bagian di bawah adalah laporan V1 asli; butir yang berubah ditandai.

**Status: V1 siap diuji, bukan siap produksi.** Semua pekerjaan ada di branch lokal `v1-secure-backend`. Tidak ada deploy, merge, penggantian kunci, panggilan API berbayar, billing, atau repositori baru. Akses tulis ke GitHub ditolak oleh sistem izin, jadi hasil diserahkan sebagai berkas.

## 1. Pekerjaan yang benar-benar dilakukan
- **P0 audit.** Backend lama ditemukan di chat sebelumnya (`vocalbridge-backend.zip`, Node tanpa dependensi, 28 tes). Berkas zip tidak tersedia, jadi kodenya saya pulihkan utuh dari transkrip, saya jalankan (28/28 lulus), lalu saya jadikan dasar. Repositori GitHub tidak memuat backend. Dokumentasi OpenAI diperiksa: `gpt-4o-mini-transcribe` dan `gpt-4o-mini-tts` (dipakai kode lama) sudah deprecated.
- **P1 backend.** Dipertahankan: kode akses ber-hash, kredit, endpoint admin, CORS, batas laju. Ditambah: tahan/konfirmasi/kembalikan kredit, `Idempotency-Key` wajib, batas harian dan anggaran bulanan, tombol darurat, validasi WAV, timeout, log aman, kontrak `STTProvider`/`TranslationProvider`/`TTSProvider`, migrasi dari berkas data lama.
- **P2–P5 frontend.** `index.html` lama dipertahankan sebagai dasar. Semua panggilan penyedia dipindah ke backend. Tampilan baru sesuai desain yang disetujui. Alur satu tombol, empat teks, putar ulang, salin, koreksi, riwayat opt-in, persetujuan privasi, VAD adaptif, level meter nyata, deteksi suara pelan/keras/bising, status perangkat dan izin, sumber audio tab (desktop) dengan verifikasi sinyal.
- **P6** tes otomatis dan simulasi (bagian 4). **P7** prosedur uji nyata (`docs/UJI-NYATA.md`), belum dijalankan.

## 2. File dibuat atau diubah
Diubah: `index.html` (ditulis ulang bagian percakapan, QA Lab dipertahankan), `README.md`, `.gitignore`.
Baru: `backend/server.js`, `backend/lib/{config,store,util}.js`, `backend/lib/providers/{index,openai,anthropic,elevenlabs}.js`, `backend/test/{helpers,security.test,billing.test}.js`, `backend/{package.json,.env.example,.gitignore,.dockerignore,Dockerfile}`, `tests/{static-check,regress}.js`, `tests/e2e/{servers,run}.js`, `package.json`, `.github/workflows/ci.yml`, `docs/{BACKEND,UJI-NYATA,HASIL-UJI,LAPORAN-V1}.md`.

## 3. Perubahan arsitektur
- Sebelum: browser memegang kunci OpenAI, Claude, dan ElevenLabs di localStorage dan memanggil penyedia langsung.
- Sesudah: browser hanya memegang **kode akses uji** di sessionStorage dan memanggil backend HTTPS. Kunci hanya di environment variables backend.
- Backend berada di folder `backend/` pada repositori yang sama (tidak ada repositori baru). Ia dipisahkan dari frontend karena di-host sendiri. Catatan: kode backend ikut terlihat publik di repositori (tanpa rahasia).
- Provider: OpenAI aktif; Anthropic dan ElevenLabs dinonaktifkan dan tidak pernah dipilih otomatis.
- Panggilan berbayar **mati secara bawaan** (`PAID_API_ENABLED=false`).
- Mode Gratis tetap ada sebagai cadangan tanpa kunci.

## 4. Hasil pengujian dan bukti (rinci di `docs/HASIL-UJI.md`)
- **Otomatis:** backend 43/43, pemindai keamanan 17/17, regresi QA Lab 20/20 (identik dengan commit 243b77b).
- **Simulasi (Chromium, mikrofon dan OpenAI palsu):** 82/82.
- **Uji mutasi:** perusakan sengaja pada refund, idempotensi, log, dan kunci di frontend tertangkap oleh tes.
- **Nyata:** belum ada. Tidak ada panggilan OpenAI, HP, Firefox, Meet, atau Zoom.

## 5. Risiko yang belum selesai
1. Belum ada uji nyata end-to-end. Dua hal pada OpenAI belum pernah dipanggil: bentuk kolom `languages[]` untuk `gpt-transcribe` dan parameter `reasoning_effort` pada `gpt-6-luna`. Keduanya punya cadangan otomatis, tetapi baru terbukti saat uji nyata.
2. **`gpt-4o-mini-tts` berhenti 6 Jan 2027.** Penggantinya memakai Realtime API, jadi perlu `TTSProvider` baru sebelum tanggal itu.
3. Audio tab dan routing ke meeting: audio tab belum diuji dengan Meet/Zoom nyata; mengirim suara terjemahan ke meeting belum dibangun (butuh kabel audio virtual).
4. Ucapan lawan selama Saya Bicara dibuang (sesuai instruksi "jeda"). Alternatif merekam lalu memproses menunggu keputusan Anda.
5. Penyimpanan kredit berkas JSON: cukup untuk beberapa tester, satu instance saja. Cache idempotensi di memori; setelah restart, kunci yang sama dijawab 409 (tidak ada potong ganda).
6. ~~Suara Saya dihapus dari UI~~ **Diperbaiki:** modul dipulihkan sebagai fitur Pro nonaktif (lihat REMEDIASI.md, P2).
7. Sisa kode lama tak terpakai di `index.html` (cabang `ui==='talk'` di `handle()`, `subShow`) merujuk elemen yang sudah tidak ada. Tidak terjangkau, belum dibersihkan.
8. Pengenal suara Chrome (mode Gratis) mengirim audio ke Google; sudah diungkap di persetujuan.
9. Kunci yang pernah ditempel di browser lama dihapus aplikasi saat dibuka, tetapi **tetap putar kunci itu** di dashboard penyedia. Saya tidak melakukannya.
10. Hanya Chromium yang tersedia di lingkungan pengembangan: Firefox dan Safari belum diuji.
11. `ScriptProcessorNode` dipakai (sudah deprecated tetapi berfungsi); perlu migrasi ke AudioWorklet di masa depan.
12. Pembayaran otomatis belum ada; kredit diisi manual lewat admin.

## 6. Status backend
Kode selesai dan lulus tes, **belum di-deploy**, belum dipanggil dengan kunci asli. Panggilan berbayar mati sampai Anda mengaktifkannya.

## 7. Status frontend
Selesai secara lokal dan lulus tes simulasi, **belum di-push atau di-deploy**. `VB_CONFIG.API_BASE` masih kosong (mode Gratis) sampai backend ada.

## 8. Cara memasukkan API key secara aman
Hanya di Variables hosting backend (Railway: tab Variables) sebagai `OPENAI_API_KEY`. Ikuti `docs/BACKEND.md`. Jangan di GitHub, `index.html`, localStorage, atau GitHub Actions variables. Pelanggan tidak pernah diminta kunci; mereka memakai kode akses `VB-...` dari administrator.

## 9. Panduan uji HP dan browser
`docs/UJI-NYATA.md` bagian E (Android Chrome, Chrome laptop, Firefox, Meet, Zoom) dan bagian B (uji keamanan pada server sungguhan).

## 10. Checklist sebelum dinyatakan siap
- [ ] Anda menyetujui hasil ini dan cara penyerahannya (zip atau akses tulis).
- [ ] Backend di-deploy dengan `PAID_API_ENABLED=false`; uji keamanan S1–S6 lulus.
- [ ] Batas belanja dipasang di dashboard OpenAI.
- [ ] Uji fungsional nyata F1–F6 lulus dengan biaya terbatas.
- [ ] Uji perangkat A1–A4 dan M1–M3 dicatat.
- [ ] Kunci lama diputar.
- [ ] `TTSProvider` pengganti disiapkan sebelum 6 Jan 2027.
- [ ] Keputusan: ucapan lawan saat jeda; penghapusan klon suara; sisa kode lama dibersihkan.
- [ ] Baru kemudian: domain khusus, pembayaran, dan klaim siap produksi.
