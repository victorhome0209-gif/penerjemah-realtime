# VocalBridge

Asisten penerjemah meeting pribadi Indonesia ⇄ Inggris untuk browser HP dan desktop.
Lawan bicara tidak perlu memasang apa pun dan tidak perlu menekan tombol.

**Status: V1 siap diuji, BELUM siap produksi.** Uji end-to-end dengan OpenAI sungguhan, HP sungguhan, dan Meet/Zoom sungguhan belum dilakukan. Lihat [docs/HASIL-UJI.md](docs/HASIL-UJI.md).

## Cara kerja
- Satu tombol utama: **Saya Bicara**. Sesudah sesi dimulai, lawan bicara (Inggris) didengarkan otomatis.
- Saat Saya Bicara ditekan: pengenalan suara lawan dijeda, mikrofon Indonesia aktif, ucapan diterjemahkan ke Inggris dan dibacakan, lalu aplikasi kembali mendengarkan lawan.
- Empat teks selalu tampil: Saya (asli Indonesia, terjemahan Inggris) dan Lawan (asli Inggris, terjemahan Indonesia), dengan salin, putar ulang, koreksi, dan riwayat.
- Dua mode: **Gratis** (browser + MyMemory, tanpa kunci) dan **Uji** (kode akses; ucapan diproses OpenAI lewat backend).

## Struktur
| Bagian | Isi |
|---|---|
| `index.html` | Frontend statis untuk GitHub Pages. Tidak memegang kunci API apa pun. QA Lab ada di menu Pengaturan. |
| `backend/` | Backend Node.js tanpa dependensi: autentikasi kode akses, kredit, batas biaya, provider OpenAI. Kunci hanya dibaca dari environment variables. |
| `tests/` | Pemindai keamanan, regresi QA Lab, dan tes browser (simulasi). |
| `docs/` | Panduan backend, prosedur uji nyata, hasil uji, laporan. |

## Aturan kunci API
- Kunci OpenAI, Anthropic, dan ElevenLabs **hanya** ada di environment variables backend.
- Jangan menaruhnya di `index.html`, JavaScript, localStorage, repositori, atau GitHub Pages.
- Frontend memakai **kode akses uji** (bukan kunci penyedia). Kode disimpan di sessionStorage dan hilang saat tab ditutup.
- Pada V1 hanya OpenAI yang aktif. Anthropic dan ElevenLabs dinonaktifkan.

## Menjalankan tes (tanpa biaya, tanpa kunci)
```
npm test                 # pemindai keamanan + tes backend + regresi
npm install && npx playwright install chromium
npm run test:e2e         # tes browser (simulasi)
```

## Mengaktifkan backend
Ikuti [docs/BACKEND.md](docs/BACKEND.md). Alamat backend diisi di `index.html` pada `VB_CONFIG.API_BASE` atau langsung di Pengaturan aplikasi. Alamat itu publik, bukan rahasia.

## Batas yang jujur
- Mikrofon lokal: tersedia. Audio tab browser: hanya Chrome desktop dan belum diuji dengan Meet/Zoom nyata. Mengirim suara terjemahan ke meeting: belum ada.
- Status "audio tab terverifikasi" hanya muncul setelah suara benar-benar terdeteksi.
- Terjemahan mesin bisa salah. Periksa angka, nama, dan tanggal penting secara tertulis.
