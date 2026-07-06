'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'tdrive.sqlite');

// Pastikan direktori data ada
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Jalankan migrasi saat startup (idempotent — pakai IF NOT EXISTS)
const migration = fs.readFileSync(path.join(__dirname, 'migrations.sql'), 'utf8');
db.exec(migration);

module.exports = db;
