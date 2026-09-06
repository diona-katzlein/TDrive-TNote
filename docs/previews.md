# Shared secure previews

## Service and UI contract

[`sendPreview(req, res, file, account)`](../src/services/previewService.js:166) is asynchronous. Call it only after the route has authorized the file and resolved its storage account. It additionally rejects account mismatches and deleted files. It never accepts a remote document URL from the browser.

| Context | Preview URL |
| --- | --- |
| Private TDrive | /drive/file/:uuid/preview |
| Public single file | /share/:uuid/preview |
| Public folder descendant | /share/:share_uuid/file/:file_uuid/preview |
| Public folder compatibility | /share/:share_uuid/file/:file_uuid/download?preview=1 |
| Private TKinerja evidence | /kinerja/:uuid/evidence/:evidenceId?preview=1 |
| Public TKinerja evidence | /share/:uuid/kinerja-evidence/:evidenceId?preview=1 |
| Legacy public Word URL | /share/:uuid/docx-preview (now PDF, NOT HTML) |

Evidence ID can be omitted to select the first evidence, matching the existing routes. Existing download URLs and evidence requests without the preview query retain their previous behavior. Public requests still require an active share, password-unlocked session where applicable, and folder ancestry/report evidence membership. Every range request re-enters those authorization checks. Existing share view-limit semantics are unchanged: a landing-page visit that exhausts a limit can prevent subsequent preview requests.

TDrive and public file/folder pages use the shared [preview component](../public/js/file-preview.js). Documents are fetched once, checked for a successful PDF response, and displayed as a local blob in a browser PDF frame; media uses native controls and direct authorized range requests. Closing the dialog aborts pending fetches, stops playback and revokes PDF blob URLs. The legacy Word HTML injection has been removed. Indonesian status/error messages and an original-download link remain visible. Page CSP permits same-origin media and same-origin/blob frames, while page framing and object embedding remain denied. Password query parameters are not copied to media URLs: unlock the share session first.

## TDrive captions

Normal and browser-chunk uploads accept optional plain-text captions, at most 2000 UTF-16 code units. A multi-file normal upload applies the same caption to all selected files. Chunk sessions persist and compare the normalized caption along with filename, folder and chunk count; changing metadata mid-upload is rejected. Owners can edit or clear captions in Drive. Captions are escaped on Drive and public file/folder pages and assigned as text in previews, never HTML. Captions live in application metadata, not Telegram message captions; editing does not rewrite Telegram messages.

The idempotent MariaDB initialization adds nullable caption columns to files and upload sessions; fresh MariaDB/SQLite schemas include captions and the SQLite importer preserves available file captions. Run the migration before serving the new upload handlers. Older files display an empty caption. The active database backend is MariaDB; the legacy SQLite schema alone does not migrate an existing SQLite database.

The legacy browser upload implementation chunks one selected large file at a time. Selection of multiple files including a file over 50 MB is now explicitly rejected rather than silently dropping later files. Collaborative workspace routes/UI are unchanged; this integration covers the private Drive and public sharing URLs above.

## Supported content

- PDF: original PDF bytes, browser PDF viewer, single byte-range requests.
- Word DOC/DOCX, Excel XLS/XLSX, PowerPoint PPT/PPTX: actual locally converted PDF contents through LibreOffice Writer/Calc/Impress. No filename-only placeholders.
- MP4, WebM, MOV, OGV and MP3, M4A, AAC, WAV, OGG, FLAC: original bytes with content type and single byte ranges. Playback depends on browser codecs; no transcoding.
- PNG, JPEG, GIF, WebP: native raster content.
- HTML, SVG, scripts, archives and other unrecognized types: plain-text safe fallback, not inline active content.

Original filename extension takes precedence over metadata MIME; supported MIME is a fallback when no recognized extension exists. This handles generic application/octet-stream metadata on chunk uploads without altering uploaded metadata or download behavior. File content is not HTML-interpolated. Response names are fixed and safe.

## Required Office deployment prerequisite

Native PDF/media previews need no additional npm dependency. Office conversion is deliberately disabled until **TDRIVE_PREVIEW_CONVERTER** points to an administrator-owned executable sandbox wrapper. Never point it directly at an unsandboxed LibreOffice binary. Untrusted documents can reference network resources, contain macros, or exploit parser vulnerabilities.

A Linux reference deployment is supplied in [`Dockerfile`](../src/services/preview/Dockerfile) and [`convert-office.sh`](../src/services/preview/convert-office.sh). On the deployment host:

1. Install Docker (prefer a dedicated rootless daemon), and build a local image using the command `docker build -t tdrive-preview-office:local -f src/services/preview/Dockerfile .` from the project root.
2. Install the wrapper as an executable, administrator-owned file; for example copy it to /opt/tdrive-preview/convert-office and grant execute permission. Keep LF line endings.
3. Set TDRIVE_PREVIEW_CONVERTER to that absolute wrapper path and restart the application. The wrapper and image must not be writable by document uploaders.
4. Ensure the application can invoke the isolated Docker runtime. Membership in a rootful Docker group confers host-level privileges; use rootless Docker or a restricted dedicated conversion worker in hardened production deployments.
5. Put the application's temporary directory (configured with the operating system's TMPDIR) on a dedicated quota-limited private volume, for example 1 GiB per application worker. Periodically remove stale tdrive-preview directories after crashes, only when no jobs are active. Do not put previews under the public web directory.

The reference wrapper disables all networking, drops capabilities, uses a read-only container root, exposes only the current random preview directory, and applies 512 MiB memory, 1 CPU, 64 processes, 64 MiB per-file, 128 MiB temporary filesystem, and a 60-second hard conversion deadline. A private LibreOffice profile sets the highest macro security level. Maintain and rebuild the image for security updates; font installation affects fidelity.

Windows: the Node service and native previews work without a converter. Office requires an equivalent administrator-provided executable wrapper (not a shell/batch command string), implementing the same isolation with a local VM/container and a hard process-tree timeout. The supplied POSIX wrapper is for Linux deployments and is not directly executable by Windows Node. Missing configuration or runtime failures produce a plain-text 503 fallback and do not change original downloads.

## Limits and limitations

- 32 MiB Office input, 64 MiB converted PDF, four simultaneous preview requests per Node worker, no waiting queue, 120-second overall request deadline. Busy responses include Retry-After. Size limits are enforced against metadata and actual downloaded bytes; converted output is checked for regular-file status, size and PDF signature.
- Media is streamed in bounded 512 KiB Telegram blocks; range reads skip unrelated chunks and honor each chunk's own peer. HTTP 206/416, suffix/open-ended ranges, full responses and HEAD are supported. Multi-range requests are rejected. If-Range requests return full content because no validators are emitted.
- A media transfer longer than 120 seconds is cancelled; clients can request subsequent ranges. There is no full-media disk cache and no cross-account preview cache.
- Office conversion occurs per request, including range/HEAD requests. Large or many-sheet workbooks may exceed limits; sheets use LibreOffice print layout. Animations, embedded media, interactive formulas, tracked-change semantics, unusual fonts and complex layouts may not preserve original behavior. Encrypted, corrupt or unsupported documents fail gracefully.
- Temporary source/PDF/profile files are removed after the response, including failures. Container timeout bounds orphan conversion after abrupt client/application termination. Disk quota and stale-file maintenance remain deployment requirements.
- No private document is uploaded to Google, Microsoft, or another viewer service. Original files are read only from the application's existing Telegram storage. Browser-native PDFs remain untrusted documents: keep browsers patched. Responses set no-store, nosniff, no-referrer, same-origin framing and a restrictive sandbox CSP.
- The underlying Telegram library does not expose cancellation for every in-flight RPC; a pending call can finish after the request deadline, but the service stops requesting further bytes and releases its concurrency slot.

## Checks

[`test/preview.test.js`](../test/preview.test.js) covers extension/MIME classification, unsupported active content, account/deletion guards, size limits, single-range parsing, cross-chunk bytes and peer selection, HEAD/416 responses, safe headers and route delegation ordering. Run the standard npm test command; the preview tests are included by the existing test glob.

The local check passed all 21 tests, all EJS template compilation, JavaScript syntax checks, and migration dry run (no live database alteration). [Caption tests](../test/captions.test.js) cover validation, transactional metadata insertion, ownership-scoped updates, escaped public rendering and upload/session wiring. Live Telegram and actual LibreOffice/browser rendering were not exercised in the Windows workspace. Before deployment, test known-content fixtures for all six Office extensions (including multi-sheet Excel and multi-slide PowerPoint), password-protected/corrupt/oversized files, revoked/expired/locked shares, seeking across a storage chunk boundary, network-link documents inside the network-disabled converter, and client disconnect cleanup. PDF previews buffer the full PDF in browser memory before embedding; very large native PDFs may be expensive. Native media is not buffered as a blob.
