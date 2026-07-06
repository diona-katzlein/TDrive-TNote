'use strict';

/**
 * Middleware Honeypot untuk menangkap bot pengirim form otomatis.
 * Field input palsu tersembunyi diberi nama 'website'.
 * Jika field ini terisi, asumsikan itu adalah request bot dan tolak request.
 */
function honeypot(fieldName = 'website') {
  return (req, res, next) => {
    // Hanya cek form method POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (req.body && req.body[fieldName] && String(req.body[fieldName]).trim().length > 0) {
        console.warn(`[SECURITY] Honeypot terpicu! IP: ${req.ip || req.socket.remoteAddress}. Field '${fieldName}' terisi: "${req.body[fieldName]}". Request ditolak.`);
        return res.status(400).send('Permintaan tidak valid (Bot detected).');
      }
    }
    next();
  };
}

module.exports = honeypot();
