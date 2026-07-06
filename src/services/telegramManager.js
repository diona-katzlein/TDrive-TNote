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

/**
 * Kredensial Telegram app bersama (shared) dari environment.
 * Dipakai agar pengguna cukup memasukkan nomor telepon saat login.
 * @returns {{apiId:number, apiHash:string}}
 */
function envCredentials() {
  const apiId = Number(process.env.TDRIVE_API_ID);
  const apiHash = process.env.TDRIVE_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error(
      'TDRIVE_API_ID / TDRIVE_API_HASH belum diset di .env. ' +
        'Admin perlu membuat app di my.telegram.org lalu mengisinya.'
    );
  }
  return { apiId, apiHash: String(apiHash) };
}

/**
 * RSA Public Key untuk Telegram Test DC (dimuat dari env secara aman).
 */
const TEST_DC_PUBLIC_KEY = process.env.TDRIVE_TEST_DC_PUBLIC_KEY
  ? process.env.TDRIVE_TEST_DC_PUBLIC_KEY.replace(/\\n/g, '\n')
  : `-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEAyMEdY1aR+sCR3ZSJrtztKTKqigvO/vBfqACJLZtS7QMgCGXJ6XIR
yy7mx66W0/sOFa7/1mAZtEoIokDP3ShoqF4fVNb6XeqgQfaUHd8wJpDWHcR2OFwv
plUUI1PLTktZ9uW2WE23b+ixNwJjJGwBDJPQEQFBE+vfmH0JP503wr5INS1poWg/
j25sIWeYPHYeOrFp/eXaqhISP6G+q2IeTaWTXpwZj4LzXq5YOpk4bYEQ6mvRq7D1
aHWfYmlEGepfaYR8Q0YqvvhYtMte3ITnuSJs171+GDqpdKcSwHnd6FudwGO4pcCO
j4WcDuXc2CTHgH8gFTNhp/Y8/SpDOhvn9QIDAQAB
-----END RSA PUBLIC KEY-----`;

/**
 * Apakah mode Test DC aktif.
 * Aktifkan via env TDRIVE_USE_TEST_DC=true
 */
function isTestDc() {
  return process.env.TDRIVE_USE_TEST_DC === 'true';
}

function buildClient(apiId, apiHash, sessionStr = '') {
  const useTest = isTestDc();
  const useCustomProd = process.env.TDRIVE_USE_CUSTOM_PROD === 'true';

  const client = new TelegramClient(new StringSession(sessionStr), Number(apiId), String(apiHash), {
    connectionRetries: 10,
    requestRetries: 5,
    timeout: 60000, // 60s request timeout
    autoReconnect: true,
    testServers: useTest,
  });

  // Jika mode test DC aktif, atur DC secara manual ke 149.154.167.40:443 (DC 2 Test)
  if (useTest && !sessionStr) {
    client.session.setDC(2, '149.154.167.40', 443);
    console.log('[Telegram] Menggunakan Test DC: 149.154.167.40:443');
  } else if (useCustomProd && !useTest && !sessionStr) {
    // Kustom Production DC via Env
    const ip = process.env.TDRIVE_CUSTOM_PROD_IP || '149.154.167.50';
    const port = Number(process.env.TDRIVE_CUSTOM_PROD_PORT || 443);
    client.session.setDC(2, ip, port);
    
    // Inject public key baru jika didefinisikan di env
    if (process.env.TDRIVE_CUSTOM_PROD_PUBLIC_KEY) {
      try {
        const formattedKey = process.env.TDRIVE_CUSTOM_PROD_PUBLIC_KEY.replace(/\\n/g, '\n');
        // Masukkan key kustom jika diperlukan oleh library (GramJS mengambil key otomatis dari server,
        // namun untuk manual connection kita catat log inisialisasi DC ini)
        console.log(`[Telegram] Menggunakan Custom Production DC: ${ip}:${port}`);
      } catch (err) {
        console.error('[Telegram] Gagal memproses Custom Production Public Key:', err.message);
      }
    }
  }

  return client;
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
  // Bila api_id/api_hash tidak diberikan (login phone-only), pakai kredensial env bersama.
  const creds = apiId && apiHash ? { apiId: Number(apiId), apiHash: String(apiHash) } : envCredentials();

  const client = buildClient(creds.apiId, creds.apiHash, '');
  await client.connect();

  const { phoneCodeHash } = await client.sendCode(
    { apiId: creds.apiId, apiHash: creds.apiHash },
    phone
  );

  const loginId = crypto.randomBytes(16).toString('hex');
  pendingLogins.set(loginId, {
    client,
    phone,
    phoneCodeHash,
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    label,
  });
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
  envCredentials,
  startLogin,
  completeLogin,
  registerClient,
  dropClient,
  cancelLogin,
  isTestDc,
  TEST_DC_PUBLIC_KEY,
};
