'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');
const fileService = require('../services/fileService');
const storageService = require('../services/storageService');
const cryptoService = require('../services/cryptoService');
const auditService = require('../services/auditService');

/**
 * Middleware Autentikasi HTTP Basic untuk WebDAV.
 * Memverifikasi nomor telepon (username) dan sandi/PIN sistem (password).
 */
async function webdavAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="TDrive WebDAV"');
    return res.status(401).send('Unauthorized');
  }

  try {
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('ascii').split(':');
    const phone = credentials[0];
    const password = credentials[1];

    if (!phone || !password) throw new Error('Kredensial tidak lengkap.');

    const account = await fileService.getAccountByPhone(phone);
    if (!account || !account.password_hash) {
      throw new Error('Akun belum terkonfigurasi untuk masuk sandi.');
    }

    const isValid = cryptoService.verifyPassword(password, account.password_hash);
    if (!isValid) throw new Error('Kata sandi salah.');

    // Pasang akun aktif ke request
    req.activeAccount = account;
    next();
  } catch (err) {
    console.warn(`[WEBDAV AUTH] Gagal masuk: ${err.message}`);
    res.setHeader('WWW-Authenticate', 'Basic realm="TDrive WebDAV"');
    return res.status(401).send('Unauthorized');
  }
}

// Gunakan basic auth untuk WebDAV
router.use(webdavAuth);

/**
 * Resolves virtual path string menjadi folder atau file di database
 */
async function resolvePath(accountId, pathStr) {
  const decodedPath = decodeURIComponent(pathStr);
  const parts = decodedPath.split('/').filter(Boolean);
  
  if (parts.length === 0) {
    return { folder: null, file: null, isRoot: true };
  }

  let parentId = null;
  let currentFolder = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;

    // Cek apakah folder
    const [fRows] = await db.query(
      'SELECT * FROM folders WHERE account_id = ? AND parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' AND name = ? AND deleted_at IS NULL',
      parentId ? [accountId, parentId, part] : [accountId, part]
    );

    if (fRows.length > 0) {
      currentFolder = fRows[0];
      parentId = currentFolder.id;
      if (isLast) {
        return { folder: currentFolder, file: null };
      }
    } else {
      // Cek apakah berkas (hanya valid di posisi terakhir)
      if (isLast) {
        const [fileRows] = await db.query(
          'SELECT * FROM files WHERE account_id = ? AND folder_id ' + (parentId ? '= ?' : 'IS NULL') + ' AND name = ? AND deleted_at IS NULL AND parent_file_id IS NULL',
          parentId ? [accountId, parentId, part] : [accountId, part]
        );
        if (fileRows.length > 0) {
          return { folder: null, file: fileRows[0] };
        }
      }
      return { folder: null, file: null, notFound: true };
    }
  }
  return { folder: null, file: null, notFound: true };
}

// 1. OPTIONS method
router.options('/*', (req, res) => {
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
  res.setHeader('DAV', '1, 2');
  res.status(200).end();
});

// 2. PROPFIND method (List file & folder)
router.all('/*', async (req, res, next) => {
  if (req.method !== 'PROPFIND') return next();

  const pathStr = req.path;
  const accountId = req.activeAccount.id;

  try {
    const resolved = await resolvePath(accountId, pathStr);
    if (resolved.notFound) {
      return res.status(404).send('Not Found');
    }

    const items = [];
    
    // Jika request diarahkan ke root folder
    if (resolved.isRoot) {
      items.push({ href: '/webdav/', name: 'Root', isFolder: true, updatedAt: req.activeAccount.created_at });
      
      const folders = await fileService.listFolders(accountId, null);
      for (const f of folders) {
        items.push({ href: `/webdav/${encodeURIComponent(f.name)}/`, name: f.name, isFolder: true, updatedAt: f.created_at });
      }
      
      const files = await fileService.listFiles(accountId, null);
      for (const file of files) {
        items.push({ href: `/webdav/${encodeURIComponent(file.name)}`, name: file.name, isFolder: false, size: file.size, mime: file.mime, updatedAt: file.created_at });
      }
    } 
    // Jika diarahkan ke subfolder
    else if (resolved.folder) {
      const f = resolved.folder;
      items.push({ href: `/webdav${pathStr.endsWith('/') ? pathStr : pathStr + '/'}`, name: f.name, isFolder: true, updatedAt: f.created_at });
      
      const folders = await fileService.listFolders(accountId, f.id);
      for (const sf of folders) {
        items.push({ href: `/webdav${pathStr.endsWith('/') ? pathStr : pathStr + '/'}${encodeURIComponent(sf.name)}/`, name: sf.name, isFolder: true, updatedAt: sf.created_at });
      }
      
      const files = await fileService.listFiles(accountId, f.id);
      for (const file of files) {
        items.push({ href: `/webdav${pathStr.endsWith('/') ? pathStr : pathStr + '/'}${encodeURIComponent(file.name)}`, name: file.name, isFolder: false, size: file.size, mime: file.mime, updatedAt: file.created_at });
      }
    } 
    // Jika diarahkan ke file tunggal
    else if (resolved.file) {
      const file = resolved.file;
      items.push({ href: `/webdav${pathStr}`, name: file.name, isFolder: false, size: file.size, mime: file.mime, updatedAt: file.created_at });
    }

    const xml = renderMultistatus(items);
    res.setHeader('Content-Type', 'application/xml; charset="utf-8"');
    res.status(207).send(xml);
  } catch (err) {
    console.error('[WEBDAV PROPFIND] Error:', err);
    res.status(500).send(err.message);
  }
});

// 3. GET method (Unduh file)
router.get('/*', async (req, res) => {
  const pathStr = req.path;
  const accountId = req.activeAccount.id;

  try {
    const resolved = await resolvePath(accountId, pathStr);
    if (!resolved.file) {
      return res.status(404).send('File Not Found');
    }

    const file = resolved.file;
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);

    await auditService.log(null, 'WEBDAV_DOWNLOAD_FILE', `Mengunduh berkas via WebDAV: ${file.name} (UUID: ${file.uuid})`, req.ip);
    await storageService.downloadToStream(req.activeAccount, file, res);
    res.end();
  } catch (err) {
    console.error('[WEBDAV GET] Error:', err);
    if (!res.headersSent) {
      res.status(500).send(err.message);
    }
  }
});

/**
 * Membangun XML Multistatus WebDAV
 */
function renderMultistatus(hrefs) {
  let xml = '<?xml version="1.0" encoding="utf-8" ?>\n';
  xml += '<d:multistatus xmlns:d="DAV:">\n';
  for (const h of hrefs) {
    xml += '  <d:response>\n';
    xml += `    <d:href>${h.href}</d:href>\n`;
    xml += '    <d:propstat>\n';
    xml += '      <d:prop>\n';
    xml += `        <d:displayname>${escapeXml(h.name)}</d:displayname>\n`;
    if (h.isFolder) {
      xml += '        <d:resourcetype><d:collection/></d:resourcetype>\n';
    } else {
      xml += '        <d:resourcetype/>\n';
      xml += `        <d:getcontentlength>${h.size}</d:getcontentlength>\n`;
      xml += `        <d:getcontenttype>${escapeXml(h.mime || 'application/octet-stream')}</d:getcontenttype>\n`;
    }
    xml += `        <d:getlastmodified>${new Date(h.updatedAt).toUTCString()}</d:getlastmodified>\n`;
    xml += '      </d:prop>\n';
    xml += '      <d:status>HTTP/1.1 200 OK</d:status>\n';
    xml += '    </d:propstat>\n';
    xml += '  </d:response>\n';
  }
  xml += '</d:multistatus>';
  return xml;
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

module.exports = router;
