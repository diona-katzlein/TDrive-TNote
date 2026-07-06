'use strict';

// Map untuk melacak request: IP -> Array [timestamp]
const globalStore = new Map();
const authStore = new Map();

/**
 * Pembersih in-memory store berkala (setiap 5 menit) untuk membuang IP yang sudah tidak aktif
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of globalStore.entries()) {
    const valid = timestamps.filter(t => now - t < 60000);
    if (valid.length === 0) globalStore.delete(ip);
    else globalStore.set(ip, valid);
  }
  for (const [ip, timestamps] of authStore.entries()) {
    const valid = timestamps.filter(t => now - t < 60000);
    if (valid.length === 0) authStore.delete(ip);
    else authStore.set(ip, valid);
  }
}, 5 * 60 * 1000);

/**
 * Helper mendapatkan IP klien dengan aman
 */
function getClientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Middleware Rate Limiter Global
 * Batasan default: 150 request per 1 menit per IP
 */
function globalLimiter(limit = 150, windowMs = 60000) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();

    if (!globalStore.has(ip)) {
      globalStore.set(ip, []);
    }

    let timestamps = globalStore.get(ip);
    // Filter hanya request yang terjadi dalam jendela waktu saat ini
    timestamps = timestamps.filter(t => now - t < windowMs);

    if (timestamps.length >= limit) {
      return res.status(429).send('Terlalu banyak permintaan (Rate limit exceeded). Silakan tunggu satu menit lalu coba lagi.');
    }

    timestamps.push(now);
    globalStore.set(ip, timestamps);
    next();
  };
}

/**
 * Middleware Rate Limiter khusus Autentikasi (mencegah brute force OTP/sandi)
 * Batasan default: 5 request per 1 menit per IP (bisa diatur via .env TDRIVE_AUTH_LIMIT)
 */
function authLimiter(limit = Number(process.env.TDRIVE_AUTH_LIMIT || 15), windowMs = 60000) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();

    if (!authStore.has(ip)) {
      authStore.set(ip, []);
    }

    let timestamps = authStore.get(ip);
    timestamps = timestamps.filter(t => now - t < windowMs);

    if (timestamps.length >= limit) {
      // Return 429 response
      return res.status(429).render('auth/login', {
        title: 'Login',
        error: 'Terlalu banyak mencoba login. Silakan tunggu beberapa saat (1 menit) sebelum mencoba lagi.',
      });
    }

    timestamps.push(now);
    authStore.set(ip, timestamps);
    next();
  };
}

module.exports = {
  globalLimiter: globalLimiter(),
  authLimiter: authLimiter(),
};
