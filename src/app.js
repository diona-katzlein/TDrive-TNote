'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const {
  assertProductionConfig,
  isProduction,
  requestId,
  securityHeaders,
  sessionCookieOptions,
  trustProxySetting,
} = require('./config/security');

assertProductionConfig();

// Inisialisasi DB (MariaDB Pool)
const db = require('./db');

const { activeAccount } = require('./middleware/activeAccount');
const { requireLogin } = require('./middleware/auth');
const { csrf } = require('./middleware/csrf');
const { isPhoneAllowed } = require('./services/accountService');
const logger = require('./services/logger');

// Middleware Keamanan Baru
const { globalLimiter, authLimiter } = require('./middleware/rateLimit');
const honeypot = require('./middleware/honeypot');
const sessionService = require('./services/sessionService');
const backupService = require('./services/backupService');
const jobQueue = require('./services/jobQueue');
const { registerJobHandlers } = require('./services/jobHandlers');
const notificationService = require('./services/notificationService');
registerJobHandlers();

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
const reconciliationRouter = require('./routes/reconciliation');
const shortlinkRouter = require('./routes/shortlink');
const kinerjaRouter = require('./routes/kinerja');
const jobsRouter = require('./routes/jobs');
const notificationsRouter = require('./routes/notifications');
const searchRouter = require('./routes/search');
const healthRouter = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
app.set('trust proxy', trustProxySetting());
app.use((req, res, next) => {
  req.id = requestId(req);
  res.setHeader('X-Request-ID', req.id);
  next();
});
app.use(logger.requestLogger);
app.use(securityHeaders);

app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});
app.get('/readyz', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ready', database: 'reachable' });
  } catch (error) {
    logger.error('readiness_check_failed', { requestId: req.id, error });
    res.status(503).json({ status: 'not_ready', database: 'unreachable' });
  }
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Proteksi Laju Permintaan Global & Honeypot
app.use(globalLimiter);
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
app.use(honeypot);

const MySQLStore = require('express-mysql-session')(session);
const sessionStore = new MySQLStore({}, db); // Gunakan pool koneksi MariaDB yang sudah ada

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  session({
    key: 'tdrive_session',
    secret: process.env.SESSION_SECRET || 'tdrive-dev-secret',
    store: sessionStore,
    name: isProduction ? '__Host-tdrive_session' : 'tdrive_session',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: sessionCookieOptions(),
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

// Tolak session perangkat yang sudah dicabut sebelum memuat data akun.
app.use(sessionService.ensureActive);

// Sediakan daftar akun + akun aktif ke semua view terproteksi (jika sudah login)
app.use(activeAccount);
app.use(async (req, res, next) => {
  try {
    res.locals.unreadNotifications = req.activeAccount
      ? await notificationService.unreadCount(req.activeAccount.id, req.session.userPhone)
      : 0;
  } catch (_) {
    res.locals.unreadNotifications = 0;
  }
  next();
});

// Rute berbagi publik (akses terbuka untuk umum, tidak masuk requireLogin)
app.use('/share', shareRouter);

// Halaman legal publik (Privacy Policy & Terms of Service)
app.get('/privacy', (req, res) => {
  res.render('privacy', { title: 'Kebijakan Privasi' });
});
app.get('/tos', (req, res) => {
  res.render('tos', { title: 'Ketentuan Layanan' });
});
app.get('/guide', (req, res) => {
  res.render('guide', { title: 'Panduan Penggunaan' });
});

// REDIRECT BYPASS PUBLIC UNTUK SHORTLINK (TShort)
app.get('/s/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const [rows] = await db.query('SELECT * FROM shortlinks WHERE short_code = ?', [code]);
    const link = rows[0];
    if (!link) {
      return res.status(404).send('Shortlink tidak ditemukan atau telah kadaluwarsa.');
    }

    // Naikkan jumlah klik secara asinkron
    await db.query('UPDATE shortlinks SET clicks = clicks + 1 WHERE id = ?', [link.id]);
    
    // Redirect ke URL asli
    res.redirect(link.original_url);
  } catch (err) {
    res.status(500).send('Terjadi kesalahan pengalihan.');
  }
});

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
app.use('/shortlink', shortlinkRouter);
app.use('/kinerja', kinerjaRouter);
// app.use('/workspace', workspaceRouter);
app.use('/audit-trail-logs', auditLogsRouter);
app.use('/backup', backupRouter);
app.use('/reconciliation', reconciliationRouter);
app.use('/jobs', jobsRouter);
app.use('/notifications', notificationsRouter);
app.use('/search', searchRouter);
app.use('/health', healthRouter);

// 404
app.use((req, res) => res.status(404).send('Halaman tidak ditemukan.'));

// Global error handler: detail internal hanya ditulis ke log server.
app.use((err, req, res, next) => {
  logger.error('unhandled_request_error', { requestId: req.id, error: err });
  if (res.headersSent) return next(err);
  if (err.status === 413 || err.type === 'entity.too.large') {
    return res.status(413).render('error-payload', {
      title: 'Payload Terlalu Besar',
      error: 'Ukuran data request melebihi batas maksimal yang diizinkan.'
    });
  }
  res.status(500).send(`Terjadi kesalahan internal. ID referensi: ${req.id || 'tidak tersedia'}`);
});

// Mulai Database dan Server secara Asinkron
async function start() {
  try {
    // Jalankan migrasi MariaDB
    await db.init();
    backupService.startScheduler(() => jobQueue.enqueue('backup.create', { triggerType: 'scheduled' }));
    await jobQueue.start();
    
    app.listen(PORT, () => {
      console.log(`TDrive berjalan di http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Gagal memulai server:', err);
    process.exit(1);
  }
}

start();
