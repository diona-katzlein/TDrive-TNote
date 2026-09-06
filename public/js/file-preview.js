'use strict';
(() => {
  const dialog = document.getElementById('tdrivePreview');
  if (!dialog) return;
  const body = document.getElementById('tdrivePreviewBody');
  const status = document.getElementById('tdrivePreviewStatus');
  let controller;
  let blobUrl;
  let generation = 0;
  function cleanup() {
    generation++;
    if (controller) controller.abort();
    body.querySelectorAll('audio,video').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
    body.replaceChildren();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
  dialog.addEventListener('close', cleanup);
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-file-preview]');
    if (!button) return;
    cleanup();
    const current = generation;
    controller = new AbortController();
    document.getElementById('tdrivePreviewTitle').textContent = button.dataset.name || 'Pratinjau berkas';
    document.getElementById('tdrivePreviewCaption').textContent = button.dataset.caption || '';
    const url = new URL(button.dataset.filePreview, location.origin);
    if (url.origin !== location.origin) return;
    document.getElementById('tdrivePreviewDownload').href = url.pathname.replace(/\/preview$/, '/download');
    status.textContent = 'Memuat pratinjau… Konversi Office dapat memerlukan waktu hingga dua menit.';
    if (!dialog.open) dialog.showModal();
    try {
      // Probe native media with one byte; fetch documents once to avoid repeated conversion.
      const mediaName = /\.(png|jpe?g|gif|webp|mp4|webm|mov|ogv|mp3|m4a|aac|wav|ogg|flac)$/i.test(button.dataset.name || '');
      const response = await fetch(url, { headers: mediaName ? { Range: 'bytes=0-0' } : {}, signal: controller.signal });
      const mime = (response.headers.get('Content-Type') || '').split(';')[0];
      if (!response.ok || !/^(application\/pdf|image\/(png|jpeg|gif|webp)|audio\/|video\/)/.test(mime)) {
        if (response.body) await response.body.cancel();
        throw new Error('Pratinjau tidak tersedia. Konverter mungkin belum dikonfigurasi, berkas rusak/terproteksi, terlalu besar, atau akses telah berakhir.');
      }
      let element;
      if (mime === 'application/pdf') {
        const blob = await response.blob();
        if (current !== generation) return;
        blobUrl = URL.createObjectURL(blob);
        element = document.createElement('iframe');
        element.title = 'Pratinjau PDF';
        element.src = blobUrl;
        element.style.height = '65vh';
      } else {
        if (response.body) await response.body.cancel();
        if (current !== generation) return;
        element = document.createElement(mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'img');
        if (element.tagName === 'IMG') element.alt = button.dataset.name || 'Pratinjau gambar';
        else { element.controls = true; element.preload = 'metadata'; }
        element.src = url.href;
        element.style.maxHeight = '65vh';
      }
      element.style.width = '100%';
      element.addEventListener('error', () => { status.textContent = 'Media tidak dapat dimuat atau codec tidak didukung. Silakan unduh berkas asli.'; });
      body.replaceChildren(element);
      status.textContent = 'Pratinjau siap. Berkas asli tetap tersedia melalui tombol unduh.';
    } catch (error) {
      if (current === generation && error.name !== 'AbortError') status.textContent = error.message || 'Pratinjau gagal. Silakan unduh berkas asli.';
    }
  });
})();
