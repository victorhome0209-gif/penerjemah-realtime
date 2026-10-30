# VocalBridge V1.2: backlog teknis dan bukti gerbang

Dokumen hidup. Satu baris per butir. Status: **PASS** (bukti uji nyata/otomatis), **NOT VERIFIED**, **BLOCKED** (butuh izin/akses pemilik). Jangan menandai PASS tanpa bukti.

Baseline: `origin/vocalbridge-v1.2` @ `4ed671b`, tree `2f84268851c5736491a05045c88ba17b355f0482`. CI run 40981852062: 2/2 sukses.

## Gerbang menuju uji live terkontrol
| Gate | Status | Bukti / alasan |
|---|---|---|
| 1. Tes lokal | PASS | 304/304 (backend 107, statis 31, dependensi 17, QA Lab 20, E2E Chromium 129) pada tree 2f84268 |
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
| S-3 | Kontrak parameter OpenAI (STT, speech, chat) vs referensi resmi | Diperiksa 30 Okt 2026 di developers.openai.com. NOT VERIFIED: `languages[]` multipart, `gpt-6-luna` di Chat Completions secara eksplisit, Pricing |
| S-4 | Uji backend lokal gaya Railway (health, CORS, auth, kode berkedaluwarsa, kill switch, rate limit, persistensi restart, penjaga satu instance, log bersih) | 27/27 PASS (skrip lokal, tanpa kunci OpenAI, `PAID_API_ENABLED=false`) |
| S-5 | Baseline V1.2 di GitHub tanpa trailer sesi | ls-remote: `vocalbridge-v1.2` = 4ed671b |
| S-6 | `npm audit` root/dev dan backend: 0 kerentanan (critical/high/moderate/low/info semuanya 0) | Anotasi check-run CI, run 40982730559 (push) dan 40982749427 (PR #2); dibaca lewat API `check-runs/{id}/annotations` |
| S-7 | CI berjalan untuk `claude/*` dan PR ke `vocalbridge-v*` | Run 40982730559 (push) dan 40982749427 (pull_request): masing-masing 2/2 job sukses |

## Backlog terbuka (urut prioritas)
| ID | Prioritas | Butir | Status |
|---|---|---|---|
| B-3 | P0 | Staging Railway: konfigurasi, Volume `/data`, healthcheck, HTTPS | BLOCKED (persetujuan deployment) |
| B-4 | P0 | Model TTS `gpt-4o-mini-tts` berhenti 2027-01-06; perlu keputusan pengganti (Realtime API) | NOT VERIFIED / butuh keputusan pemilik |
| B-5 | P0 | Uji `reasoning_effort:"none"` + `max_completion_tokens` pada `gpt-6-luna` (laporan komunitas: teks kosong pada model lain) | Hanya bisa saat uji OpenAI nyata |
| B-6 | P1 | Kasus uji perangkat: Chrome desktop, Firefox, Android (autoplay, layar mati, kunci layar, Bluetooth, anti-echo, latensi) | Checklist ada di `docs/CHECKLIST-UJI-OPENAI.md`; belum dijalankan |
| B-7 | P1 | Runbook uji live dan rollback ringkas (satu halaman) | Belum |
| B-8 | P1 | Uji HTTP 400 asli untuk JSON rusak saat berbayar dimatikan (saat ini 503 `paid_disabled` lebih dulu) | Catatan, tes backend ber-mock sudah menutup 400 |
| B-9 | P2 | `VERSION` backend masih `1.1.1` | Belum |
| B-10 | P2 | Kunci Actions ke SHA commit (saran dependency-check) | Belum |
| B-11 | P2 | Peringatan CI: actions v4 berjalan di Node 20 yang usang (dipaksa ke Node 24); `ubuntu-latest` pindah ke Ubuntu 26 | Informasional; pantau, naikkan versi actions bila perlu |

## Tindakan pemilik yang memblokir
1. Project OpenAI khusus + kunci baru + hard spend limit + spend alert (kunci hanya di Railway, bukan di chat).
2. Persetujuan deployment staging Railway (proyek terpisah `vocalbridge-backend`).
3. Konfirmasi sumber GitHub Pages = `main` sebelum merge apa pun ke `main`.
4. Persetujuan tertulis untuk smoke test berbiaya dan `PAID_API_ENABLED=true`.
