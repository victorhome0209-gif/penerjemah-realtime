# Runbook uji live terkontrol dan rollback (V1.2 API-only)

**Status: belum ada tahap yang dijalankan.** Dokumen ini adalah prosedur, bukan bukti. Setiap tahap hanya dimulai setelah gerbang sebelumnya terbukti DAN pemilik menyetujui secara tertulis. Rincian langkah uji ada di `docs/CHECKLIST-UJI-OPENAI.md` (daftar periksa), `docs/SMOKE-TEST-OPENAI.md` (satu putaran minimal), `docs/MATRIKS-UJI-PERANGKAT.md` (perangkat dan skenario), `docs/RAILWAY.md` (pemasangan). Runbook ini hanya mengatur urutan, kriteria lanjut/berhenti, dan pemulihan.

## Aturan tetap
- API key OpenAI dan `ADMIN_TOKEN` hanya di Railway Variables (Seal). Tidak di chat, GitHub, frontend, atau log. Skrip tidak pernah mencetak token.
- Kunci khusus project OpenAI VocalBridge, dengan **hard spend limit** (satu-satunya yang menghentikan biaya) dan spend alert (hanya notifikasi). Budget guard internal `MONTHLY_BUDGET_USD` adalah perkiraan, bukan pengganti.
- `PAID_API_ENABLED=false` sampai tahap 4, dan kembali `false` segera setelah uji.
- Satu orang menjalankan uji (pemilik). Catat waktu, kode uji, dan hasil di tabel bukti di bawah.
- Tidak ada merge ke `main` dan tidak ada perubahan GitHub Pages sebagai bagian dari uji ini.

## Tahap dan gerbang
| Tahap | Isi | Lanjut bila (bukti) | Siapa |
|---|---|---|---|
| 0. Kode | CI hijau pada commit yang akan dipasang; `node tests/run-all.js` lokal lulus | Run CI sukses, 0 gagal | Otomatis |
| 1. Persiapan OpenAI | Project khusus, kunci baru, hard limit kecil (mis. US$1-5), alert 50% dan 80% | Tangkapan layar atau konfirmasi pemilik bahwa "Enforce a hard limit" aktif | Pemilik |
| 2. Railway staging (berbayar MATI) | Pasang sesuai `docs/RAILWAY.md`; `PAID_API_ENABLED=false` | `VB_ADMIN_TOKEN=... node tests/staging-check.js --url https://ALAMAT --origin https://victorhome0209-gif.github.io` = semua LULUS; `--persist create`, redeploy, `--persist check` = LULUS | Pemilik menjalankan, hasil dilaporkan |
| 3. Keamanan tanpa biaya | Bagian 1 `CHECKLIST-UJI-OPENAI.md` di perangkat nyata | Semua tercentang | Pemilik |
| 4. Smoke test berbiaya minimal | `SMOKE-TEST-OPENAI.md` (5 panggilan, batas atas US$0,01) | Persetujuan tertulis + prasyarat tahap 1-3; semua butir hasil terisi; tidak ada kondisi berhenti | Pemilik |
| 5. Uji fungsi terbatas | Bagian 3-8 checklist + `MATRIKS-UJI-PERANGKAT.md` (sekitar 30 ucapan, < US$0,05) | Persetujuan tertulis terpisah; kode uji 60 kredit | Pemilik |
| 6. Putuskan | Isi tabel keputusan di bawah | Pemilik memutuskan GO terbatas atau NO-GO | Pemilik |

Tidak ada tahap yang boleh dilewati. Jika sebuah tahap gagal, kembali ke rollback, perbaiki di branch, ulangi dari tahap yang terdampak.

## Kondisi berhenti otomatis (hentikan SEGERA)
Hentikan jika salah satu terjadi, lalu jalankan "Mematikan layanan":
1. Kredit atau panggilan melebihi yang direncanakan pada tahap itu.
2. Ada transaksi `UNKNOWN` (`GET /admin/transactions?state=UNKNOWN` tidak kosong) atau `GET /admin/audit` memuat isu.
3. `provider_bad_request` (parameter ditolak OpenAI) atau galat 5xx berulang.
4. `provider_quota` muncul tak terduga (hard limit atau saldo tercapai).
5. `/admin/usage` atau dashboard OpenAI melaporkan biaya di atas batas tahap (smoke test: US$0,01).
6. Latensi satu giliran di atas 8 detik, atau terjemahan salah makna pada angka atau nama.
7. Kunci, kode akses, atau token terlihat di log, layar, atau Network.
8. Apa pun yang tidak dipahami: berhenti, jangan ulangi.

## Mematikan layanan (urut, dari yang tercepat)
1. `POST /admin/kill {"enabled":false}` (header `X-Admin-Token`). Berlaku segera, tersimpan setelah restart. Sesi berikutnya diblokir dengan pesan jelas; sesi berjalan gagal bersih.
2. Railway Variables: `PAID_API_ENABLED=false`, lalu deploy ulang.
3. Nonaktifkan kode uji: `POST /admin/disable {"id":"<8 karakter>","disabled":true,"request_id":"<unik>"}`.
4. Cabut kunci: OpenAI dashboard, hapus atau rotasi kunci project (jika ada dugaan kebocoran, lakukan ini lebih dulu).
5. Cek dashboard OpenAI: pengeluaran, dan pastikan tidak ada pemakaian baru.

## Rollback
| Kondisi | Tindakan | Bukti pulih |
|---|---|---|
| Backend baru bermasalah | Railway: deploy ulang commit sebelumnya. **Cadangkan Volume `/data` sebelum memperbarui versi** (format data v3 tidak dijamin terbaca versi lama) | `GET /api/health` ok, `store_ok:true`; `staging-check.js --url` LULUS |
| Data kredit rusak atau tak cocok | Hentikan layanan (kill), pulihkan cadangan Volume, jalankan `GET /admin/audit` (`issues: []`) | Audit bersih; saldo kode sesuai catatan |
| Transaksi `UNKNOWN` | Jangan hapus. Periksa dengan `X-Client-Request-Id`/`providerRequestId` di dashboard OpenAI, lalu `POST /admin/transactions/resolve` (`confirm`, `refund`, atau `refund_keep_cost`) dengan catatan dan `request_id` | `UNKNOWN` kosong |
| Frontend bermasalah | GitHub Pages melayani `main`; V1.2 tidak ada di `main`, jadi tidak ada yang perlu di-rollback selama tidak ada merge. Jika kelak sudah merge: `git revert` merge commit lewat PR | Halaman publik sesuai versi yang diharapkan |
| Kunci OpenAI diduga bocor | Cabut di OpenAI, buat kunci baru, isi ulang di Railway (Seal), nonaktifkan kode uji | Kunci lama ditolak 401; `provider_auth` tidak muncul pada kunci baru |
| Biaya OpenAI melonjak | Kill + `PAID_API_ENABLED=false` + hard limit diturunkan atau project dijeda | Dashboard stabil |

## Setelah uji
1. `PAID_API_ENABLED=false` kembali, kill aktif, kode uji dinonaktifkan.
2. Catat `/admin/usage`, `/admin/transactions?state=UNKNOWN`, `/admin/audit`, dan selisih biaya dashboard.
3. Isi tabel bukti dan keputusan di bawah, lalu serahkan ke pengembangan lewat `docs/BACKLOG.md`.

## Tabel bukti (diisi saat dijalankan)
| Tahap | Tanggal/jam | Hasil (LULUS/GAGAL) | Bukti (ID run, tangkapan, nilai) | Catatan |
|---|---|---|---|---|
| 2 staging-check | | | | |
| 2 persist | | | | |
| 3 keamanan | | | | |
| 4 smoke test | | | | |
| 5 uji fungsi | | | | |

## Keputusan pemilik
| Pertanyaan | Jawaban |
|---|---|
| Uji berhenti normal atau karena kondisi berhenti? | |
| Biaya nyata vs perkiraan internal | |
| Latensi median dan terburuk | |
| Model TTS `gpt-4o-mini-tts` berhenti 2027-01-06: rencana pengganti | |
| Lanjut ke uji lebih luas? | |
