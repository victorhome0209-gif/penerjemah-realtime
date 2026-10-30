# VocalBridge V1.2: backlog teknis dan bukti gerbang

Dokumen hidup. Satu baris per butir. Status: **PASS** (bukti uji nyata/otomatis), **NOT VERIFIED**, **BLOCKED** (butuh izin/akses pemilik). Jangan menandai PASS tanpa bukti.

Baseline: `origin/vocalbridge-v1.2` @ `4ed671b`, tree `2f84268851c5736491a05045c88ba17b355f0482`. CI run 40981852062: 2/2 sukses.

## Gerbang menuju uji live terkontrol
| Gate | Status | Bukti / alasan |
|---|---|---|
| 1. Tes lokal | PASS | `node tests/run-all.js` exit 0 (lihat PR untuk hitungan terbaru) |
| 2. CI GitHub | PASS | Run 40981852062 (push `vocalbridge-v1.2`): 2/2 job sukses |
| 3. Keamanan dan konfigurasi | SEBAGIAN | Pemindaian secret bersih; `npm audit` root/dev dan backend = 0 kerentanan semua tingkat (S-6). Sisa: Railway, kunci, hard spend limit (Gate 4-5) |
| 4. Railway staging | BLOCKED | Belum disetujui/dibuat |
| 5. Kredensial OpenAI, hard spend limit, budget internal, kill switch | BLOCKED | Kunci dan hard limit = tindakan pemilik; budget guard dan kill switch teruji hanya lokal |
| 6. Uji live terkontrol | BELUM DIMULAI | Butuh izin tertulis pemilik |

## Selesai (jangan diaudit ulang tanpa perubahan kode)
| ID | Butir | Bukti |
|---|---|---|
| S-1 | Penghapusan Gratis/MyMemory/SpeechRecognition/speechSynthesis | Gerbang `git grep` kosong pada tree 2f84268; tes statis V1.2 |
| S-2 | `provider_quota` (429 kuota) berbeda dari `provider_busy` | `backend/test/quota.test.js`; kredit kembali, satu panggilan |
| S-3 | Kontrak parameter OpenAI (STT, speech, chat) vs referensi resmi | Diperiksa 30 Okt 2026 di developers.openai.com. PASS terhadap dokumentasi: `languages[]` (contoh curl resmi gpt-transcribe; `language` dan `languages` tidak dikirim bersamaan), `gpt-6-luna` mendukung Chat Completions dan `reasoning_effort:none`, `max_completion_tokens`, `store`, `safety_identifier`, peran `developer` (referensi chat), 13 suara + `instructions` (speech). Harga resmi: gpt-transcribe US$0,0045/menit, gpt-6-luna US$0,10/0,50 per 1 juta token. NOT VERIFIED: harga TTS per menit (halaman hanya memberi per token: teks masuk US$0,60, audio keluar US$12,00 per 1 juta), perilaku nyata pada panggilan pertama |
| S-4 | Uji backend lokal gaya Railway (health, CORS, auth, kode berkedaluwarsa, kill switch, rate limit, persistensi restart, penjaga satu instance, log bersih) | 27/27 PASS (skrip lokal, tanpa kunci OpenAI, `PAID_API_ENABLED=false`) |
| S-5 | Baseline V1.2 di GitHub tanpa trailer sesi | ls-remote: `vocalbridge-v1.2` = 4ed671b |
| S-6 | `npm audit` root/dev dan backend: 0 kerentanan (critical/high/moderate/low/info semuanya 0) | Anotasi check-run CI, run 40982730559 (push) dan 40982749427 (PR #2); dibaca lewat API `check-runs/{id}/annotations` |
| S-7 | CI berjalan untuk `claude/*` dan PR ke `vocalbridge-v*` | Run 40982730559 (push) dan 40982749427 (pull_request): masing-masing 2/2 job sukses |
| S-8 | Skrip verifikasi staging `tests/staging-check.js` (`--local` masuk `run-all.js`, 25 pemeriksaan; `--url` untuk Railway, 19 pemeriksaan; `--persist create/check` untuk bukti Volume). Menolak jalan bila `paid_enabled:true`; tidak pernah memanggil OpenAI | Uji lokal: `--local` 25/25; `--url` ke backend lokal 19/19; persist create, restart, check = LULUS; tanpa token/HTTP non-lokal/paid_enabled:true = berhenti (exit 2). Terhadap Railway sungguhan: NOT VERIFIED |
| S-9 | Runbook uji live dan rollback | `docs/RUNBOOK-UJI-LIVE.md` (tahap, gerbang, kondisi berhenti, mematikan layanan, rollback). Prosedur, belum dijalankan |
| S-10 | Matriks uji perangkat | `docs/MATRIKS-UJI-PERANGKAT.md` (34 skenario: tanpa biaya, fungsi inti, mikrofon/speaker/anti-echo, koneksi putus dan pulih, Android, meeting). Belum dijalankan di perangkat nyata |

## Backlog terbuka (urut prioritas)
| ID | Prioritas | Butir | Status |
|---|---|---|---|
| B-3 | P0 | Staging Railway: konfigurasi, Volume `/data`, healthcheck, HTTPS | BLOCKED (persetujuan deployment) |
| B-4 | P0 | Model TTS `gpt-4o-mini-tts` berhenti 2027-01-06; perlu keputusan pengganti (Realtime API) | NOT VERIFIED / butuh keputusan pemilik |
| B-5 | P0 | Uji `reasoning_effort:"none"` + `max_completion_tokens` pada `gpt-6-luna` (laporan komunitas pada model lain: teks kosong; backend menolak balasan kosong sebagai 502) | Hanya bisa saat uji OpenAI nyata |
| B-6 | P1 | Menjalankan matriks uji perangkat (Chrome desktop, Firefox, Android) | Matriks siap (S-10); eksekusi menunggu persetujuan pemilik dan tahap 3-4 runbook |
| B-12 | P0 | Menjalankan `tests/staging-check.js --url` dan `--persist` terhadap Railway setelah deployment disetujui | BLOCKED (deployment) |
| B-8 | P1 | Uji HTTP 400 asli untuk JSON rusak saat berbayar dimatikan (saat ini 503 `paid_disabled` lebih dulu) | Catatan, tes backend ber-mock sudah menutup 400 |
| B-10 | P2 | Kunci Actions ke SHA commit (saran dependency-check) | Belum |
| B-13 | P1 | **H2: jalur yang BELUM dijaga sesi.** `retranslate` (koreksi teks kartu) dan `replay` (putar ulang suara) memanggil `/api/translate` dan `/api/tts` lewat aksi per kartu tanpa guard sesi/`alive`; jalur QA Lab (`handle`, `Listen`) memanggil STT/terjemahan tanpa guard H1. H1/H1-c hanya menutup giliran percakapan (STT, terjemahan, suara) | Terbuka. Jangan mengklaim semua jalur tertutup |
| B-14 | P1 | Tidak ada antrean STT lintas sesi: `Conv.chain` direset saat sesi baru, jadi request lama yang sudah terkirim dapat tumpang tindih dengan sesi baru. **maxInflight STT global = 1 tidak dijamin** (hanya antar giliran dalam satu sesi) | Terbuka; butuh antrean global bila ingin dijamin |
| B-15 | P2 | Request in-flight tidak dijamin bisa dibatalkan dan kredit yang sudah terpakai TIDAK otomatis kembali saat hasil dibuang (H1); pemberitahuan sekali per sesi menyatakan ini | Perilaku yang dipilih (D1/D2); dicatat sebagai batas |
| B-11 | P2 | Peringatan CI: actions v4 berjalan di Node 20 yang usang (dipaksa ke Node 24); `ubuntu-latest` pindah ke Ubuntu 26 | Informasional; pantau, naikkan versi actions bila perlu |

## Tindakan pemilik yang memblokir
1. Project OpenAI khusus + kunci baru + hard spend limit + spend alert (kunci hanya di Railway, bukan di chat).
2. Persetujuan deployment staging Railway (proyek terpisah `vocalbridge-backend`).
3. Konfirmasi sumber GitHub Pages = `main` sebelum merge apa pun ke `main`.
4. Persetujuan tertulis untuk smoke test berbiaya dan `PAID_API_ENABLED=true`.

## Catatan perubahan
- VERSION backend dinaikkan ke `1.2.0` (server.js, package.json, package-lock.json); `staging-check.js` memeriksa kesamaannya dengan `/api/health`.

## Rutin otomatis (scheduled task)
- Dibuat 2026-10-30 01:49 UTC atas permintaan pemilik: "VocalBridge V1.2 — siklus kesiapan uji nyata (tiap 4 jam)", cron `49 */4 * * *` (UTC), sesi cloud baru tiap run, mode persetujuan otomatis.
- Run pertama dijadwalkan 2026-10-30 04:49 UTC. **Status: TERPASANG, BELUM TERBUKTI BERJALAN** sampai ada `last_run` berstatus sukses pada jadwal itu (lihat daftar scheduled task akun). Jangan klaim "berjalan 24/7" sebelum bukti itu ada.
- Batas kuota: penggunaan per run tidak dapat dibatasi dari sini; run yang semua butirnya BLOCKED hanya melakukan pemeriksaan baca-saja singkat. Pemilik memantau penggunaan di pengaturan akun. NOT VERIFIED: besaran konsumsi kuota nyata.
- Hentikan rutin: komentar `HENTIKAN RUTIN` dari pemilik di PR #2 (run berikutnya berhenti), atau jeda/hapus scheduled task di pengaturan akun.
- Larangan rutin: tanpa merge, deploy, panggilan OpenAI berbayar, secret, force-push, perubahan `main`/`vocalbridge-v1.1`/`vocalbridge-v1.2`, proyek lain, atau perubahan jadwal.

