'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const noteService = require('../services/noteService');
const fileService = require('../services/fileService');
const storageService = require('../services/storageService');
const noteCrypto = require('../services/noteCryptoService');
const auditService = require('../services/auditService');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);

/**
 * Middleware untuk mengecek apakah kunci enkripsi TNote (E2E) telah diset
 * dan dibuka kuncinya pada sesi aktif.
 */
async function requireUnlockedNotes(req, res, next) {
  const account = req.activeAccount;
  if (!account) {
    return res.redirect('/accounts');
  }

  // 1. Jika belum mengatur kata sandi catatan (notes_verifier kosong)
  if (!account.notes_verifier) {
    return res.redirect('/notes/setup');
  }

  // 2. Jika sudah diatur tetapi belum dimasukkan pada sesi aktif
  if (!req.session.notesPassphrase) {
    return res.redirect('/notes/unlock');
  }

  next();
}

/**
 * Sinkron catatan ke Telegram secara terenkripsi (E2E).
 */
async function trySync(account, note, encryptionKey) {
  try {
    // Enkripsi kolom data menggunakan kunci E2E
    const encTitle = noteCrypto.encrypt(note.title, encryptionKey);
    const encBody = noteCrypto.encrypt(note.body, encryptionKey);
    const encCategory = noteCrypto.encrypt(note.category || 'General', encryptionKey);
    
    const payload = JSON.stringify({
      title: encTitle,
      body: encBody,
      category: encCategory,
    });

    const { messageId, peer } = await storageService.syncNote(account, {
      title: 'TNote Encrypted Backup',
      body: payload,
      messageId: note.message_id,
      peerStr: note.peer || null,
    });
    
    await noteService.setNoteSync(note.id, messageId, peer);
    return null;
  } catch (err) {
    await noteService.markUnsynced(note.id);
    return `Catatan tersimpan lokal, tapi gagal sinkron ke Telegram: ${err.message}`;
  }
}

// ----------------------------------------------------
// Rute Pengaturan Sandi (Setup & Unlock)
// ----------------------------------------------------

// Form buat sandi baru
router.get('/setup', (req, res) => {
  const account = req.activeAccount;
  if (account.notes_verifier) {
    return res.redirect('/notes/unlock');
  }
  res.render('notes/setup', { title: 'Atur Sandi TNote', error: null, csrfToken: res.locals.csrfToken });
});

// Proses buat sandi baru
router.post('/setup', async (req, res) => {
  const { password, confirm_password } = req.body;
  try {
    if (!password || !password.trim()) throw new Error('Kata sandi tidak boleh kosong.');
    if (password !== confirm_password) throw new Error('Konfirmasi kata sandi tidak cocok.');

    const account = req.activeAccount;
    if (account.notes_verifier) {
      return res.redirect('/notes/unlock');
    }

    // Buat salt acak (16 byte hex)
    const salt = crypto.randomBytes(16).toString('hex');
    const key = noteCrypto.deriveKey(password, salt);
    
    // Buat verifikator (enkripsi string penanda)
    const verifier = noteCrypto.encrypt('tdrive-verifier', key);

    // Simpan ke akun aktif
    await fileService.updateAccountNotesSecurity(account.id, salt, verifier);
    
    // Perbarui objek activeAccount di request & session
    req.activeAccount.notes_salt = salt;
    req.activeAccount.notes_verifier = verifier;
    req.session.notesPassphrase = key.toString('hex');

    await auditService.log(req, 'SETUP_NOTES_SECURITY', 'Mengaktifkan enkripsi E2E TNote (kata sandi dikonfigurasi).');

    res.redirect('/notes');
  } catch (err) {
    res.render('notes/setup', { title: 'Atur Sandi TNote', error: err.message, csrfToken: res.locals.csrfToken });
  }
});

// Form buka kunci
router.get('/unlock', (req, res) => {
  const account = req.activeAccount;
  if (!account.notes_verifier) {
    return res.redirect('/notes/setup');
  }
  if (req.session.notesPassphrase) {
    return res.redirect('/notes');
  }
  res.render('notes/unlock', { title: 'Buka Kunci TNote', error: null, csrfToken: res.locals.csrfToken });
});

// Proses buka kunci
router.post('/unlock', async (req, res) => {
  const { password } = req.body;
  try {
    const account = req.activeAccount;
    if (!account.notes_verifier) {
      return res.redirect('/notes/setup');
    }

    const key = noteCrypto.deriveKey(password, account.notes_salt);
    const decrypted = noteCrypto.decrypt(account.notes_verifier, key);

    if (decrypted !== 'tdrive-verifier') {
      throw new Error('Kata sandi salah.');
    }

    // Simpan kunci hex ke sesi
    req.session.notesPassphrase = key.toString('hex');
    
    await auditService.log(req, 'UNLOCK_NOTES', 'Sesi TNote berhasil dibuka kunci (decrypted verifier OK).');

    res.redirect('/notes');
  } catch (err) {
    res.render('notes/unlock', { title: 'Buka Kunci TNote', error: err.message, csrfToken: res.locals.csrfToken });
  }
});

// Reset Catatan (jika lupa password)
router.post('/reset', async (req, res) => {
  try {
    const account = req.activeAccount;
    
    // Hapus pesan-pesan catatan di Telegram (best effort)
    try {
      const sqliteNotes = await noteService.listNotes(account.id, Buffer.alloc(32)); // Dummy key
      for (const n of sqliteNotes) {
        if (n.message_id) {
          await storageService.deleteNoteMessage(account, n.message_id).catch(() => {});
        }
      }
    } catch (_) {}

    // Hapus semua link sharing untuk catatan ini
    await db.query(`DELETE FROM shares WHERE item_type = 'note' AND item_id IN (SELECT id FROM notes WHERE account_id = ?)`, [account.id]);

    // Hapus semua catatan lokal untuk akun ini
    await db.query('DELETE FROM notes WHERE account_id = ?', [account.id]);

    // Hapus konfigurasi keamanan E2E pada akun
    await fileService.updateAccountNotesSecurity(account.id, null, null);
    
    // Reset status di request & sesi
    req.activeAccount.notes_salt = null;
    req.activeAccount.notes_verifier = null;
    delete req.session.notesPassphrase;

    await auditService.log(req, 'RESET_NOTES', 'Mereset paksa database TNote (semua catatan dihapus karena lupa sandi).');

    res.redirect('/notes/setup');
  } catch (err) {
    res.status(500).send('Gagal mereset catatan: ' + err.message);
  }
});

// ----------------------------------------------------
// Rute Utama Catatan (Wajib Unlocked)
// ----------------------------------------------------

router.use(requireUnlockedNotes);

// Mendapatkan kunci dari sesi
function getSessionKey(req) {
  return Buffer.from(req.session.notesPassphrase, 'hex');
}

// Daftar catatan (+ pencarian + filter kategori)
router.get('/', async (req, res) => {
  try {
    const accountId = req.activeAccount.id;
    const q = (req.query.q || '').trim();
    const filterCat = req.query.category || null;
    const key = getSessionKey(req);

    let notes = q 
      ? await noteService.searchNotes(accountId, q, key) 
      : await noteService.listNotes(accountId, key);

    // Kumpulkan daftar kategori unik sebelum memfilter list
    const allNotes = await noteService.listNotes(accountId, key);
    const categories = [...new Set(allNotes.map((n) => n.category).filter(Boolean))].sort();

    // Filter berdasarkan kategori jika ada parameter category
    if (filterCat) {
      notes = notes.filter((n) => n.category === filterCat);
    }

    // Hapus share link yang sudah kedaluwarsa secara otomatis
    await db.query(
      `DELETE FROM shares 
       WHERE (expires_at IS NOT NULL AND ? > expires_at) 
          OR (max_views IS NOT NULL AND views_count >= max_views)`,
      [Date.now()]
    );

    // Ambil daftar share aktif khusus tipe catatan untuk akun aktif
    const [shares] = await db.query(
      `SELECT s.uuid, s.item_id 
       FROM shares s 
       INNER JOIN notes n ON s.item_id = n.id
       WHERE s.item_type = 'note' AND n.account_id = ?`,
      [accountId]
    );
    const sharesMap = {};
    for (const s of shares) {
      sharesMap[s.item_id] = s.uuid;
    }

    res.render('notes/list', {
      title: 'TNote',
      notes,
      categories,
      activeCategory: filterCat,
      sharesMap,
      query: q,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat catatan: ' + err.message);
  }
});

// Form catatan baru
router.get('/new', async (req, res) => {
  try {
    const key = getSessionKey(req);
    const notes = await noteService.listNotes(req.activeAccount.id, key);
    const categories = [...new Set(notes.map((n) => n.category).filter(Boolean))].sort();
    
    const [channels] = await db.query(
      'SELECT * FROM user_channels WHERE account_id = ? ORDER BY created_at DESC',
      [req.activeAccount.id]
    );

    res.render('notes/edit', {
      title: 'Catatan Baru',
      note: null,
      categories,
      channels,
      sharesMap: {}, // Catatan baru tidak punya share
      error: null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Buat catatan baru
router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim() || 'Tanpa Judul';
  const body = req.body.body || '';
  const category = (req.body.category || '').trim() || 'General';
  const note_type = req.body.note_type || 'markdown';
  // Kunci otomatis ke storage peer active account
  const storagePeer = req.activeAccount.storage_peer || 'me';
  const key = getSessionKey(req);

  try {
    const note = await noteService.createNote(req.activeAccount.id, { title, body, category, peer: storagePeer, note_type }, key);
    const warn = await trySync(req.activeAccount, note, key);
    
    await auditService.log(req, 'CREATE_NOTE', `Membuat catatan baru: "${title}" (UUID: ${note.uuid})`);

    const suffix = warn ? `?error=${encodeURIComponent(warn)}` : '?notice=' + encodeURIComponent('Catatan berhasil dibuat & disinkron.');
    res.redirect(`/notes${suffix}`);
  } catch (err) {
    res.status(500).send('Gagal membuat catatan: ' + err.message);
  }
});

// Lihat/edit satu catatan (IDOR-safe menggunakan UUID)
router.get('/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const key = getSessionKey(req);
  try {
    const note = await noteService.getNoteByUuid(uuid, key);
    if (!note || note.account_id !== req.activeAccount.id) {
      return res.status(404).send('Catatan tidak ditemukan.');
    }
    
    const notes = await noteService.listNotes(req.activeAccount.id, key);
    const categories = [...new Set(notes.map((n) => n.category).filter(Boolean))].sort();

    // Hapus share link yang sudah kedaluwarsa secara otomatis
    await db.query(
      `DELETE FROM shares 
       WHERE (expires_at IS NOT NULL AND ? > expires_at) 
          OR (max_views IS NOT NULL AND views_count >= max_views)`,
      [Date.now()]
    );

    // Ambil share link jika ada
    const [shares] = await db.query(
      "SELECT uuid FROM shares WHERE item_type = 'note' AND item_id = ?",
      [note.id]
    );
    const sharesMap = {};
    if (shares.length) {
      sharesMap[note.id] = shares[0].uuid;
    }

    const [channels] = await db.query(
      'SELECT * FROM user_channels WHERE account_id = ? ORDER BY created_at DESC',
      [req.activeAccount.id]
    );

    res.render('notes/edit', {
      title: note.title,
      note,
      categories,
      channels,
      sharesMap,
      error: null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat catatan: ' + err.message);
  }
});

// Simpan perubahan catatan (IDOR-safe menggunakan UUID)
router.post('/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const key = getSessionKey(req);
  try {
    const note = await noteService.getNoteByUuid(uuid, key);
    if (!note || note.account_id !== req.activeAccount.id) {
      return res.status(404).send('Catatan tidak ditemukan.');
    }

    const title = (req.body.title || '').trim() || 'Tanpa Judul';
    const body = req.body.body || '';
    const category = (req.body.category || '').trim() || 'General';
    const note_type = req.body.note_type || 'markdown';
    // Kunci otomatis ke storage peer active account
    const storagePeer = req.activeAccount.storage_peer || 'me';

    const oldTitle = note.title;
    await noteService.updateNote(note.id, { title, body, category, peer: storagePeer, note_type }, key);
    
    // Perbarui juga data share publik yang terdekripsi (jika ada active share)
    const [shares] = await db.query("SELECT id FROM shares WHERE item_type = 'note' AND item_id = ?", [note.id]);
    if (shares.length > 0) {
      await db.query(
        "UPDATE shares SET shared_title = ?, shared_body = ?, shared_category = ? WHERE item_type = 'note' AND item_id = ?",
        [title, body, category, note.id]
      );
    }

    const fresh = await noteService.getNote(note.id, key);
    const warn = await trySync(req.activeAccount, fresh, key);
    
    await auditService.log(req, 'UPDATE_NOTE', `Memperbarui catatan "${oldTitle}" menjadi "${title}" (UUID: ${note.uuid})`);

    const suffix = warn ? `?error=${encodeURIComponent(warn)}` : '?notice=' + encodeURIComponent('Catatan disimpan & disinkron.');
    res.redirect(`/notes${suffix}`);
  } catch (err) {
    res.status(500).send('Gagal memperbarui catatan: ' + err.message);
  }
});

// Hapus catatan (metadata + pesan Telegram - IDOR-safe menggunakan UUID)
router.post('/:uuid/delete', async (req, res) => {
  const { uuid } = req.params;
  const key = getSessionKey(req);
  try {
    const note = await noteService.getNoteByUuid(uuid, key);
    if (note && note.account_id === req.activeAccount.id) {
      if (note.message_id) {
        try {
          await storageService.deleteNoteMessage(req.activeAccount, note.message_id, note.peer);
        } catch (_) {
          /* abaikan error remote */
        }
      }
      
      // Hapus share link terkait catatan
      await db.query("DELETE FROM shares WHERE item_type = 'note' AND item_id = ?", [note.id]);
      
      await noteService.deleteNote(note.id);
      
      await auditService.log(req, 'DELETE_NOTE', `Menghapus catatan: "${note.title}" (UUID: ${note.uuid})`);
    }
    res.redirect('/notes');
  } catch (err) {
    res.status(500).send('Gagal menghapus catatan: ' + err.message);
  }
});

module.exports = router;
