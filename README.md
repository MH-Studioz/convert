# Convert

A private, browser-only file converter. Drop a file, pick a format, convert — everything runs locally with Canvas, WebAssembly and JavaScript. No uploads, no accounts, no server.

**Live:** https://mh-studioz.github.io/convert/

## Features

| Category | What you can do |
| --- | --- |
| Images | PNG, JPG, WebP, ICO, BMP, TIFF, PDF, Base64 and GZIP output; resize by max width; quality control |
| Data | CSV/TSV, JSON, YAML, XML, NDJSON, XLSX input and output; Markdown, SQL, HTML and Base64 helpers |
| Documents | Markdown, TXT, HTML, DOCX and PDF input; DOCX, PDF, HTML, TXT and Markdown output |
| Audio | MP3, M4A, AAC, WAV, FLAC, AIFF, OGG and OPUS (ffmpeg.wasm) |
| Video | MP4, MOV, WebM, MKV and animated GIF (ffmpeg.wasm) |
| Archives | Inspect ZIP contents, download single entries, repack or extract ZIP; gzip and un-gzip any file |
| Any file | SHA-256 / SHA-512 hashes, Base64 data URI, GZIP |
| Tools | Spreadsheet/text converter, unit converter, colour converter, conversion log |
| Workflow | Batch queue, per-file or batch conversion, drag-and-drop, paste from clipboard, dark/light theme |

DOCX export writes real Word tables and embedded images, and imports use mammoth so headings, tables and images survive round trips. PDF import uses pdf.js; scanned PDFs without a text layer are reported as such (no OCR).

## Privacy

There is no backend, no analytics, no cookies and no account. Files never leave the tab; conversion history is text metadata kept in `localStorage` and can be cleared from the UI. Conversion engines load from public CDNs, so those requests are the only network traffic.

## Offline use

Convert is an installable PWA. After the first online visit, a service worker caches the app shell and every conversion engine, so it opens and works offline. Use the browser's **Install** action (or **Add to Home Screen**) for a standalone window.

- Images, data, documents, archives and hashing work fully offline after the first load.
- Audio/video conversion also works offline once ffmpeg's ~32 MB core has been downloaded by a first media conversion while online.
- Updates are fetched in the background on the next online load; a reload picks up a new version.

## Run locally

No build step, no dependencies. Serve the folder over HTTP (not `file://`) so the service worker and module-free scripts behave normally:

```sh
cd convert
python -m http.server 8000
# open http://localhost:8000/
```

Any static server works: `npx serve`, `php -S`, nginx, etc.

## Deploy

The app is plain static files. This repository is published with GitHub Pages from `main` at the repository root:

1. Push to `main`.
2. Pages rebuilds automatically (Settings → Pages → Source: Deploy from a branch → `main` / root).

Because all asset paths are relative, it also works from any subdirectory or static host without configuration.

## Project structure

```
index.html    app shell, panels and engine script tags
styles.css    design system, dark and light themes, responsive layout
app.js        detection, conversion pipelines, queue, tools and UI logic
sw.js         offline cache (shell + engines, runtime caching for fonts/ffmpeg core)
manifest.json PWA metadata
icon-*.png/svg app icons
```

## Engines

All client-side, loaded from jsDelivr and pinned by version:

- [JSZip](https://stuk.github.io/jszip/) — ZIP read/write
- [PapaParse](https://www.papaparse.com/) — CSV/TSV
- [SheetJS](https://sheetjs.com/) — XLSX
- [marked](https://marked.js.org/) — Markdown rendering
- [jsPDF](https://github.com/parallax/jsPDF) — PDF generation
- [mammoth](https://github.com/mwilliamson/mammoth.js) — DOCX import
- [pdf.js](https://mozilla.github.io/pdf.js/) — PDF text extraction
- [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) — audio/video
- [Lucide](https://lucide.dev/) — icons

## Known limits

- Audio/video depends on WebAssembly and SharedArrayBuffer availability; the ffmpeg core is a one-time ~32 MB download.
- Media conversion is best-effort for unusual codecs and very large files.
- DOCX/PDF export covers common structure (headings, paragraphs, lists, tables, images); complex Word/PDF layout is flattened.
- No OCR for scanned PDFs, and no HEIC/RAW image decoding beyond what the browser provides.
- Format support ultimately depends on the browser's Canvas encoders and WebAssembly support (current Chrome, Edge, Firefox and Safari).

## License

No license has been declared for this project.
