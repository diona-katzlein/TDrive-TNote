'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

// Inisialisasi DB (MariaDB Pool)
const db = require('./db');

const { activeAccount } = require('./middleware/activeAccount');
const { requireLogin } = require('./middleware/auth');
const { csrf } = require('./middleware/csrf');
const { isPhoneAllowed } = require('./services/accountService');

// Middleware Keamanan Baru
const { globalLimiter, authLimiter } = require('./middleware/rateLimit');
const honeypot = require('./middleware/honeypot');

const authRouter = require('./routes/auth');
const accountsRouter = require('./routes/accounts');
const foldersRouter = require('./routes/folders');
const filesRouter = require('./routes/files');
const notesRouter = require('./routes/notes');
const profileRouter = require('./routes/profile');
const shareRouter = require('./routes/share');
const webdavRouter = require('./routes/webdav');
const workspaceRouter = require('./routes/workspace');
const auditLogsRouter = require('./routes/auditLogs');
const backupRouter = require('./routes/backup');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Proteksi Laju Permintaan Global & Honeypot
app.use(globalLimiter);
app.use(express.urlencoded({ extended: true }));
app.use(honeypot);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'tdrive-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 hari
  })
);

// Rute WebDAV (Sebelum CSRF agar tidak terblokir csrf token check)
app.use('/webdav', webdavRouter);

// Proteksi CSRF untuk semua form (menyediakan res.locals.csrfToken)
app.use(csrf);

// Helper format ukuran untuk view
app.locals.formatSize = function (bytes) {
  if (bytes == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// Helper format tanggal (epoch ms) untuk view
app.locals.formatDate = function (ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Proteksi laju khusus untuk login
app.use('/login', authLimiter);

// Rute autentikasi (tidak terproteksi): /login, /login/send-code, /login/verify, /logout
app.use(authRouter);

// Sediakan daftar akun + akun aktif ke semua view terproteksi (jika sudah login)
app.use(activeAccount);

// Rute berbagi publik (akses terbuka untuk umum, tidak masuk requireLogin)
app.use('/share', shareRouter);

// Gerbang: semua di bawah ini wajib login via Telegram
app.use(requireLogin);

// Rute Akar (Root Redirect)
app.get('/', (req, res) => {
  if (isPhoneAllowed(req.session.userPhone)) {
    return res.redirect(req.activeAccount ? '/drive' : '/accounts');
  } else {
    return res.redirect('/profile');
  }
});

// Routes terproteksi
app.use('/profile', profileRouter);
app.use('/accounts', accountsRouter);
app.use('/folders', foldersRouter);
app.use('/drive', filesRouter);
app.use('/notes', notesRouter);
app.use('/workspace', workspaceRouter);
app.use('/audit-trail-logs', auditLogsRouter);
app.use('/backup', backupRouter);

// 404
app.use((req, res) => res.status(404).send('Halaman tidak ditemukan.'));

// Mulai Database dan Server secara Asinkron
async function start() {
  try {
    // Jalankan migrasi MariaDB
    await db.init();
    
    app.listen(PORT, () => {
      console.log(`TDrive berjalan di http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Gagal memulai server:', err);
    process.exit(1);
  }
}

start();
