'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

// Inisialisasi DB (menjalankan migrasi)
require('./db');

const { activeAccount } = require('./middleware/activeAccount');
const { requireLogin } = require('./middleware/auth');
const { csrf } = require('./middleware/csrf');
const authRouter = require('./routes/auth');
const accountsRouter = require('./routes/accounts');
const foldersRouter = require('./routes/folders');
const filesRouter = require('./routes/files');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware dasar
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'tdrive-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 hari
  })
);

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

// Rute autentikasi (tidak terproteksi): /login, /login/send-code, /login/verify, /logout
app.use(authRouter);

// Gerbang: semua di bawah ini wajib login via Telegram
app.use(requireLogin);

// Sediakan daftar akun + akun aktif ke semua view terproteksi
app.use(activeAccount);

// Routes terproteksi
app.get('/', (req, res) => res.redirect(req.activeAccount ? '/drive' : '/accounts'));
app.use('/accounts', accountsRouter);
app.use('/folders', foldersRouter);
app.use('/drive', filesRouter);

// 404
app.use((req, res) => res.status(404).send('Halaman tidak ditemukan.'));

app.listen(PORT, () => {
  console.log(`TDrive berjalan di http://localhost:${PORT}`);
});
