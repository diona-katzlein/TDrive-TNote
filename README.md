# TDrive

Jadikan akun **Telegram** sebagai cloud drive pribadi. Web app ringan berbasis
**Node.js + Express + EJS + SQLite** dengan dukungan **multi-account** dan
**session persistent** (MTProto via GramJS).

> Byte file disimpan di Telegram (Saved Messages), metadata & mapping disimpan di SQLite.

Dokumen desain: lihat `docs/PRD-TDrive.md` dan `docs/ANALISA-TEKNIS-TDrive.md`.

---

## Prasyarat

- Node.js >= 18
- `api_id` dan `api_hash` dari https://my.telegram.org (Login → API development tools)

## Instalasi (Windows)

```bat
:: 1) Install dependensi
npm install

:: 2) Siapkan environment
copy .env.example .env

:: 3) Generate kunci master (32 byte hex) lalu tempel ke TDRIVE_MASTER_KEY di .env
npm run genkey

:: 4) Jalankan
npm start
:: atau mode dev (auto-reload)
npm run dev
```

Buka `http://localhost:3000`.

## Alur Pemakaian

1. Buka **Accounts → Add Account**.
2. Masukkan `api_id`, `api_hash`, nomor telepon (format internasional, mis. `+62812xxxx`).
3. Masukkan **kode OTP** yang dikirim Telegram (dan **password 2FA** bila akun mengaktifkannya).
4. Sesi tersimpan terenkripsi → akun muncul sebagai drive.
5. Pilih akun aktif, lalu unggah / unduh / buat folder di halaman **Drive**.

## Status Implementasi

| Fitur | Status |
|---|---|
| Login Telegram (OTP + 2FA) | ✅ |
| Session persistent (AES-256-GCM) | ✅ |
| Multi-account + active drive | ✅ |
| Folder virtual (buat / rename / hapus) | ✅ |
| Upload / Download (streaming) | ✅ |
| Chunking file besar (>2GB) + reassembly | ✅ |
| Pindahkan file antar folder | ✅ |
| Rename / hapus file (opsi hapus pesan Telegram) | ✅ |
| Verifikasi integritas SHA-256 (FR-19) | ✅ |
| Pencarian file | ✅ |
| Dashboard: jumlah file & total ukuran | ✅ |
| Ketahanan: FloodWait retry + reconnect otomatis | ✅ |
| Proteksi CSRF pada semua form | ✅ |
| Preview / streaming media in-browser | ⬜ TODO (M3) |
| Share link publik | ⬜ TODO (M3) |
| Trash / restore, versi file | ⬜ TODO (M4) |

## Catatan Keamanan & ToS

- `StringSession` disimpan **terenkripsi**; jaga kerahasiaan `TDRIVE_MASTER_KEY`.
- Jalankan di belakang HTTPS (reverse proxy) untuk produksi.
- Gunakan secara wajar; hormati rate limit Telegram (FloodWait) untuk menghindari pembatasan akun.

## Struktur

```
src/
  app.js                 bootstrap Express
  db/                    koneksi + migrasi SQLite
  services/              crypto, telegramManager, fileService, storageService
  routes/                accounts, folders, files
  middleware/            activeAccount
  views/                 EJS
public/                  css statis
docs/                    PRD & analisa teknis
```
