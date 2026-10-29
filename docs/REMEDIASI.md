# Laporan remediasi VocalBridge V1 (29 Oktober 2026)

Dasar: V1 commit `b4810a4`. Semua pekerjaan di branch lokal `v1-secure-backend`; tidak ada deploy, merge, perubahan kunci, atau panggilan API berbayar. OpenAI selalu palsu (mock ketat) dalam semua tes.
Setiap masalah di bawah **direproduksi dulu pada kode V1** dengan `tests/repro-masalah.js` (log: `bukti/reproduksi-sebelum-sesudah.txt`), diperbaiki, lalu diverifikasi ulang.

## Ringkasan
| ID | Masalah | Tingkat | Status |
|---|---|---|---|
| P0-1 | `store.sweep(0)` saat restart mengembalikan semua transaksi, termasuk yang sudah ditagih penyedia | Tinggi | Diperbaiki |
| P0-2 | Status penyedia yang belum pasti otomatis dikembalikan dan bisa ditagih lagi | Tinggi | Diperbaiki |
| P0-3 | Tidak ada status transaksi dan rekonsiliasi | Tinggi | Dirancang dan dibangun |
| P0-4 | `/admin/topup`: kredit negatif, tak hingga, teks, perubahan tidak sengaja | Tinggi | Diperbaiki |
| P0-5 | Batas biaya internal (perkiraan) tidak dibedakan dari batas dashboard | Sedang | Dibedakan di kode dan dokumen |
| P1-1 | Model dan parameter OpenAI belum diverifikasi terhadap dokumentasi terkini | Sedang | Diverifikasi, ada temuan |
| P1-3 | Fallback berulang: 1 permintaan menjadi 2–3 panggilan | Tinggi | Dihapus |
| P2 | Modul Suara Saya (klon suara) dihapus dari UI | Sedang | Dipulihkan sebagai fitur Pro nonaktif |
| T-1 | Admin tanpa pembatas percobaan token; konfigurasi biaya nol/negatif diterima | Sedang | Diperbaiki (temuan tambahan) |

## P0-1 Restart mengembalikan transaksi yang sedang berjalan
- **Lokasi:** `backend/lib/store.js` `sweep()`, `backend/server.js` saat start (`store.sweep(0)`), V1.
- **Gejala (reproduksi R1):** server dimatikan paksa saat permintaan sedang di OpenAI; OpenAI menyelesaikan dan menagih. Setelah restart kredit pengguna kembali penuh (10), kirim ulang kunci yang sama dipanggil lagi: **OpenAI menagih 2×, pengguna dipotong 1×**.
- **Akar masalah:** hold tidak mencatat apakah permintaan sudah keluar; `sweep(0)` menganggap semua hold yatim gagal; `release()` juga melepas kunci idempotensi.
- **Perubahan:** tulis-dulu `sent_at` ke disk tepat sebelum panggilan (`markSent`); `recover()` saat start: belum terkirim → FAILED dan dikembalikan, sudah terkirim → **UNKNOWN, kredit tetap ditahan**, kunci terkunci. Penyapu berkala hanya untuk transaksi yatim yang bukan milik proses ini.
- **Risiko tersisa:** UNKNOWN butuh tindakan admin (kredit pengguna tertahan sementara); satu instance saja; bila proses mati setelah `markSent` tetapi sebelum paket keluar, transaksi tetap UNKNOWN (konservatif, bukan merugikan pemilik).
- **Bukti sesudah:** repro R1 → penyedia 1×, pengguna dipotong 1 (ditahan), kirim ulang = 409. `restart.test.js` (6 tes, SIGKILL nyata), `transactions.test.js` 1–4, 8; E2E browser "Restart backend sungguhan"; mutasi M1, M5, M6 tertangkap.

## P0-2 Status belum pasti dikembalikan otomatis
- **Lokasi:** `server.js` `paid()` dan galat provider (V1: semua galat → `release`).
- **Gejala:** timeout, koneksi putus, 5xx, respons rusak → kredit dikembalikan dan kunci dilepas; OpenAI mungkin sudah menagih, retry ditagihkan lagi.
- **Akar masalah:** semua galat diperlakukan sama.
- **Perubahan:** `providers/common.js` mengklasifikasi hasil: `rejected` (4xx; pasti tidak diproses), `not_sent` (DNS/koneksi ditolak/TLS), `unknown` (timeout, koneksi putus saat respons, 5xx, JSON rusak, balasan kosong, galat tak dikenal). Hanya `rejected` dan `not_sent` yang dikembalikan. 5xx bawaan UNKNOWN (`REFUND_ON_PROVIDER_5XX=true` untuk mengubah). Respons ke klien: `provider_unknown` + ID transaksi.
- **Risiko tersisa:** gangguan OpenAI singkat (5xx) menahan kredit sampai admin merekonsiliasi; bisa dilonggarkan dengan opsi di atas.
- **Bukti:** `transactions.test.js` 9–12 (timeout, reset, JSON rusak, balasan kosong, 5xx, koneksi ditolak); mutasi M4.

## P0-3 Rancangan status transaksi dan rekonsiliasi aman
Status dan transisi ada di `docs/BACKEND.md` bagian 4. Rekonsiliasi (bagian 5): daftar UNKNOWN, cocokkan dengan log OpenAI memakai `X-Client-Request-Id` = ID transaksi, lalu `confirm` / `refund` / `refund_keep_cost` oleh admin. Aman karena: hanya UNKNOWN; wajib `note` dan `request_id` (idempoten); tercatat di log admin; `refund` melepas anggaran tetapi `refund_keep_cost` dan `confirm` tidak; `GET /admin/audit` memeriksa invarian (kredit + ditahan + terpakai = awal, `held` = jumlah transaksi terbuka). Tidak ada penyelesaian otomatis berdasarkan waktu.
- **Batas yang jujur:** dukungan `X-Client-Request-Id` untuk endpoint audio belum terkonfirmasi di dokumentasi; dukungan OpenAI hanya bisa memeriksa bila header diterima.
- **Bukti:** `transactions.test.js` 13–14 dan uji kekacauan acak (konservasi kredit dan audit bersih); `restart.test.js` 1–2.

## P0-4 Endpoint admin
- **Lokasi:** `store.topup()` dan `POST /admin/topup`, V1.
- **Gejala (reproduksi R2):** `credits:-1000` → saldo −990; `1e999` → `Infinity` → `"credits":null` di berkas (rusak); `"abc"` → null; `disabled:"false"` → kode **nonaktif**; perintah yang diulang menambah dua kali; id awalan ≥6 cocok kode pertama yang ditemukan.
- **Akar masalah:** `Math.floor(+x) || 0`, `!!x`, tanpa skema, tanpa idempotensi, pencocokan awalan longgar.
- **Perubahan:** validasi ketat (hanya bilangan bulat bertipe number dalam rentang); `topup` hanya menambah dan **wajib `request_id`** (idempoten, parameter berbeda = 409); `/admin/adjust` untuk pengurangan (alasan wajib, tidak boleh < 0, tidak menyentuh kredit ditahan); `/admin/disable` boolean sungguhan; id harus 8+ heksadesimal dan cocok persis satu; `MAX_BALANCE`; log admin; migrasi saldo rusak → 0 dan dicatat; `kill` wajib boolean.
- **Risiko tersisa:** perubahan API admin (memecahkan kompatibilitas; didokumentasikan); tidak ada UI admin (curl saja).
- **Bukti sesudah:** repro R2 semua 400 dan saldo tetap; `admin.test.js` (15); mutasi M2 tertangkap.

## P0-5 Batas biaya internal vs dashboard
- **Temuan:** `MONTHLY_BUDGET_USD` adalah perkiraan (durasi audio, karakter TTS, harga yang diisi); bukan tagihan dan bukan batas OpenAI.
- **Perubahan:** pembedaan eksplisit di `.env.example`, `docs/BACKEND.md` bagian 6, `/admin/usage` (`estimate.basis`, `includesUnknownUsd`, `reportedByProvider`, catatan), peringatan saat start (`PAID_API_ENABLED=true` mengingatkan batas dashboard). Transaksi UNKNOWN tetap dihitung. Backend tidak dapat membaca batas dashboard; itu langkah manual Anda.
- **Bukti:** `admin.test.js` (laporan estimasi/UNKNOWN/dilaporkan; anggaran berhenti walau semua UNKNOWN); `billing.test.js` (anggaran).

## P0-6 Pengujian yang ditambahkan
Restart (SIGKILL nyata, backend proses terpisah), timeout, retry (kunci sama setelah UNKNOWN/CONFIRMED/FAILED), pemulihan, gagal simpan, migrasi v1/v2, kekacauan acak dengan invarian. Lihat bagian Bukti.

## P1 Provider OpenAI
Sumber verifikasi 29 Okt 2026: halaman Models, Deprecations, panduan Speech-to-text dan Text-to-speech, referensi API (transcriptions, speech, chat completions, Debugging requests), dan sumber SDK `openai-node` (halaman GitHub). Registri npm dan GitHub mentah tidak dapat dijangkau dari lingkungan ini, jadi SDK tidak diinstal.
| Fungsi | Temuan dokumentasi | Perubahan |
|---|---|---|
| STT | `gpt-transcribe` direkomendasikan, memakai `languages` (array); array multipart dikirim `languages[]` (konvensi SDK). Model lama deprecated (2027-02-26) | `languages[]` untuk `gpt-transcribe`, `language` untuk model lama, tidak pernah keduanya; `response_format` dihilangkan |
| Terjemahan | `gpt-6-luna` ada di enum model chat; `reasoning_effort` `none..max`; `max_tokens` deprecated; developer message menggantikan system untuk model baru | peran `developer`, `max_completion_tokens`, `reasoning_effort: none`, `store:false`, `safety_identifier`; tanpa `temperature` |
| Suara | `gpt-4o-mini-tts` deprecated, berhenti 2027-01-06; `instructions` tidak berlaku untuk `tts-1`; input maks 4096 | `instructions` hanya model `gpt-4o-mini-tts*`; peringatan sunset saat start |
| Jejak | `X-Client-Request-Id` (ASCII, ≤512) dapat dibagikan ke dukungan | dikirim = ID transaksi |
- **P1-3 (reproduksi R3):** 1 permintaan STT yang ditolak 400 = 2 panggilan; 1 permintaan terjemahan = 3 panggilan. **Perubahan:** tepat satu permintaan HTTP per transaksi; konfigurasi eksplisit (`OPENAI_STT_LANG_FIELD`, `OPENAI_INSTRUCTION_ROLE`, `OPENAI_TRANSLATE_REASONING`). Bukti sesudah: R3 = 1 dan 1; `provider-contract.test.js` "tepat satu permintaan" untuk 6 jenis galat; mutasi M3.
- **P1-4:** mock ketat menolak kolom, model, suara, peran, header di luar kontrak; semua tes memeriksa `violations` kosong.
- **P1-5:** tidak ada panggilan OpenAI nyata.
- **Risiko tersisa:** tiga hal baru terbukti saat uji nyata: `reasoning_effort: none` pada `gpt-6-luna` (dokumentasi tidak merinci dukungan per model), `X-Client-Request-Id` pada endpoint audio, dan `safety_identifier` yang hanya didokumentasikan untuk chat. Bila ditolak (400), transaksi gagal bersih dan dikembalikan; ubah lewat konfigurasi tanpa mengubah kode.

## P2 Fitur
Dipertahankan dan diuji ulang: satu tombol Saya Bicara, mendengarkan lawan otomatis, empat teks, QA Lab (regresi 20/20 identik dengan versi lama). **Suara Saya dipulihkan** (tampilan, rekam sampel lokal, pratinjau, persetujuan) sebagai **fitur Pro nonaktif**: klon dan suara klon dinonaktifkan di UI, hanya aktif bila `/api/me` menyatakan `features.voice_clone.enabled`; saat ini selalu `false` dan `/api/clone` membalas 503. Tidak ada kunci ElevenLabs di browser dan tidak ada panggilan jaringan dari modul ini (diuji).

## T-1 Temuan tambahan selama remediasi
- Token admin tidak dibatasi percobaannya (hanya `/api`): kini sama seperti `/api`.
- `COST_STT=-5` atau `0` diterima (memberi layanan gratis) dan nilai seperti `abc` diam-diam memakai bawaan: kini server menolak start.
- Berkas data dapat berisi `credits:null` hasil V1: dinormalisasi ke 0 dan dicatat (`migrated_codes` di log start).

## Risiko tersisa (setelah remediasi)
1. **Belum ada uji nyata** dengan OpenAI, HP, Firefox/Safari, Meet/Zoom. Hanya Chromium yang tersedia di lingkungan pengembangan.
2. Rekonsiliasi UNKNOWN **manual**; sinyal ke dukungan OpenAI lewat ID transaksi belum terkonfirmasi untuk audio.
3. Penyimpanan berkas JSON dan satu instance; setiap perubahan menulis ulang berkas. Tanpa Volume permanen data hilang.
4. Hasil CONFIRMED yang hilang tidak dapat dipulihkan (server tidak menyimpan teks); pengguna mengulang dan kredit dihitung lagi.
5. 5xx bawaan UNKNOWN: gangguan OpenAI menahan kredit pengguna sampai admin bertindak.
6. Batas internal hanya perkiraan; batas dashboard OpenAI wajib Anda pasang sendiri.
7. `gpt-4o-mini-tts` berhenti 6 Jan 2027: perlu `TTSProvider` baru (Realtime API).
8. Perubahan API admin memecahkan kompatibilitas dengan perintah curl lama.
9. Sisa kode lama tak terpakai di `index.html` merujuk elemen yang sudah tidak ada (tidak terjangkau).
10. Audio tab dan pengiriman suara ke meeting belum diuji; klon suara nonaktif.

## Bukti
| Rangkaian | Hasil | Log mentah |
|---|---|---|
| Backend (OpenAI palsu ketat, restart SIGKILL) | 88/88 | `bukti/tes-backend.txt` |
| Pemindai statis dan penjaga regresi | 23/23 | `bukti/tes-statis.txt` |
| Regresi QA Lab vs `243b77b` | 20/20 | `bukti/tes-regresi.txt` |
| E2E Chromium (simulasi) | 99/99 | `bukti/tes-e2e-chromium.txt` |
| Reproduksi sebelum/sesudah | R1–R3 | `bukti/reproduksi-sebelum-sesudah.txt` |
| Mutasi (6 bug dihidupkan lagi) | semua tertangkap | `bukti/mutasi.txt` |
