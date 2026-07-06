'use strict';

const crypto = require('crypto');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { decrypt } = require('./cryptoService');

/**
 * telegramManager
 * - Mengelola pool koneksi TelegramClient per akun (persistent).
 * - Mengelola alur login dua langkah (sendCode lalu signIn) yang butuh
 *   mempertahankan instance client di antara dua request HTTP.
 */

// accountId -> TelegramClient (koneksi hidup, dipakai ulang antar request)
const clients = new Map();

// loginId (string acak) -> { client, phone, phoneCodeHash, apiId, apiHash, label }
const pendingLogins = new Map();

function buildClient(apiId, apiHash, sessionStr = '') {
  return new TelegramClient(new StringSession(sessionStr), Number(apiId), String(apiHash), {
    connectionRetries: 5,
  });
}

/**
 * Ambil (atau buat) client tersambung untuk akun dari StringSession tersimpan.
 * Bila client ada di pool namun koneksinya putus, sambungkan ulang otomatis.
 * @param {object} account row dari tabel accounts
 */
async function getClient(account) {
  if (clients.has(account.id)) {
    const existing = clients.get(account.id);
    if (!existing.connected) {
      // Reconnect dari sesi yang sama tanpa OTP ulang (§12 keandalan).
      await existing.connect().catch(() => {});
    }
    return existing;
  }

  const sessionStr = decrypt(account.session_enc, account.session_iv, account.session_tag);
  const client = buildClient(account.api_id, account.api_hash, sessionStr);
  await client.connect(); // pakai sesi tersimpan — tanpa OTP ulang
  clients.set(account.id, client);
  return client;
}

/** Jeda sederhana (ms). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jalankan operasi Telegram dengan penanganan FloodWait & error jaringan (§12).
 * - FloodWaitError → tunggu `err.seconds` (+buffer) lalu coba lagi.
 * - Error jaringan sementara (disconnect/timeout) → backoff eksponensial.
 * @param {() => Promise<any>} fn operasi yang mengembalikan Promise
 * @param {object} [opts] { retries, label }
 */
async function withFloodRetry(fn, opts = {}) {
  const retries = opts.retries != null ? opts.retries : 4;
  const label = opts.label || 'telegram-op';
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err && (err.errorMessage || err.message)) || '';
      const seconds = err && (err.seconds != null ? err.seconds : undefined);
      const isFlood = seconds != null || /FLOOD_WAIT/i.test(msg);
      const isTransient =
        /TIMEOUT|disconnect|not connected|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(msg);

      if (isFlood) {
        const waitMs = (Number(seconds) || 5) * 1000 + 1000; // +1s buffer
        console.warn(`[${label}] FloodWait ${seconds}s — menunggu lalu retry...`);
        await sleep(waitMs);
        continue; // FloodWait tidak menghabiskan jatah retry biasa
      }

      if (isTransient && attempt < retries) {
        attempt++;
        const backoff = Math.min(1000 * 2 ** attempt, 15000);
        console.warn(`[${label}] error sementara (${msg}) — retry ${attempt}/${retries} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }
}

/**
 * Langkah 1 login: kirim kode OTP ke nomor telepon.
 * @returns {Promise<{loginId:string}>}
 */
async function startLogin({ apiId, apiHash, phone, label }) {
  const client = buildClient(apiId, apiHash, '');
  await client.connect();

  const { phoneCodeHash } = await client.sendCode(
    { apiId: Number(apiId), apiHash: String(apiHash) },
    phone
  );

  const loginId = crypto.randomBytes(16).toString('hex');
  pendingLogins.set(loginId, { client, phone, phoneCodeHash, apiId, apiHash, label });
  return { loginId };
}

/**
 * Langkah 2 login: verifikasi OTP (dan password 2FA bila diperlukan).
 * @returns {Promise<object>} { sessionStr, phone, apiId, apiHash, label, client } atau { needPassword:true }
 */
async function completeLogin(loginId, code, password) {
  const pending = pendingLogins.get(loginId);
  if (!pending) throw new Error('Sesi login kedaluwarsa. Silakan mulai ulang.');

  const { client, phone, phoneCodeHash, apiId, apiHash, label } = pending;

  try {
    await client.invoke(
      new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code })
    );
  } catch (err) {
    const msg = (err && (err.errorMessage || err.message)) || '';
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      if (!password) {
        // Minta password 2FA ke pengguna dulu (jangan hapus pending).
        return { needPassword: true };
      }
      // Selesaikan dengan password 2FA (SRP ditangani helper GramJS).
      await client.signInWithPassword(
        { apiId: Number(apiId), apiHash: String(apiHash) },
        {
          password: async () => password,
          onError: (e) => {
            throw e;
          },
        }
      );
    } else {
      throw err;
    }
  }

  const sessionStr = client.session.save();
  pendingLogins.delete(loginId);

  return { sessionStr, phone, apiId, apiHash, label, client };
}

/**
 * Daftarkan client yang sudah login ke pool dengan accountId final.
 */
function registerClient(accountId, client) {
  clients.set(accountId, client);
}

/**
 * Putuskan & buang client dari pool (mis. saat akun dihapus).
 */
async function dropClient(accountId) {
  const client = clients.get(accountId);
  if (client) {
    try {
      await client.disconnect();
    } catch (_) {
      /* abaikan */
    }
    clients.delete(accountId);
  }
}

/** Buang pending login yang dibatalkan. */
async function cancelLogin(loginId) {
  const pending = pendingLogins.get(loginId);
  if (pending) {
    try {
      await pending.client.disconnect();
    } catch (_) {
      /* abaikan */
    }
    pendingLogins.delete(loginId);
  }
}

module.exports = {
  getClient,
  withFloodRetry,
  startLogin,
  completeLogin,
  registerClient,
  dropClient,
  cancelLogin,
};
