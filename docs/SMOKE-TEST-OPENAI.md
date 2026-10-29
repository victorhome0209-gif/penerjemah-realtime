# Smoke test OpenAI berbiaya minimal (satu putaran dua arah)

**Belum dijalankan. Jangan mulai tanpa persetujuan tertulis pemilik.** `PAID_API_ENABLED` tetap `false` sampai langkah 3 dan hanya dinyalakan selama uji.

## Tujuan
Membuktikan satu putaran nyata: ucapan Indonesia -> teks -> terjemahan Inggris -> suara, lalu ucapan Inggris -> teks -> terjemahan Indonesia. Hanya itu.

## Cakupan dan estimasi biaya
| Langkah | Panggilan OpenAI | Dasar harga |
|---|---|---|
| A. Saya (Indonesia), +-3 dtk, kalimat <= 100 karakter | STT x1, terjemahan x1, suara x1 | |
| B. Lawan (Inggris), +-3 dtk | STT x1, terjemahan x1 (tanpa suara; mode Tatap muka) | |
| Jumlah | 5 panggilan, 7 kredit | |

Estimasi (angka harga dari sumber publik, belum dicocokkan dengan halaman Pricing resmi; cek sebelum mulai):
- STT `gpt-transcribe` sekitar US$0,0045 per menit: 2 x 3 dtk = 0,1 menit, sekitar **US$0,0005**.
- Terjemahan `gpt-6-luna` sekitar US$0,10 per 1 juta token masukan dan US$0,50 per 1 juta keluaran: 2 panggilan, sekitar **US$0,0001**.
- Suara `gpt-4o-mini-tts` sekitar US$0,015 per menit: 3 dtk, sekitar **US$0,0008**.
- **Perkiraan wajar: sekitar US$0,0015.** Perkiraan internal backend (lebih konservatif): sekitar US$0,002. **Batas atas yang kita terima untuk seluruh uji: US$0,01.** Biaya nyata bisa berbeda karena pembulatan penagihan; yang mengikat adalah dashboard OpenAI.

## Batas pengaman (semua dipasang SEBELUM langkah 3)
- Project OpenAI khusus dengan hard spend limit kecil (mis. US$1) dan alert; kunci khusus project itu. Lihat `docs/BACKEND.md` bagian 6.
- Backend: `MONTHLY_BUDGET_USD=0.05`, `DAILY_CALLS_PER_CODE=10`, `RATE_PER_MIN=10`.
- Satu kode uji: **10 kredit** (cukup untuk 7, habis setelah hampir dua putaran), `expires_days` 1, `daily_calls` 10.
- Pakai earphone, ruang sunyi, kalimat pendek, tanpa audio tab.

## Batas penghentian (hentikan SEGERA dengan `POST /admin/kill {"enabled":false}` lalu `PAID_API_ENABLED=false`)
- Kredit berkurang lebih dari 7 untuk satu putaran, atau ada panggilan di luar 5.
- Ada transaksi `UNKNOWN`, galat 5xx berulang, atau `provider_bad_request` (parameter ditolak).
- `/admin/usage` melaporkan lebih dari US$0,01, atau dashboard OpenAI menunjukkan lebih dari US$0,01.
- Latensi satu giliran lebih dari 8 detik, atau terjemahan jelas salah makna pada angka/nama.
- Apa pun yang tidak dimengerti: berhenti dulu, jangan ulangi.

## Langkah
1. Prasyarat: `docs/CHECKLIST-UJI-OPENAI.md` bagian 0 dan 1 semuanya tercentang. `GET /api/health` menjawab `paid_enabled:false`.
2. Catat awal: `GET /admin/usage` (angka awal), saldo dashboard OpenAI, kredit kode uji (10).
3. **Setelah persetujuan:** set `PAID_API_ENABLED=true`, deploy ulang, `GET /api/health` -> `paid_enabled:true`.
4. Aplikasi: Pengaturan, isi alamat server dan kode akses, Simpan dan cek (lencana: 10 kredit). Mulai sesi.
5. **Langkah A:** ketuk Saya Bicara, ucapkan satu kalimat Indonesia pendek (mis. "Halo, nama saya Budi."). Catat: teks asli benar? terjemahan Inggris wajar? suara terdengar utuh (tidak terpotong di akhir)? waktu sampai suara mulai? kredit sisa (harus 6).
6. **Langkah B:** putar satu kalimat Inggris pendek dari HP lain ("Could you send the files by Friday?"). Catat: teks asli, terjemahan Indonesia, kredit sisa (harus 3).
7. Segera hentikan: `POST /admin/kill {"enabled":false}`, `PAID_API_ENABLED=false`, deploy ulang, nonaktifkan kode uji.
8. Catat akhir: `GET /admin/usage`, `GET /admin/transactions?state=UNKNOWN` (kosong), `GET /admin/audit` (`issues: []`), saldo dashboard OpenAI (selisih biaya nyata).

## Hasil (diisi saat dijalankan)
| Butir | Hasil |
|---|---|
| STT id/en benar | |
| Terjemahan wajar | |
| Suara utuh (tidak terpotong) | |
| Latensi A / B (dtk) | |
| Kredit akhir (harus 3) | |
| Biaya nyata (dashboard) | |
| UNKNOWN / audit | |
| Parameter ditolak OpenAI (400)? | |

Catatan: laporan komunitas menyebut `gpt-4o-mini-tts` kadang memotong kalimat terakhir; langkah 5 memeriksanya. Model suara ini berhenti 2027-01-06 dan penggantinya memakai Realtime API, sehingga hasil smoke test ini hanya berlaku sampai tanggal itu.
