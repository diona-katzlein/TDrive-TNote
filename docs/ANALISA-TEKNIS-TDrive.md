# Analisa Teknis — TDrive

| Field | Nilai |
|---|---|
| **Produk** | TDrive |
| **Stack** | Node.js + Express + EJS + SQLite + GramJS (MTProto) |
| **Versi** | 1.0 |
| **Tanggal** | 2026-07-05 |

---

## 1. Gambaran Arsitektur

```
┌──────────────────────────────────────────────────────────┐
│                        Browser (EJS)                       │
│   Login • Daftar file • Upload • Download • Folder          │
└───────────────▲───────────────────────────┬───────────────┘
                │ HTTP (Express routes)      │
┌───────────────┴───────────────────────────▼───────────────┐
│                     TDrive App (Node.js)                    │
│                                                            │
│  Routes/Controllers ── Services ── Telegram Client Manager  │
│        │                  │                │                │
│        │                  │                ▼                │
│        │                  │        GramJS (MTProto)  ──►  Telegram DC │
│        ▼                  ▼                                 │
│   EJS Views          SQLite (better-sqlite3)                │
│                    accounts • files • folders • chunks      │
└────────────────────────────────────────────────────────────┘
```

**Prinsip inti:** Telegram menyimpan **byte file**; SQLite menyimpan **metadata + mapping** (file → pesan/chunk). Aplikasi adalah lapisan orkestrasi & UI.

## 2. Pemilihan Teknologi

| Kebutuhan | Pilihan | Alasan |
|---|---|---|
| Web framework | **Express** | Ringan, matang, mudah routing + middleware. |
| Template | **EJS** | Server-side rendering sederhana, sesuai permintaan. |
| Database | **SQLite** via `better-sqlite3` | Zero-config, sinkron & cepat, cocok self-host single-node. |
| Telegram client | **GramJS** (`telegram`) | Library MTProto untuk **akun** (bukan bot), dukung StringSession. |
| Upload/chunk | `client.uploadFile` + `sendFile` | Menangani file besar & chunking bawaan. |
| Enkripsi sesi | `crypto` (AES-256-GCM) | Melindungi session string at-rest. |
| Auth password | `bcrypt`/`argon2` (opsional login app) | Bila TDrive punya login aplikasi sendiri. |
| Session web | `express-session` + store SQLite | Sesi login ke aplikasi TDrive. |

> Catatan: **Bot API tidak dipakai** karena batas file bot (20–50 MB unduh) dan bukan "akun sebagai drive". MTProto (akun) memberi batas file jauh lebih besar (2 GB, atau 4 GB untuk Premium).

## 3. Mengapa Telegram Bisa Jadi Drive

- Setiap akun punya **"Saved Messages"** dan bisa membuat **channel privat** sebagai kontainer file.
- Upload file lewat MTProto → menghasilkan pesan berisi *document*; setiap pesan punya `message_id`.
- Untuk mengambil file: `getMessages(message_id)` → `downloadMedia`.
- File > batas ukuran → dipecah menjadi beberapa **part/chunk**, tiap chunk = satu pesan, urutan disimpan di SQLite.

## 4. Model Data (SQLite)

```sql
-- Akun Telegram yang dikelola TDrive
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT,                       -- nama tampilan drive
  phone         TEXT NOT NULL,
  api_id        INTEGER NOT NULL,
  api_hash      TEXT NOT NULL,
  session_enc   BLOB NOT NULL,              -- StringSession terenkripsi (AES-256-GCM)
  session_iv    BLOB NOT NULL,
  session_tag   BLOB NOT NULL,
  storage_peer  TEXT,                       -- channel id / 'me' (Saved Messages)
  status        TEXT DEFAULT 'active',      -- active | logged_out | error
  created_at    INTEGER,
  updated_at    INTEGER
);

-- Folder virtual (struktur pohon per akun)
CREATE TABLE folders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    INTEGER,
  UNIQUE(account_id, parent_id, name)
);

-- Metadata file
CREATE TABLE files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id     INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mime          TEXT,
  sha256        TEXT,                       -- integritas
  is_chunked    INTEGER DEFAULT 0,
  created_at    INTEGER,
  updated_at    INTEGER
);

-- Mapping file → pesan Telegram (mendukung chunk terurut)
CREATE TABLE file_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_index    INTEGER NOT NULL,           -- urutan chunk (0..n)
  message_id    INTEGER NOT NULL,           -- id pesan di Telegram
  peer          TEXT NOT NULL,              -- channel/'me'
  size          INTEGER NOT NULL,
  UNIQUE(file_id, part_index)
);

-- Sesi login ke aplikasi TDrive (opsional, jika ada auth app)
CREATE TABLE app_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER
);

CREATE INDEX idx_files_account_folder ON files(account_id, folder_id);
CREATE INDEX idx_files_name ON files(name);
CREATE INDEX idx_chunks_file ON file_chunks(file_id, part_index);
```

## 5. Manajemen Sesi (Session Persistent)

### 5.1 Strategi
- Setelah login sukses, GramJS menghasilkan **StringSession**.
- String tersebut **dienkripsi (AES-256-GCM)** dengan kunci dari `TDRIVE_MASTER_KEY` (env), lalu disimpan di `accounts.session_enc`.
- Saat aplikasi start atau akun dipilih, string didekripsi → `new StringSession(str)` → `client.connect()` **tanpa OTP ulang**.

### 5.2 Pseudocode Restore
```js
// services/telegramManager.js
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const clients = new Map(); // accountId -> TelegramClient (pool, persistent)

async function getClient(account) {
  if (clients.has(account.id)) return clients.get(account.id);

  const sessionStr = decrypt(account.session_enc, account.session_iv, account.session_tag);
  const client = new TelegramClient(
    new StringSession(sessionStr),
    account.api_id,
    account.api_hash,
    { connectionRetries: 5 }
  );
  await client.connect();          // pakai sesi tersimpan, tidak minta OTP
  clients.set(account.id, client); // pertahankan koneksi (persistent)
  return client;
}
```

### 5.3 Alur Login Awal (dengan OTP)
```js
await client.start({
  phoneNumber: async () => phone,
  phoneCode:   async () => await promptUserForOTP(), // dari form web
  password:    async () => await promptUserFor2FA(),  // bila akun 2FA
  onError:     (err) => log(err),
});
const sessionStr = client.session.save();  // StringSession
storeEncrypted(accountId, sessionStr);
```

> Karena OTP bersifat interaktif, alur login web memakai **state sementara** (mis. simpan `phoneCodeHash` + step di server-side session) di antara request "kirim kode" dan "verifikasi kode".

## 6. Multi-Account

- Tabel `accounts` menampung banyak akun.
- **Connection pool** `Map<accountId, TelegramClient>` menjaga tiap akun tetap terhubung (persistent) dan reusable antar-request.
- "Active drive" disimpan di sesi web pengguna (`req.session.activeAccountId`).
- Namespace file/folder dipisah lewat `account_id` di setiap query.
- Lifecycle: idle client dapat di-disconnect setelah timeout untuk hemat resource, lalu di-reconnect on-demand dari StringSession.

## 7. Upload & Chunking

### 7.1 Alur Upload
```
File masuk (stream) ──► Hitung ukuran & SHA-256
        │
        ├─ ukuran ≤ LIMIT ─► uploadFile → sendFile ke storage_peer ─► 1 pesan
        │
        └─ ukuran >  LIMIT ─► split jadi N part
                                 └─ tiap part: uploadFile → sendFile ─► message_id
        ▼
Simpan row `files` + N row `file_chunks` (part_index, message_id) di SQLite (transaksi)
```

- `LIMIT` mengikuti batas Telegram (≈2 GB non-premium). Chunk size dipilih di bawah limit (mis. 1.9 GB) atau lebih kecil untuk keandalan (mis. 512 MB).
- Simpan `part_index` untuk menjaga urutan reassembly.
- Gunakan **transaksi** SQLite: metadata & seluruh chunk ditulis atomik.

### 7.2 Contoh (konseptual)
```js
const result = await client.sendFile(peer, {
  file: buffer,                 // atau path stream
  caption: JSON.stringify({ f: fileId, p: partIndex }), // index redundan
  forceDocument: true,
});
const messageId = result.id;
```

## 8. Download & Reassembly

```
Request download(fileId)
   └─ ambil chunks urut part_index dari SQLite
        └─ untuk tiap chunk: getMessages(peer, message_id) → downloadMedia (stream)
             └─ pipe berurutan ke response HTTP (Content-Disposition: attachment)
   └─ (opsional) verifikasi SHA-256 saat streaming
```

- **Streaming**, tidak menyimpan seluruh file di memori/disk.
- Set `Content-Length` = `files.size`, `Content-Type` = `files.mime`.

## 9. Struktur Proyek

```
tdrive/
├── src/
│   ├── app.js                  # bootstrap Express
│   ├── db/
│   │   ├── index.js            # koneksi better-sqlite3
│   │   └── migrations.sql      # skema tabel
│   ├── routes/
│   │   ├── accounts.js         # tambah/hapus/pilih akun Telegram
│   │   ├── files.js            # list/upload/download/move/delete
│   │   └── folders.js
│   ├── services/
│   │   ├── telegramManager.js  # pool client, connect, restore sesi
│   │   ├── storageService.js   # upload/chunk/download/reassembly
│   │   ├── cryptoService.js    # AES-256-GCM enkripsi sesi
│   │   └── fileService.js      # logika metadata di SQLite
│   ├── middleware/
│   │   └── activeAccount.js
│   └── views/                  # EJS
│       ├── partials/ (header, footer)
│       ├── accounts/ (list, add, verify)
│       └── files/ (browser)
├── public/                     # css/js statis
├── .env                        # TDRIVE_MASTER_KEY, PORT, SESSION_SECRET
└── package.json
```

## 10. Rancangan Endpoint (REST-ish)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/accounts` | Daftar akun/drive |
| GET | `/accounts/add` | Form tambah akun |
| POST | `/accounts/send-code` | Kirim OTP (simpan phoneCodeHash) |
| POST | `/accounts/verify` | Verifikasi OTP/2FA → simpan sesi |
| POST | `/accounts/:id/activate` | Set active drive |
| POST | `/accounts/:id/delete` | Logout + hapus sesi |
| GET | `/drive?folder=:id` | Browse file & folder |
| POST | `/folders` | Buat folder |
| POST | `/drive/upload` | Upload (multipart) |
| GET | `/drive/:id/download` | Download (reassembly) |
| POST | `/drive/:id/rename` | Rename |
| POST | `/drive/:id/delete` | Hapus (opsi hapus pesan Telegram) |
| GET | `/drive?q=` | Cari file |

## 11. Keamanan

| Aspek | Kontrol |
|---|---|
| Session string at-rest | AES-256-GCM, kunci dari env (`TDRIVE_MASTER_KEY`), tidak pernah di-log |
| 2FA password | Tidak disimpan; hanya dipakai saat login |
| Transport | Wajib HTTPS (reverse proxy: Nginx/Caddy) |
| Auth aplikasi | `express-session` + password hash (argon2/bcrypt) bila multi-user |
| CSRF | Token CSRF pada form POST |
| Rate limit / FloodWait | Tangani `FloodWaitError` → backoff sesuai `seconds` |
| Input validation | Validasi nama file/folder, path traversal dicegah (folder virtual) |

## 12. Penanganan Error & Keandalan

- **FloodWait**: tangkap `FloodWaitError`, jeda sesuai `err.seconds`, retry.
- **Reconnect**: pada disconnect, reconnect otomatis dari StringSession.
- **Upload gagal di tengah**: transaksi SQLite rollback; chunk yatim dibersihkan oleh job cleanup.
- **Integritas**: verifikasi SHA-256 saat download; tandai file corrupt bila mismatch.
- **Backup**: jadwalkan backup `tdrive.sqlite` (metadata adalah aset kritis).

## 13. Batasan & Pertimbangan

- **Kepatuhan ToS Telegram**: pemakaian sebagai storage massal berisiko; gunakan wajar, hormati rate limit.
- **Batas ukuran**: 2 GB (biasa) / 4 GB (Premium) per file → chunking untuk lebih besar.
- **Kecepatan**: bergantung pada DC Telegram & jaringan; unggah paralel per chunk bisa mempercepat namun menaikkan risiko FloodWait.
- **Metadata = single source of truth**: kehilangan SQLite = file sulit ditemukan → wajib backup + simpan index redundan di caption pesan.
- **Bukan Bot API**: memakai akun (MTProto) berarti tanggung jawab keamanan sesi lebih tinggi.

## 14. Perintah Setup (Windows)

```bat
:: Inisialisasi proyek
npm install

:: Siapkan environment
copy .env.example .env

:: Generate kunci master (tempel ke TDRIVE_MASTER_KEY di .env)
npm run genkey

:: Menjalankan
npm start
:: atau dengan nodemon
npm run dev
```

## 15. Rekomendasi Implementasi Bertahap

1. **Fondasi**: Express + EJS + SQLite migrasi + halaman kosong.
2. **Auth Telegram 1 akun**: send-code → verify → simpan sesi terenkripsi → restore.
3. **Storage dasar**: upload kecil (1 pesan) + download + list.
4. **Folder virtual** + rename/move/delete.
5. **Chunking** file besar + reassembly + SHA-256.
6. **Multi-account** + connection pool + active drive.
7. **Hardening**: FloodWait handling, CSRF, HTTPS, backup.

---

*Analisa ini melengkapi `PRD-TDrive.md`. Keputusan desain final (mode storage gabungan vs terpisah, kebijakan hapus) menunggu jawaban atas "Pertanyaan Terbuka" di PRD.*
