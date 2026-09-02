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

-- Tabel shortlinks untuk modul TShort
CREATE TABLE IF NOT EXISTS shortlinks (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  account_id  INT NOT NULL,
  short_code  VARCHAR(50) NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  clicks      INT DEFAULT 0,
  created_at  BIGINT NOT NULL,
  CONSTRAINT fk_shortlinks_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON shortlinks(short_code);

-- TKinerja: laporan bukti dukung kinerja dengan gambar tersimpan di TDrive/Telegram
CREATE TABLE IF NOT EXISTS kinerja_reports (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  uuid          VARCHAR(36) NOT NULL UNIQUE,
  account_id    INT NOT NULL,
  folder_id     INT NOT NULL,
  evidence_file_id INT DEFAULT NULL,
  activity_date DATE NOT NULL,
  title         VARCHAR(255) NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  description   LONGTEXT DEFAULT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  CONSTRAINT fk_kinerja_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_kinerja_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  CONSTRAINT fk_kinerja_evidence FOREIGN KEY (evidence_file_id) REFERENCES files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_kinerja_account_date ON kinerja_reports(account_id, activity_date DESC);

-- Banyak bukti gambar untuk satu laporan. Kolom legacy evidence_file_id tetap dipertahankan
-- agar deployment/rollback lama aman, lalu datanya disalin idempotent ke tabel ini.
CREATE TABLE IF NOT EXISTS kinerja_evidence (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  report_id   INT NOT NULL,
  file_id     INT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  UNIQUE KEY uq_kinerja_evidence_file (report_id, file_id),
  CONSTRAINT fk_kinerja_evidence_report FOREIGN KEY (report_id) REFERENCES kinerja_reports(id) ON DELETE CASCADE,
  CONSTRAINT fk_kinerja_evidence_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_kinerja_evidence_report ON kinerja_evidence(report_id, sort_order, id);

INSERT IGNORE INTO kinerja_evidence (report_id, file_id, sort_order, created_at)
SELECT id, evidence_file_id, 0, created_at
FROM kinerja_reports
WHERE evidence_file_id IS NOT NULL;

-- Registry perangkat/sesi. Hanya hash SHA-256 session ID yang disimpan.
CREATE TABLE IF NOT EXISTS user_sessions (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_hash  VARCHAR(64) NOT NULL UNIQUE,
  account_id    INT NOT NULL,
  user_phone    VARCHAR(50) NOT NULL,
  device_name   VARCHAR(255) NOT NULL,
  user_agent    VARCHAR(500) DEFAULT NULL,
  ip_address    VARCHAR(45) DEFAULT NULL,
  created_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  revoked_at    BIGINT DEFAULT NULL,
  CONSTRAINT fk_user_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_user_sessions_account ON user_sessions(account_id, last_seen_at DESC);

-- Riwayat backup terenkripsi dan hasil verifikasi struktur dump.
CREATE TABLE IF NOT EXISTS backup_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  filename        VARCHAR(255) DEFAULT NULL,
  status          VARCHAR(30) NOT NULL,
  trigger_type    VARCHAR(30) NOT NULL,
  encrypted       TINYINT NOT NULL DEFAULT 1,
  size_bytes      BIGINT DEFAULT NULL,
  checksum_sha256 VARCHAR(64) DEFAULT NULL,
  verified_at     BIGINT DEFAULT NULL,
  error_message   VARCHAR(500) DEFAULT NULL,
  created_at      BIGINT NOT NULL,
  completed_at    BIGINT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_backup_runs_created ON backup_runs(created_at DESC);

-- Laporan pemeriksaan konsistensi metadata database terhadap Telegram.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id      INT DEFAULT NULL,
  status          VARCHAR(30) NOT NULL,
  files_checked   INT NOT NULL DEFAULT 0,
  chunks_checked  INT NOT NULL DEFAULT 0,
  issues_found    INT NOT NULL DEFAULT 0,
  details         LONGTEXT DEFAULT NULL,
  created_at      BIGINT NOT NULL,
  completed_at    BIGINT DEFAULT NULL,
  CONSTRAINT fk_reconciliation_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_reconciliation_created ON reconciliation_runs(created_at DESC);

-- Durable MariaDB-backed background jobs with leases, retries, progress, and dead-letter state.
CREATE TABLE IF NOT EXISTS jobs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  uuid            VARCHAR(36) NOT NULL UNIQUE,
  account_id      INT DEFAULT NULL,
  type            VARCHAR(80) NOT NULL,
  payload         LONGTEXT NOT NULL,
  status          VARCHAR(30) NOT NULL DEFAULT 'pending',
  progress        INT NOT NULL DEFAULT 0,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  available_at    BIGINT NOT NULL,
  locked_at       BIGINT DEFAULT NULL,
  locked_by       VARCHAR(100) DEFAULT NULL,
  last_error      VARCHAR(500) DEFAULT NULL,
  result          LONGTEXT DEFAULT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  completed_at    BIGINT DEFAULT NULL,
  CONSTRAINT fk_jobs_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, available_at, locked_at);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id, created_at DESC);

-- In-app notifications generated by jobs and health operations.
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id  INT DEFAULT NULL,
  user_phone  VARCHAR(50) DEFAULT NULL,
  type        VARCHAR(50) NOT NULL,
  severity    VARCHAR(20) NOT NULL DEFAULT 'info',
  title       VARCHAR(255) NOT NULL,
  message     TEXT NOT NULL,
  link        VARCHAR(500) DEFAULT NULL,
  read_at     BIGINT DEFAULT NULL,
  created_at  BIGINT NOT NULL,
  CONSTRAINT fk_notifications_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_phone ON notifications(user_phone, read_at, created_at DESC);

-- Track browser chunk uploads so abandoned/incomplete uploads are observable and repairable.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  upload_id       VARCHAR(100) NOT NULL UNIQUE,
  account_id      INT NOT NULL,
  filename        VARCHAR(255) NOT NULL,
  folder_uuid     VARCHAR(36) DEFAULT NULL,
  total_chunks    INT NOT NULL,
  received_chunks INT NOT NULL DEFAULT 0,
  status          VARCHAR(30) NOT NULL DEFAULT 'receiving',
  error_message   VARCHAR(500) DEFAULT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  completed_at    BIGINT DEFAULT NULL,
  CONSTRAINT fk_upload_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_health ON upload_sessions(account_id, status, updated_at DESC);

-- Account-scoped universal-search history and reusable filter presets.
CREATE TABLE IF NOT EXISTS search_history (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id  INT NOT NULL,
  query_text  VARCHAR(100) NOT NULL,
  filters     TEXT DEFAULT NULL,
  searched_at BIGINT NOT NULL,
  CONSTRAINT fk_search_history_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_search_history_account ON search_history(account_id, searched_at DESC);

CREATE TABLE IF NOT EXISTS saved_search_filters (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) NOT NULL UNIQUE,
  account_id  INT NOT NULL,
  name        VARCHAR(80) NOT NULL,
  query_text  VARCHAR(100) DEFAULT NULL,
  filters     TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE KEY uq_saved_search_name (account_id, name),
  CONSTRAINT fk_saved_search_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_saved_search_account ON saved_search_filters(account_id, updated_at DESC);

