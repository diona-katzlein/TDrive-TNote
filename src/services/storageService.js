'use strict';

const fs = require('fs');
const crypto = require('crypto');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { CustomFile } = require('telegram/client/uploads');
const telegramManager = require('./telegramManager');
const fileService = require('./fileService');

/**
 * storageService — jembatan antara metadata (SQLite) dan byte file (Telegram).
 *
 * - Storage per akun = sebuah channel privat "TDrive Storage" (fallback: 'me').
 * - File besar dipecah menjadi beberapa chunk (satu chunk = satu pesan/dokumen).
 * - Upload membaca file dari disk (streaming, hemat memori).
 * - Download melakukan reassembly chunk berurutan langsung ke response (streaming).
 */

// Ukuran maksimum satu chunk. Harus < 2 GB (batas Telegram non-premium ~1.95 GB).
const CHUNK_SIZE = (Number(process.env.TDRIVE_CHUNK_MB) || 1900) * 1024 * 1024;
const DL_REQUEST_SIZE = 512 * 1024; // ukuran part unduhan (512 KB)

// ---------- Peer resolution ----------

/**
 * Kembalikan target peer untuk operasi Telegram: 'me' (Saved Messages) atau
 * InputPeerChannel yang direkonstruksi dari storage_peer (JSON channelId+accessHash).
 */
function resolvePeer(account) {
  if (!account.storage_peer || account.storage_peer === 'me') return 'me';
  let obj;
  try {
    obj = JSON.parse(account.storage_peer);
  } catch (_) {
    return 'me';
  }
  if (!obj || !obj.channelId) return 'me';
  return new Api.InputPeerChannel({
    channelId: bigInt(String(obj.channelId)),
    accessHash: bigInt(String(obj.accessHash || '0')),
  });
}

/**
 * Buat channel privat sebagai kontainer storage. Dipanggil sekali saat akun dibuat.
 * @returns {Promise<{channelId:string, accessHash:string}>}
 */
async function createStorageChannel(client, title = 'TDrive Storage') {
  const result = await client.invoke(
    new Api.channels.CreateChannel({
      title,
      about: 'Storage terkelola oleh TDrive. Jangan hapus channel ini.',
      broadcast: true, // channel siaran (bukan grup)
      megagroup: false,
    })
  );
  const chat = result.chats[0];
  return {
    channelId: chat.id.toString(),
    accessHash: chat.accessHash ? chat.accessHash.toString() : '0',
  };
}

// ---------- Helpers disk ----------

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(path);
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

// Salin slice [start, end) dari srcPath ke destPath tanpa memuat seluruhnya ke memori.
function writeSlice(srcPath, start, end, destPath) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(srcPath, { start, end: end - 1 }); // end inklusif di fs
    const ws = fs.createWriteStream(destPath);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

// ---------- Upload ----------

/**
 * Upload file dari path temp ke Telegram (chunking bila > CHUNK_SIZE) lalu simpan
 * metadata + mapping ke SQLite.
 * @param {object} account
 * @param {object} opts { tempPath, filename, mime, size, folderId }
 */
async function uploadFile(account, { tempPath, filename, mime, size, folderId }) {
  const client = await telegramManager.getClient(account);
  const peer = resolvePeer(account);
  const peerStr = account.storage_peer || 'me';

  const actualSize = size != null ? Number(size) : fs.statSync(tempPath).size;
  const sha256 = await hashFile(tempPath);

  const chunks = [];

  if (actualSize <= CHUNK_SIZE) {
    // Satu pesan
    const message = await telegramManager.withFloodRetry(
      () =>
        client.sendFile(peer, {
          file: new CustomFile(filename, actualSize, tempPath),
          forceDocument: true,
          caption: filename,
        }),
      { label: `upload ${filename}` }
    );
    chunks.push({ partIndex: 0, messageId: Number(message.id), peer: peerStr, size: actualSize });
  } else {
    // Multi-chunk
    const total = Math.ceil(actualSize / CHUNK_SIZE);
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, actualSize);
      const partSize = end - start;
      const partPath = `${tempPath}.part${i}`;
      await writeSlice(tempPath, start, end, partPath);
      try {
        const partName = `${filename}.part${String(i).padStart(3, '0')}`;
        const message = await telegramManager.withFloodRetry(
          () =>
            client.sendFile(peer, {
              file: new CustomFile(partName, partSize, partPath),
              forceDocument: true,
              caption: `${filename} [${i + 1}/${total}]`,
            }),
          { label: `upload ${partName}` }
        );
        chunks.push({
          partIndex: i,
          messageId: Number(message.id),
          peer: peerStr,
          size: partSize,
        });
      } finally {
        await fs.promises.unlink(partPath).catch(() => {});
      }
    }
  }

  return fileService.createFileWithChunks(
    {
      accountId: account.id,
      folderId: folderId || null,
      name: filename,
      size: actualSize,
      mime: mime || 'application/octet-stream',
      sha256,
      isChunked: actualSize > CHUNK_SIZE ? 1 : 0,
    },
    chunks
  );
}

// ---------- Download (streaming) ----------

/**
 * Reassembly chunk berurutan langsung ke writable stream (mis. response HTTP),
 * dengan penanganan backpressure. Tidak memuat seluruh file ke memori.
 * @param {object} account
 * @param {object} file
 * @param {import('stream').Writable} writable
 */
async function downloadToStream(account, file, writable) {
  const client = await telegramManager.getClient(account);
  const peer = resolvePeer(account);
  const chunks = fileService.getFileChunks(file.id);

  for (const chunk of chunks) {
    const messages = await telegramManager.withFloodRetry(
      () => client.getMessages(peer, { ids: [chunk.message_id] }),
      { label: `download msg ${chunk.message_id}` }
    );
    const msg = messages && messages[0];
    if (!msg || !msg.media) {
      throw new Error(
        `Pesan chunk hilang (message_id=${chunk.message_id}). File mungkin terhapus di Telegram.`
      );
    }
    for await (const buf of client.iterDownload({ file: msg.media, requestSize: DL_REQUEST_SIZE })) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (!writable.write(b)) {
        await new Promise((resolve) => writable.once('drain', resolve));
      }
    }
  }
}

// ---------- Integrity verification (FR-19) ----------

/**
 * Unduh ulang seluruh chunk file dan hitung SHA-256 tanpa menyimpan ke disk/memori
 * penuh (streaming per-chunk ke hasher), lalu bandingkan dengan sha256 tersimpan.
 * @param {object} account
 * @param {object} file
 * @returns {Promise<{ok:boolean, expected:string|null, actual:string, size:number}>}
 */
async function verifyIntegrity(account, file) {
  const client = await telegramManager.getClient(account);
  const peer = resolvePeer(account);
  const chunks = fileService.getFileChunks(file.id);

  const h = crypto.createHash('sha256');
  let total = 0;

  for (const chunk of chunks) {
    const messages = await telegramManager.withFloodRetry(
      () => client.getMessages(peer, { ids: [chunk.message_id] }),
      { label: `verify msg ${chunk.message_id}` }
    );
    const msg = messages && messages[0];
    if (!msg || !msg.media) {
      throw new Error(
        `Pesan chunk hilang (message_id=${chunk.message_id}). File tidak dapat diverifikasi.`
      );
    }
    for await (const buf of client.iterDownload({ file: msg.media, requestSize: DL_REQUEST_SIZE })) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      h.update(b);
      total += b.length;
    }
  }

  const actual = h.digest('hex');
  const expected = file.sha256 || null;
  return {
    ok: expected ? actual === expected && total === Number(file.size) : true,
    expected,
    actual,
    size: total,
  };
}

// ---------- Delete ----------

async function deleteRemote(account, file) {
  const client = await telegramManager.getClient(account);
  const peer = resolvePeer(account);
  const chunks = fileService.getFileChunks(file.id);
  const ids = chunks.map((c) => c.message_id);
  if (ids.length) {
    try {
      await telegramManager.withFloodRetry(
        () => client.deleteMessages(peer, ids, { revoke: true }),
        { label: `delete ${file.name}` }
      );
    } catch (_) {
      /* abaikan bila sudah tidak ada */
    }
  }
}

module.exports = {
  resolvePeer,
  createStorageChannel,
  uploadFile,
  downloadToStream,
  verifyIntegrity,
  deleteRemote,
  CHUNK_SIZE,
};
