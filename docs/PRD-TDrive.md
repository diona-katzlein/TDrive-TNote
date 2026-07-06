# PRD — TDrive (Telegram as Cloud Drive)

| Field | Nilai |
|---|---|
| **Nama Produk** | TDrive |
| **Tagline** | Jadikan akun Telegram Anda sebagai cloud storage pribadi |
| **Versi Dokumen** | 1.0 |
| **Tanggal** | 2026-07-05 |
| **Status** | Draft |
| **Stack** | Node.js, Express, EJS, SQLite, GramJS (MTProto) |

---

## 1. Ringkasan Eksekutif

TDrive adalah aplikasi web yang memanfaatkan **akun Telegram** (bukan bot) sebagai backend penyimpanan file (cloud drive). Pengguna login dengan nomor telepon Telegram mereka, dan TDrive menggunakan penyimpanan Telegram (praktis tanpa batas kuota) untuk menyimpan file. Aplikasi menyediakan antarmuka web layaknya Google Drive: unggah, unduh, buat folder, cari, dan kelola file.

Tiga pilar utama:
1. **Telegram sebagai storage** — byte file disimpan di Telegram; metadata (nama, folder, mapping) disimpan lokal di SQLite.
2. **Multi-account** — satu instalasi TDrive dapat mengelola beberapa akun Telegram sekaligus, masing-masing sebagai "drive" terpisah atau storage gabungan.
3. **Session persistent** — sesi MTProto (StringSession) disimpan terenkripsi di SQLite sehingga pengguna tidak perlu login ulang setiap kali.

## 2. Latar Belakang & Masalah

- Layanan cloud komersial (Google Drive, Dropbox) memiliki kuota gratis terbatas (15 GB / 2 GB).
- Telegram memberi penyimpanan sangat besar secara gratis, tapi UX-nya bukan untuk manajemen file (tidak ada struktur folder, pencarian file terbatas, tidak ada tampilan "drive").
- Pengguna power-user / self-hoster ingin memanfaatkan kapasitas Telegram dengan antarmuka yang rapi dan bisa multi-akun.

**Peluang:** membungkus penyimpanan Telegram dengan lapisan manajemen file (folder, metadata, pencarian, multi-account) di atas web app ringan yang bisa di-self-host.

## 3. Tujuan & Metrik Keberhasilan

### Tujuan Produk
- Menyediakan pengalaman "cloud drive" di atas storage Telegram.
- Mendukung banyak akun Telegram dalam satu instance.
- Sesi tetap hidup (persistent) tanpa login berulang.

### Metrik Keberhasilan (contoh)
| Metrik | Target |
|---|---|
| Waktu upload file 100 MB | < 30 detik (tergantung jaringan) |
| Keberhasilan restore sesi tanpa login ulang | > 99% |
| File 2 GB+ tersimpan lewat chunking | Didukung |
| Waktu render daftar file 1000 item | < 500 ms |

## 4. Persona Pengguna

1. **Self-hoster / Power user** — ingin storage murah/gratis, nyaman dengan konfigurasi teknis.
2. **Content hoarder** — menyimpan arsip media besar, butuh kapasitas besar.
3. **Tim kecil** — berbagi satu instance dengan beberapa akun Telegram sebagai storage terpisah.

## 5. Ruang Lingkup (Scope)

### In Scope (MVP)
- Login akun Telegram via nomor HP + OTP (dan 2FA password bila ada).
- Persistensi sesi (StringSession) terenkripsi di SQLite.
- Multi-account: tambah, ganti, hapus akun.
- Upload file (dengan chunking untuk file besar).
- Download file (rekonstruksi dari chunk).
- Struktur folder virtual (metadata di SQLite).
- Rename, pindah, hapus file/folder.
- Pencarian berdasarkan nama file.
- Dashboard: daftar file, ukuran, tanggal.

### Out of Scope (MVP)
- Sharing publik / link eksternal.
- Preview/streaming media in-browser (fase berikutnya).
- Kolaborasi real-time / multi-user permission granular.
- Aplikasi mobile native.
- Enkripsi end-to-end sisi klien (fase berikutnya).

## 6. Kebutuhan Fungsional

### 6.1 Autentikasi & Sesi
- **FR-1** Pengguna dapat login dengan `api_id`, `api_hash`, nomor telepon.
- **FR-2** Sistem mengirim OTP via Telegram dan memverifikasi kode.
- **FR-3** Mendukung akun dengan 2FA (password cloud).
- **FR-4** Sesi disimpan sebagai StringSession terenkripsi di SQLite.
- **FR-5** Saat startup, sesi di-restore otomatis tanpa OTP ulang.

### 6.2 Multi-Account
- **FR-6** Pengguna dapat menambahkan lebih dari satu akun Telegram.
- **FR-7** Pengguna dapat berpindah "active drive" antar akun.
- **FR-8** Setiap akun memiliki namespace file/folder terpisah.
- **FR-9** Pengguna dapat menghapus akun (logout + hapus sesi + opsi hapus metadata).

### 6.3 Manajemen File
- **FR-10** Upload file; file > batas Telegram dipecah jadi beberapa chunk (part).
- **FR-11** Download file; chunk digabung ulang menjadi file utuh.
- **FR-12** Buat/rename/hapus folder (virtual, di SQLite).
- **FR-13** Pindahkan file antar folder.
- **FR-14** Hapus file (opsi: hapus juga pesan di Telegram).
- **FR-15** Cari file berdasarkan nama.
- **FR-16** Tampilkan metadata: ukuran, tanggal, tipe MIME.

### 6.4 Penyimpanan (Backend Telegram)
- **FR-17** Byte file diunggah ke sebuah channel privat / "Saved Messages" milik akun.
- **FR-18** Setiap chunk menghasilkan `message_id`; mapping disimpan di SQLite.
- **FR-19** Integritas file diverifikasi via checksum (mis. SHA-256).

## 7. Kebutuhan Non-Fungsional

| Kategori | Kebutuhan |
|---|---|
| **Keamanan** | Session string & 2FA disimpan terenkripsi (AES-256-GCM). Secret via env var. |
| **Kinerja** | Upload/Download streaming (tidak load seluruh file ke memori). |
| **Keandalan** | Retry otomatis pada FloodWait / error jaringan Telegram. |
| **Skalabilitas** | Mendukung ribuan file per akun via indeks SQLite. |
| **Portabilitas** | Bisa di-self-host; single binary/proses Node. |
| **Observability** | Logging terstruktur; audit aksi upload/hapus. |
| **Kepatuhan** | Patuhi ToS Telegram; hormati rate limit (FloodWait). |

## 8. Alur Pengguna Utama (User Flows)

### 8.1 Onboarding Akun Baru
1. Buka `/accounts/add`.
2. Masukkan `api_id`, `api_hash`, nomor telepon.
3. TDrive kirim kode → pengguna masukkan OTP (dan password 2FA bila diminta).
4. Sesi tersimpan; akun muncul di daftar drive.

### 8.2 Upload File
1. Pilih akun aktif + folder tujuan.
2. Pilih file → TDrive stream ke Telegram (chunk bila perlu).
3. Metadata + mapping chunk disimpan di SQLite.
4. File tampil di daftar.

### 8.3 Download File
1. Klik file → TDrive ambil semua chunk dari Telegram sesuai mapping.
2. Gabungkan (stream) ke browser sebagai unduhan.

## 9. Rilis Bertahap (Roadmap)

| Fase | Fitur |
|---|---|
| **M1 (MVP)** | Login+sesi persistent, single account, upload/download, folder, list. |
| **M2** | Multi-account, chunking file besar, pencarian, checksum. |
| **M3** | Preview media, streaming, share link, quota per folder. |
| **M4** | Enkripsi E2E sisi klien, trash/restore, versi file. |

## 10. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Pelanggaran ToS Telegram / ban akun | Kehilangan akses storage | Batasi rate, hormati FloodWait, dokumentasikan penggunaan wajar |
| Batas ukuran file Telegram (2GB/4GB) | File besar gagal | Chunking + reassembly |
| Kebocoran session string | Pengambilalihan akun | Enkripsi at-rest, secret di env, akses terbatas |
| Perubahan API MTProto | Aplikasi rusak | Gunakan library terpelihara (GramJS), pin versi |
| Kehilangan DB metadata | File "yatim" di Telegram | Backup SQLite berkala, simpan index redundant di caption pesan |

## 11. Pertanyaan Terbuka
- Apakah storage per-akun terpisah total, atau ada mode "gabungan" lintas akun?
- Model multi-user TDrive itu sendiri (apakah aplikasi punya login sendiri di atas akun Telegram)?
- Kebijakan penghapusan: soft-delete (trash) vs hard-delete pesan Telegram.

---

*Dokumen ini adalah PRD tingkat produk. Detail teknis, skema data, dan arsitektur dibahas di `ANALISA-TEKNIS-TDrive.md`.*
