-- Skema TDrive (MariaDB)

-- Akun Telegram yang dikelola TDrive
CREATE TABLE IF NOT EXISTS accounts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  label         VARCHAR(255) DEFAULT NULL,
  phone         VARCHAR(50) NOT NULL,
  api_id        INT NOT NULL,
  api_hash      VARCHAR(255) NOT NULL,
  session_enc   LONGBLOB NOT NULL,   -- StringSession terenkripsi (AES-256-GCM)
  session_iv    LONGBLOB NOT NULL,
  session_tag   LONGBLOB NOT NULL,
  storage_peer  TEXT DEFAULT NULL,
  status        VARCHAR(50) DEFAULT 'active',
  password_hash VARCHAR(255) DEFAULT NULL, -- Password sistem untuk login tanpa OTP
  notes_salt    VARCHAR(255) DEFAULT NULL, -- Salt untuk PBKDF2/scrypt sandi catatan
  notes_verifier VARCHAR(255) DEFAULT NULL, -- Verifikator sandi catatan (ciphertext "tdrive-verifier")
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE KEY unique_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Folder virtual (pohon per akun)
CREATE TABLE IF NOT EXISTS folders (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  account_id    INT NOT NULL,
  parent_id     INT DEFAULT NULL,
  name          VARCHAR(255) NOT NULL,
  created_at    BIGINT NOT NULL,
  CONSTRAINT fk_folders_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_folders_parent FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
  UNIQUE KEY unique_folder (account_id, parent_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Metadata file
CREATE TABLE IF NOT EXISTS files (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  account_id    INT NOT NULL,
  folder_id     INT DEFAULT NULL,
  name          VARCHAR(255) NOT NULL,
  size          BIGINT NOT NULL,
  mime          VARCHAR(255) DEFAULT NULL,
  sha256        VARCHAR(64) DEFAULT NULL,
  is_chunked    TINYINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  CONSTRAINT fk_files_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_files_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mapping file -> pesan Telegram (mendukung chunk terurut)
CREATE TABLE IF NOT EXISTS file_chunks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  file_id       INT NOT NULL,
  part_index    INT NOT NULL,
  message_id    INT NOT NULL,
  peer          VARCHAR(255) NOT NULL DEFAULT 'me',
  size          BIGINT NOT NULL,
  CONSTRAINT fk_chunks_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  UNIQUE KEY unique_chunk (file_id, part_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- TNote: catatan cloud terenkripsi
CREATE TABLE IF NOT EXISTS notes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  account_id    INT NOT NULL,
  title         TEXT NOT NULL,                     -- Terenkripsi
  body          LONGTEXT NOT NULL,                 -- Terenkripsi
  category      VARCHAR(100) DEFAULT 'General',    -- Terenkripsi / biasa
  message_id    INT DEFAULT NULL,
  peer          VARCHAR(255) DEFAULT 'me',
  synced        TINYINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  CONSTRAINT fk_notes_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_notes_account ON notes(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_account_folder ON files(account_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON file_chunks(file_id, part_index);
CREATE INDEX IF NOT EXISTS idx_folders_account_parent ON folders(account_id, parent_id);

-- Tabel Sharing Publik (File, Folder, Catatan)
CREATE TABLE IF NOT EXISTS shares (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  uuid          VARCHAR(36) NOT NULL UNIQUE,
  item_type     VARCHAR(50) NOT NULL,            -- 'file' | 'folder' | 'note'
  item_id       INT NOT NULL,                    -- ID primary dari berkas, folder, atau catatan
  password_hash VARCHAR(255) DEFAULT NULL,       -- Password untuk membuka share (opsional)
  expires_at    BIGINT DEFAULT NULL,            -- Timestamp kedaluwarsa dalam milidetik (opsional)
  max_views     INT DEFAULT NULL,               -- Batas maksimal views (opsional)
  views_count   INT DEFAULT 0,                  -- Jumlah tayang/buka saat ini
  shared_title  TEXT DEFAULT NULL,              -- Judul catatan terdekripsi (khusus sharing note)
  shared_body   LONGTEXT DEFAULT NULL,          -- Isi catatan terdekripsi (khusus sharing note)
  shared_category VARCHAR(100) DEFAULT NULL,     -- Kategori catatan terdekripsi (khusus sharing note)
  created_at    BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabel Audit Logs untuk log aktivitas pengguna
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_phone    VARCHAR(50) DEFAULT NULL,        -- Nomor HP pelaku
  action        VARCHAR(100) NOT NULL,           -- Jenis aksi (mis. 'UPLOAD_FILE', 'DELETE_NOTE')
  details       TEXT DEFAULT NULL,               -- Detail aksi (nama file, note id, dll)
  ip_address    VARCHAR(45) DEFAULT NULL,        -- IP Address
  created_at    BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_shares_uuid ON shares(uuid);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- Tabel user_channels untuk melacak private channel penyimpanan buatan pengguna
CREATE TABLE IF NOT EXISTS user_channels (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  account_id    INT NOT NULL,
  channel_id    VARCHAR(255) NOT NULL UNIQUE,
  title         VARCHAR(255) NOT NULL,
  created_at    BIGINT NOT NULL,
  CONSTRAINT fk_user_channels_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabel shared_workspaces untuk kolaborasi multi-user
CREATE TABLE IF NOT EXISTS shared_workspaces (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  owner_account_id INT NOT NULL,
  target_phone     VARCHAR(50) NOT NULL,               -- Nomor telepon rekan kolaborasi
  item_type        VARCHAR(50) NOT NULL,               -- 'folder' | 'note'
  item_id          INT NOT NULL,                       -- ID dari berkas/folder/catatan
  permission       VARCHAR(20) DEFAULT 'read',         -- 'read' | 'write'
  created_at       BIGINT NOT NULL,
  CONSTRAINT fk_shared_workspaces_owner FOREIGN KEY (owner_account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_user_channels_account ON user_channels(account_id);
CREATE INDEX IF NOT EXISTS idx_shared_workspaces_target ON shared_workspaces(target_phone);


