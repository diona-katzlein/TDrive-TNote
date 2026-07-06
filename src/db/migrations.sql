-- Skema TDrive (SQLite)
PRAGMA foreign_keys = ON;

-- Akun Telegram yang dikelola TDrive
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT,
  phone         TEXT NOT NULL,
  api_id        INTEGER NOT NULL,
  api_hash      TEXT NOT NULL,
  session_enc   BLOB NOT NULL,   -- StringSession terenkripsi (AES-256-GCM)
  session_iv    BLOB NOT NULL,
  session_tag   BLOB NOT NULL,
  storage_peer  TEXT DEFAULT 'me',
  status        TEXT DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Folder virtual (pohon per akun)
CREATE TABLE IF NOT EXISTS folders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(account_id, parent_id, name)
);

-- Metadata file
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id     INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mime          TEXT,
  sha256        TEXT,
  is_chunked    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Mapping file -> pesan Telegram (mendukung chunk terurut)
CREATE TABLE IF NOT EXISTS file_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_index    INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  peer          TEXT NOT NULL DEFAULT 'me',
  size          INTEGER NOT NULL,
  UNIQUE(file_id, part_index)
);

CREATE INDEX IF NOT EXISTS idx_files_account_folder ON files(account_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON file_chunks(file_id, part_index);
CREATE INDEX IF NOT EXISTS idx_folders_account_parent ON folders(account_id, parent_id);
