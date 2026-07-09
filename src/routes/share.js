'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');
const fileService = require('../services/fileService');
const noteService = require('../services/noteService');
const storageService = require('../services/storageService');
const telegramManager = require('../services/telegramManager');
const cryptoService = require('../services/cryptoService');
const auditService = require('../services/auditService');

/**
 * Helper untuk mengecek apakah share sudah kedaluwarsa atau melebihi limit
 */
function isShareActive(share) {
  if (!share) return false;
  if (share.expires_at && Date.now() > Number(share.expires_at)) return false;
  if (share.max_views && Number(share.views_count) >= Number(share.max_views)) return false;
  return true;
}

// ----------------------------------------------------
// PEMBUATAN LINK SHARE (Hanya untuk pengguna login)
// ----------------------------------------------------
router.post('/create', async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).send('Unauthorized');
  }

  const { item_type, item_uuid, password, expires_in_hours, max_views, shared_title, shared_body, shared_category } = req.body;
  const redirectBack = req.body.redirect || '/drive';

  try {
    let itemId = null;
    let titleForAudit = '';

    if (item_type === 'folder') {
      const folder = await fileService.getFolderByUuid(item_uuid);
      if (!folder || folder.account_id !== req.activeAccount.id) throw new Error('Folder tidak ditemukan.');
      itemId = folder.id;
      titleForAudit = folder.name;
    } else if (item_type === 'file') {
      const file = await fileService.getFileByUuid(item_uuid);
      if (!file || file.account_id !== req.activeAccount.id) throw new Error('Berkas tidak ditemukan.');
      itemId = file.id;
      titleForAudit = file.name;
    } else if (item_type === 'note') {
      // Untuk catatan terenkripsi, kita butuh key untuk dekripsi sebelum sharing
      if (!req.session.notesPassphrase) throw new Error('Buka kunci TNote terlebih dahulu sebelum membagikannya.');
      const key = Buffer.from(req.session.notesPassphrase, 'hex');
      const note = await noteService.getNoteByUuid(item_uuid, key);
      if (!note || note.account_id !== req.activeAccount.id) throw new Error('Catatan tidak ditemukan.');
      itemId = note.id;
      titleForAudit = note.title;
    } else {
      throw new Error('Tipe item tidak valid.');
    }

    const shareUuid = require('crypto').randomUUID();
    const expiresAt = expires_in_hours ? Date.now() + (Number(expires_in_hours) * 60 * 60 * 1000) : null;
    const maxViews = max_views ? Number(max_views) : null;
    const passwordHash = password ? cryptoService.hashPassword(password) : null;

    // Simpan ke DB
    await db.query(
      `INSERT INTO shares (uuid, item_type, item_id, password_hash, expires_at, max_views, views_count, shared_title, shared_body, shared_category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        shareUuid,
        item_type,
        itemId,
        passwordHash,
        expiresAt,
        maxViews,
        item_type === 'note' ? shared_title : null,
        item_type === 'note' ? shared_body : null,
        item_type === 'note' ? shared_category : null,
        Date.now(),
      ]
    );

    await auditService.log(req, 'CREATE_SHARE', `Membuat share untuk ${item_type}: ${titleForAudit} (Share UUID: ${shareUuid})`);
    
    let redirectUrl = redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('Tautan berbagi publik berhasil dibuat!');
    if (password) {
      redirectUrl += '&created_share_uuid=' + shareUuid + '&created_pass=' + encodeURIComponent(password) + '&created_name=' + encodeURIComponent(titleForAudit);
    }
    
    res.redirect(redirectUrl);
  } catch (err) {
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message));
  }
});

// Penarikan (Penghapusan) Share Link
router.post('/:uuid/revoke', async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).send('Unauthorized');
  }

  const { uuid } = req.params;
  const redirectBack = req.body.redirect || '/drive';

  try {
    // Cari detail share untuk logging
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (share) {
      await db.query('DELETE FROM shares WHERE uuid = ?', [uuid]);
      await auditService.log(req, 'REVOKE_SHARE', `Menarik kembali (menghapus) share UUID: ${uuid}`);
    }
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('Tautan berbagi telah dinonaktifkan.'));
  } catch (err) {
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message));
  }
});

// ----------------------------------------------------
// TAMPILAN PUBLIK & AKSES LINK SHARE
// ----------------------------------------------------

// Form Verifikasi Sandi Share
router.get('/:uuid/unlock', async (req, res) => {
  const { uuid } = req.params;
  const { pass } = req.query;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share)) {
      return res.status(404).send('Tautan berbagi tidak ditemukan atau sudah kedaluwarsa.');
    }

    // Coba bypass otomatis via parameter '?pass='
    if (pass && share.password_hash) {
      try {
        const base32 = require('base32');
        const plainPassword = base32.decode(pass).toString('utf8').trim();
        if (plainPassword && cryptoService.verifyPassword(plainPassword, share.password_hash)) {
          req.session.unlockedShares = req.session.unlockedShares || {};
          req.session.unlockedShares[uuid] = true;
          return res.redirect(`/share/${uuid}`);
        }
      } catch (_) {}
    }

    res.render('shares/password', { title: 'Verifikasi Sandi Berbagi', uuid, error: null, csrfToken: res.locals.csrfToken });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan.');
  }
});

// Proses Verifikasi Sandi Share
router.post('/:uuid/unlock', async (req, res) => {
  const { uuid } = req.params;
  const { password } = req.body;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share)) {
      return res.status(404).send('Tautan berbagi tidak ditemukan atau sudah kedaluwarsa.');
    }

    const isValid = cryptoService.verifyPassword(password, share.password_hash);
    if (!isValid) {
      return res.render('shares/password', { title: 'Verifikasi Sandi Berbagi', uuid, error: 'Sandi salah, silakan coba lagi.', csrfToken: res.locals.csrfToken });
    }

    // Set kunci di session
    req.session.unlockedShares = req.session.unlockedShares || {};
    req.session.unlockedShares[uuid] = true;
    res.redirect(`/share/${uuid}`);
  } catch (err) {
    res.status(500).send('Gagal verifikasi.');
  }
});

// Landing Page Share Utama
router.get('/:uuid', async (req, res) => {
  const { uuid } = req.params;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share)) {
      return res.status(404).render('shares/password', { title: 'Error', uuid: null, error: 'Tautan berbagi tidak ditemukan, sudah kedaluwarsa, atau batas tayang terlampaui.', csrfToken: null });
    }

    // Proteksi sandi
    if (share.password_hash) {
      // Coba verifikasi otomatis via query parameter '?pass=' (Base32 encoded)
      if (req.query.pass) {
        try {
          const base32 = require('base32');
          const plainPassword = base32.decode(req.query.pass).toString('utf8').trim();
          if (plainPassword && cryptoService.verifyPassword(plainPassword, share.password_hash)) {
            req.session.unlockedShares = req.session.unlockedShares || {};
            req.session.unlockedShares[uuid] = true;
          }
        } catch (_) {}
      }

      const unlocked = req.session.unlockedShares && req.session.unlockedShares[uuid];
      if (!unlocked) {
        return res.redirect(`/share/${uuid}/unlock` + (req.query.pass ? `?pass=${req.query.pass}` : ''));
      }
    }

    // Naikkan view count
    await db.query('UPDATE shares SET views_count = views_count + 1 WHERE id = ?', [share.id]);
    share.views_count += 1;

    // Log aksi publik
    await auditService.log(req, 'ACCESS_SHARE', `Mengakses share publik UUID: ${uuid} (Tipe: ${share.item_type})`);

    // Render berdasarkan tipe
    if (share.item_type === 'note') {
      return res.render('shares/note', {
        title: share.shared_title,
        note: {
          title: share.shared_title,
          body: share.shared_body,
          category: share.shared_category,
          updated_at: share.created_at,
        }
      });
    }

    if (share.item_type === 'file') {
      const file = await fileService.getFile(share.item_id);
      if (!file) return res.status(404).send('File asal sudah dihapus.');
      return res.render('shares/file', {
        title: file.name,
        file,
        uuid,
      });
    }

    if (share.item_type === 'folder') {
      const folder = await fileService.getFolder(share.item_id);
      if (!folder) return res.status(404).send('Folder asal sudah dihapus.');
      
      // Ambil isi folder tersebut
      const [subfolders] = await db.query('SELECT * FROM folders WHERE parent_id = ?', [folder.id]);
      const [files] = await db.query('SELECT * FROM files WHERE folder_id = ?', [folder.id]);

      return res.render('shares/folder', {
        title: folder.name,
        folder,
        subfolders,
        files,
        uuid,
        currentSubfolder: null,
        parentFolderUuid: null,
      });
    }

    res.status(400).send('Tipe tidak dikenal.');
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Download Shared File Utama
router.get('/:uuid/download', async (req, res) => {
  const { uuid } = req.params;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share) || share.item_type !== 'file') {
      return res.status(404).send('File tidak ditemukan atau kedaluwarsa.');
    }

    if (share.password_hash) {
      const unlocked = req.session.unlockedShares && req.session.unlockedShares[uuid];
      if (!unlocked) return res.status(403).send('Akses ditolak (butuh sandi).');
    }

    const file = await fileService.getFile(share.item_id);
    if (!file) return res.status(404).send('File sudah tidak ada.');

    const account = await fileService.getAccount(file.account_id);
    if (!account) return res.status(404).send('Akun storage sudah tidak valid.');

    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);

    await auditService.log(req, 'DOWNLOAD_SHARE_FILE', `Mengunduh berkas publik: ${file.name} (Share: ${uuid})`);
    await storageService.downloadToStream(account, file, res);
    res.end();
  } catch (err) {
    res.status(500).send('Gagal mengunduh: ' + err.message);
  }
});

// Preview/Stream Shared File Utama (Mendukung in-browser media player)
router.get('/:uuid/preview', async (req, res) => {
  const { uuid } = req.params;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share) || share.item_type !== 'file') {
      return res.status(404).send('Berkas tidak ditemukan atau kedaluwarsa.');
    }

    if (share.password_hash) {
      const unlocked = req.session.unlockedShares && req.session.unlockedShares[uuid];
      if (!unlocked) return res.status(403).send('Akses ditolak (butuh sandi).');
    }

    const file = await fileService.getFile(share.item_id);
    if (!file) return res.status(404).send('Berkas sudah tidak ada.');

    const account = await fileService.getAccount(file.account_id);
    if (!account) return res.status(404).send('Akun storage sudah tidak valid.');

    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);

    await auditService.log(req, 'PREVIEW_SHARE_FILE', `Pratinjau berkas publik: ${file.name} (Share: ${uuid})`);
    await storageService.downloadToStream(account, file, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).send('Gagal pratinjau: ' + err.message);
    } else {
      res.destroy(err);
    }
  }
});

// Konversi DOCX ke HTML lokal menggunakan Mammoth.js
router.get('/:uuid/docx-preview', async (req, res) => {
  const { uuid } = req.params;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share) || share.item_type !== 'file') {
      return res.status(404).send('Berkas tidak ditemukan atau kedaluwarsa.');
    }

    if (share.password_hash) {
      const unlocked = req.session.unlockedShares && req.session.unlockedShares[uuid];
      if (!unlocked) return res.status(403).send('Akses ditolak (butuh sandi).');
    }

    const file = await fileService.getFile(share.item_id);
    if (!file) return res.status(404).send('Berkas sudah tidak ada.');

    const account = await fileService.getAccount(file.account_id);
    if (!account) return res.status(404).send('Akun storage sudah tidak valid.');

    // Download file ke memori buffer secara streaming
    const chunks = [];
    const stream = new (require('stream').Writable)({
      write(chunk, encoding, next) {
        chunks.push(chunk);
        next();
      }
    });

    await storageService.downloadToStream(account, file, stream);
    const fileBuffer = Buffer.concat(chunks);

    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ buffer: fileBuffer });
    
    // Kirim HTML bersih
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
      <div class="docx-preview-body" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; padding: 20px; background: #fff; border-radius: 4px; overflow-y: auto; max-height: 70vh;">
        ${result.value}
      </div>
    `);
  } catch (err) {
    res.status(500).send('<p style="color: red; padding: 20px;">Gagal memproses pratinjau Word: ' + err.message + '</p>');
  }
});

// Navigasi Subfolder Publik di dalam Shared Folder
router.get('/:share_uuid/folder/:folder_uuid', async (req, res) => {
  const { share_uuid, folder_uuid } = req.params;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [share_uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share) || share.item_type !== 'folder') {
      return res.status(404).send('Folder tidak ditemukan atau kedaluwarsa.');
    }

    if (share.password_hash) {
      const unlocked = req.session.unlockedShares && req.session.unlockedShares[share_uuid];
      if (!unlocked) return res.redirect(`/share/${share_uuid}/unlock`);
    }

    const rootFolder = await fileService.getFolder(share.item_id);
    const subfolder = await fileService.getFolderByUuid(folder_uuid);
    
    if (!rootFolder || !subfolder) {
      return res.status(404).send('Folder tidak ditemukan.');
    }

    // Validasi: Pastikan subfolder ini bernaung di bawah rootFolder yang di-share
    // Kita cek secara rekursif ke atas
    let current = subfolder;
    let isChild = false;
    while (current) {
      if (current.id === rootFolder.id) {
        isChild = true;
        break;
      }
      if (!current.parent_id) break;
      current = await fileService.getFolder(current.parent_id);
    }

    if (!isChild) {
      return res.status(403).send('Akses dilarang (bukan bagian dari folder bersama).');
    }

    // Ambil isi subfolder
    const [subfolders] = await db.query('SELECT * FROM folders WHERE parent_id = ?', [subfolder.id]);
    const [files] = await db.query('SELECT * FROM files WHERE folder_id = ?', [subfolder.id]);

    let parentFolderUuid = null;
    if (subfolder.parent_id && subfolder.parent_id !== rootFolder.id) {
      const parent = await fileService.getFolder(subfolder.parent_id);
      if (parent) parentFolderUuid = parent.uuid;
    }

    res.render('shares/folder', {
      title: subfolder.name,
      folder: rootFolder,
      subfolders,
      files,
      uuid: share_uuid,
      currentSubfolder: subfolder,
      parentFolderUuid,
    });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Download File Publik di dalam Shared Folder
router.get('/:share_uuid/file/:file_uuid/download', async (req, res) => {
  const { share_uuid, file_uuid } = req.params;
  try {
    const [shares] = await db.query('SELECT * FROM shares WHERE uuid = ?', [share_uuid]);
    const share = shares[0];
    if (!share || !isShareActive(share) || share.item_type !== 'folder') {
      return res.status(404).send('Folder tidak ditemukan atau kedaluwarsa.');
    }

    if (share.password_hash) {
      const unlocked = req.session.unlockedShares && req.session.unlockedShares[share_uuid];
      if (!unlocked) return res.status(403).send('Akses ditolak (butuh sandi).');
    }

    const rootFolder = await fileService.getFolder(share.item_id);
    const file = await fileService.getFileByUuid(file_uuid);
    if (!rootFolder || !file) return res.status(404).send('Berkas tidak ditemukan.');

    // Validasi: Pastikan berkas ini bernaung di bawah rootFolder yang di-share
    let belongs = false;
    if (file.folder_id) {
      let current = await fileService.getFolder(file.folder_id);
      while (current) {
        if (current.id === rootFolder.id) {
          belongs = true;
          break;
        }
        if (!current.parent_id) break;
        current = await fileService.getFolder(current.parent_id);
      }
    }

    if (!belongs) {
      return res.status(403).send('Akses dilarang (bukan bagian dari folder bersama).');
    }

    const account = await fileService.getAccount(file.account_id);
    if (!account) return res.status(404).send('Akun storage tidak valid.');

    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);

    await auditService.log(req, 'DOWNLOAD_SHARE_FILE', `Mengunduh berkas publik di dalam folder: ${file.name} (Share: ${share_uuid})`);
    await storageService.downloadToStream(account, file, res);
    res.end();
  } catch (err) {
    res.status(500).send('Gagal mengunduh: ' + err.message);
  }
});

module.exports = router;
