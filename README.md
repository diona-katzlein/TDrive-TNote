# TDrive and TNote · Telegram as Cloud Drive and Cloud Note

Jadikan akun **Telegram** Anda sebagai **Cloud Storage** pribadi (TDrive) dan **Catatan Terenkripsi** aman (TNote). Web app premium, aman, dan ringan berbasis **Node.js + Express + EJS + MariaDB** dengan dukungan **multi-account**, **session persistent** (MTProto via GramJS), login sandi instan, sharing publik, serta fitur keamanan tinggi.

> 📦 Byte file & backup catatan disimpan di Telegram (Saved Messages/Channel), sedangkan metadata & index disimpan di database MariaDB.

---

## Fitur Unggulan

### 1. TDrive (Cloud Storage)
- **Virtual Directory**: Mendukung pembuatan folder, penggantian nama, pemindahan berkas, dan penghapusan bertingkat.
- **Upload File Besar (>50MB++)**: Proses upload menggunakan AJAX interaktif dilengkapi **Progress Bar**, indikator kecepatan transfer (MB/s), persentase, dan estimasi waktu tersisa.
- **Auto-Chunking & Reassembly**: Mendukung upload file berukuran gigabyte dengan chunking otomatis ke Telegram DC dan penggabungan kembali saat diunduh.
- **Verifikasi Integritas**: Cek SHA-256 berkas untuk memastikan data tidak rusak/berubah.

### 2. TNote (Cloud Note - Enkripsi E2E)
- **Zero-Knowledge Encryption**: Judul, isi, dan kategori catatan dienkripsi secara penuh di browser/sesi pengguna menggunakan algoritma AES-256-GCM berbasis kata sandi yang tidak disimpan di server.
- **Kategori Organik**: Pengelompokkan catatan dengan sidebar dinamis yang mudah digunakan.
- **Sinkronisasi Telegram**: Catatan dicadangkan ke Telegram secara terenkripsi.

### 3. Public Sharing (Folder, File, Catatan)
- Bagikan item apa saja ke publik dengan opsi:
  - **Proteksi Kata Sandi**: Pengunjung publik wajib memasukkan sandi share sebelum bisa melihat/mengunduh.
  - **Batas Masa Berlaku**: Tautan akan kedaluwarsa secara otomatis setelah jangka waktu tertentu (dalam jam).
  - **Batas Jumlah Buka (Max Views)**: Membatasi berapa kali tautan publik bisa dibuka/diakses.
  - **Shared Folder Navigation**: Pengunjung publik bisa menjelajahi subfolder di dalam folder bersama dan mengunduh file secara terpisah.

### 4. Keamanan Sistem & Observabilitas
- **Login Sandi Sistem**: Setelah login Telegram pertama kali, Anda dapat menyetel PIN/Sandi masuk di halaman `/profile` untuk masuk instan di perangkat lain tanpa request OTP Telegram berulang kali.
- **Honeypot Protection**: Mendeteksi dan memblokir bot pengirim form otomatis via hidden field `website`.
- **Rate Limiting**: Pencegahan brute-force sandi (5 req/menit pada login) dan pembatasan beban request global (150 req/menit per IP).
- **Audit Logs Trail**: Pencatatan riwayat aktivitas penting (upload, hapus, download, sharing, dsb.) lengkap dengan data IP Address, timestamp, dan identitas nomor HP pelaku.

---

## Prasyarat & Instalasi

### Prasyarat
- **Node.js** >= 18.
- **MariaDB Server** (Port default dev: `3307`, user: `root`, tanpa password, database: `tdrive`).
- `api_id` dan `api_hash` dari [my.telegram.org](https://my.telegram.org).

### Instalasi Cepat (Windows)

1. **Install Dependensi**
   ```cmd
   npm install
   ```

2. **Konfigurasi Environment**
   Salin `.env.example` ke `.env` dan sesuaikan nilainya:
   ```env
   PORT=3061
   DB_HOST=127.0.0.1
   DB_PORT=3307
   DB_USER=root
   DB_PASSWORD=
   DB_DATABASE=tdrive

   # Kunci master enkripsi sesi (32 byte hex)
   TDRIVE_MASTER_KEY=hasil_genkey_anda
   
   # Nomor telepon admin yang diizinkan mengakses menu /accounts (pisahkan dengan koma jika multi-admin)
   TDRIVE_ALLOWED_PHONES=+6281234567890
   ```

3. **Generate Master Key**
   ```cmd
   npm run genkey
   ```
   Tempelkan string hex yang dihasilkan ke variabel `TDRIVE_MASTER_KEY` di file `.env`.

4. **Jalankan Aplikasi**
   ```cmd
   npm run dev
   ```
   Buka browser dan akses `http://localhost:3061`.

---

## Status Implementasi Fitur

| Fitur | Status | Deskripsi |
|---|---|---|
| Login Telegram (OTP + 2FA) | ✅ | Autentikasi aman via GramJS |
| Session persistent (AES-256-GCM) | ✅ | StringSession disimpan terenkripsi di MariaDB |
| Login Sandi Sistem | ✅ | Masuk instan tanpa OTP berulang |
| E2E Notes (TNote) | ✅ | Catatan terenkripsi penuh berbasis password E2E |
| Folder Virtual | ✅ | Navigasi direktori, buat/rename/hapus bertingkat |
| Upload AJAX + Progress Bar | ✅ | Progress bar, MB/s speed, ETA timer |
| Sharing Publik (File/Folder/Note) | ✅ | Dilengkapi password, batas waktu, dan max views |
| Rate Limiter & Honeypot | ✅ | Melindungi form dari brute force & bot |
| Audit Logs | ✅ | Pencatatan trail aksi pengguna ke tabel DB |
| Multi-Account Storage | ✅ | Dukungan menukar akun penyimpanan di header |
| Donasi & Branding | ✅ | Integrasi logo/favicon premium & donasi link |

---

## Keamanan dan Operasi Production

### Persyaratan startup

Ketika `NODE_ENV=production`, aplikasi akan **gagal startup** apabila:

- `SESSION_SECRET` tidak acak atau kurang dari 32 karakter.
- `TDRIVE_MASTER_KEY` bukan kunci hex 32 byte (64 karakter).
- `DB_USER=root`, password database kosong, atau password kurang dari 12 karakter.
- `TDRIVE_HTTPS` tidak bernilai `true`.

Gunakan reverse proxy HTTPS (misalnya Nginx) dan atur `TRUST_PROXY` hanya sesuai jumlah proxy yang benar-benar dipercaya. Jangan gunakan `TRUST_PROXY=true` pada topologi jaringan yang tidak terkontrol.

### Session dan perangkat

- Session ID dirotasi setelah autentikasi berhasil untuk mencegah session fixation.
- Cookie production menggunakan `httpOnly`, `secure`, `sameSite=lax`, rolling expiry, dan prefix `__Host-`.
- Daftar perangkat aktif, pencabutan satu session, dan logout perangkat lain tersedia pada halaman **Profile**.
- Registry aplikasi hanya menyimpan hash SHA-256 session ID, bukan nilai cookie mentah.

### WebDAV read-only

WebDAV hanya menerima `OPTIONS`, `PROPFIND`, `HEAD`, dan `GET`. Pengguna wajib membuat password WebDAV khusus pada halaman **Profile**; password login web tidak dapat digunakan. Path, `Depth`, ukuran request, brute-force per IP/username, dan kepemilikan akun divalidasi oleh server.

### Durable job queue dan notification center

Operasi remote delete, verifikasi integritas, cleanup pesan TNote, rekonsiliasi, dan backup dipersistenkan pada MariaDB. Worker memakai lease, retry eksponensial, progress, recovery pekerjaan `running` yang stale setelah restart, serta status dead-letter. Halaman **Jobs** menampilkan status dan tombol Retry; hasil penting juga masuk ke **Notifications**. Atur `JOB_WORKER_ENABLED`, `JOB_POLL_MS`, dan `JOB_LEASE_MS` sesuai kapasitas worker.

Upload browser biasa masih diselesaikan dalam request agar file sementara tidak hilang. Upload chunk besar dicatat pada `upload_sessions`, terikat pada akun, dan muncul di dashboard/reconciliation jika gagal atau stale.

### Search, bulk actions, dan TKinerja export

- Search header mencari file, folder, TKinerja, shortlink, dan TNote yang sedang unlocked pada akun aktif. Isi TNote tidak dibuatkan indeks plaintext global.
- Drive menyediakan pemilihan massal untuk soft-delete file/folder dan penjadwalan verifikasi integritas file. Server mengulang validasi kepemilikan setiap UUID.
- TKinerja menyediakan rekap durasi/jumlah bukti bulanan, CSV UTF-8 yang kompatibel Excel, serta tampilan cetak untuk **Save as PDF** native browser.

### Backup terenkripsi dan disaster recovery

Backup dibuat dengan `mariadb-dump`/`mysqldump` tanpa shell interpolation. Password database diberikan melalui environment child process dan tidak dimasukkan ke command line. Output SQL langsung dienkripsi dengan AES-256-GCM menjadi `.sql.enc`; plaintext tidak ditulis ke direktori backup.

```env
BACKUP_ENCRYPTION_KEY=<64 karakter hex, berbeda dari master key>
BACKUP_SCHEDULE_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_COUNT=14
BACKUP_SECONDARY_DIR=D:\\backup-secondary
BACKUP_RESTORE_ENABLED=false
```

Jika `BACKUP_SECONDARY_DIR` diisi, artifact terenkripsi direplikasi secara atomik dan checksum salinan diverifikasi. Tombol **Simulasi** mendekripsi ke file temporer berizin terbatas, mengimpor ke database terisolasi, memeriksa jumlah tabel, lalu selalu menghapus database dan plaintext sementara. Restore ke database aktif dinonaktifkan secara default; aktifkan `BACKUP_RESTORE_ENABLED=true` hanya pada maintenance terencana dan ketik nama database dengan tepat pada form. Ambil backup terbaru dan hentikan traffic aplikasi sebelum restore produksi.

Simpan `BACKUP_ENCRYPTION_KEY` di secret manager/offline vault yang terpisah dari kedua lokasi backup. Kehilangan kunci berarti seluruh backup tidak dapat dipulihkan.

### Rekonsiliasi dan storage health

Menu admin **Rekonsiliasi** memeriksa urutan/ukuran chunk, flag metadata, media Telegram, ukuran streaming, SHA-256, junction bukti TKinerja yang rusak, dan upload setengah selesai. Perbaikan otomatis konservatif: mengisi hash kosong setelah verifikasi atau menghapus junction yang terbukti kehilangan file/lintas akun. Sistem tidak membuat ulang atau menghubungkan pesan Telegram secara spekulatif.

Dashboard **Health** menampilkan penggunaan storage, soft quota, pertumbuhan harian/bulanan, chunk, file terbesar, upload gagal, status pekerjaan, backup terakhir, dan status koneksi/otorisasi Telegram. Alert quota dan session invalid dideduplikasi selama 24 jam. Atur `STORAGE_QUOTA_BYTES`, `STORAGE_QUOTA_WARN_PERCENT`, dan `UPLOAD_STALE_MINUTES` bila diperlukan.

### Validasi sebelum deploy

```cmd
npm test
npm run check:syntax
npm run migrate:check
```

CSP saat ini bersifat transisional karena template lama masih memiliki inline script/style. Sumber eksternal tetap dibatasi, tetapi migrasi inline asset ke file statis/nonce diperlukan sebelum menghapus `unsafe-inline`.

---

## Donasi & Dukungan

Proyek ini gratis dan open-source. Jika Anda menyukai proyek ini, silakan berikan donasi Anda untuk mendukung kelangsungan pengembangannya:
- 🐙 **Tako.ID**: [https://tako.id/IsekaiID/gift](https://tako.id/IsekaiID/gift)
- ☕ **Trakteer**: [https://trakteer.id/isekai_id/gift](https://trakteer.id/isekai_id/gift)

---

## Lisensi & ToS
- Gunakan web app ini secara bijaksana sesuai dengan **Telegram API Terms of Service**.
- Selalu jaga kerahasiaan `TDRIVE_MASTER_KEY` Anda karena semua token enkripsi sesi bergantung padanya.
