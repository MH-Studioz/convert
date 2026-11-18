/* =============================================================================
   Convert — 100% client-side file & data converter
   -----------------------------------------------------------------------------
   Everything in this file runs in the visitor's browser. There is no backend,
   no upload endpoint, no telemetry. Bytes are read with the File API, processed
   in memory (canvas, ffmpeg.wasm, SheetJS, jsPDF, JSZip) and handed back as
   Blob downloads.
   ========================================================================== */

'use strict';

/* ---------------------------------- helpers -------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(bytes, digits = 1) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '—';
  const n = Number(bytes);
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = clamp(Math.floor(Math.log(Math.abs(n)) / Math.log(1024)), 0, units.length - 1);
  const value = n / Math.pow(1024, i);
  const rounded = i === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(digits));
  return `${rounded} ${units[i]}`;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-6) return n.toExponential(6).replace(/\.?0+e/, 'e');
  return String(Number(n.toPrecision(9)));
}

function extOf(name) {
  const clean = String(name || '');
  const base = clean.split(/[\\/]/).pop() || clean;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseName(name) {
  const clean = String(name || 'file');
  const file = clean.split(/[\\/]/).pop() || clean;
  const dot = file.lastIndexOf('.');
  return (dot > 0 ? file.slice(0, dot) : file) || 'file';
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function debounce(fn, wait = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function timeAgo(timestamp) {
  const diff = Math.max(0, Date.now() - Number(timestamp || 0));
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < day * 7) return `${Math.floor(diff / day)}d ago`;
  return new Date(Number(timestamp)).toLocaleDateString();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try {
      window.lucide.createIcons({ attrs: { 'stroke-width': 1.9 } });
    } catch (_) {
      /* icons are decorative — never break the app over them */
    }
  }
}

async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) {
    toast('Nothing to copy yet', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast('Copied to clipboard', 'ok');
  } catch (_) {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      toast(ok ? 'Copied to clipboard' : 'Copy blocked by the browser', ok ? 'ok' : 'err');
    } catch (err) {
      toast('Copy failed: ' + err.message, 'err');
    }
  }
}

function toast(message, kind = 'info') {
  const wrap = $('#toasts');
  if (!wrap) return;
  const glyph = { ok: '✓', err: '!', warn: '△', info: 'i' }[kind] || 'i';
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<span class="toast-ico">${glyph}</span><span>${escapeHtml(message)}</span>`;
  wrap.appendChild(node);
  const life = kind === 'err' ? 7000 : 4000;
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 240);
  }, life);
}

/* -------------------------------- constants -------------------------------- */

const HISTORY_KEY = 'convert.history.v1';
const MAX_FFMPEG_BYTES = 350 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;

const CDN = {
  ffmpegWorker: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js',
  ffmpegCore: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js',
  ffmpegWasm: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'ico', 'gif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv', 'wmv', 'flv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aif', 'aiff']);
const DATA_EXTS = new Set(['csv', 'tsv', 'json', 'xlsx', 'xls', 'ods', 'yaml', 'yml', 'xml', 'ndjson', 'jsonl']);
const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'html', 'htm', 'docx', 'pdf']);

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  gif: 'image/gif',
  pdf: 'application/pdf',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  yaml: 'text/yaml',
  xml: 'application/xml',
  ndjson: 'application/x-ndjson',
  sql: 'application/sql',
  html: 'text/html',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  zip: 'application/zip',
  gz: 'application/gzip',
  base64: 'text/plain',
  sha256: 'text/plain',
};

const OUT_EXT = { md: 'md', sql: 'sql', html: 'html', base64: 'txt', sha256: 'txt' };

const CATEGORY_ICON = {
  image: 'image',
  av: 'film',
  data: 'table',
  doc: 'file-text',
  archive: 'archive',
  compressed: 'archive',
  other: 'file',
};

const CATEGORY_LABEL = {
  image: 'Image',
  av: 'Media',
  data: 'Data',
  doc: 'Document',
  archive: 'Archive',
  compressed: 'Compressed',
  other: 'File',
};

const TARGETS = {
  image: [
    { id: 'png', label: 'PNG' },
    { id: 'jpg', label: 'JPG' },
    { id: 'webp', label: 'WEBP' },
    { id: 'ico', label: 'ICO' },
    { id: 'bmp', label: 'BMP' },
    { id: 'tiff', label: 'TIFF' },
    { id: 'pdf', label: 'PDF' },
    { id: 'base64', label: 'Base64' },
    { id: 'gzip', label: 'GZIP' },
  ],
  data: [
    { id: 'json', label: 'JSON' },
    { id: 'csv', label: 'CSV' },
    { id: 'tsv', label: 'TSV' },
    { id: 'yaml', label: 'YAML' },
    { id: 'xml', label: 'XML' },
    { id: 'ndjson', label: 'NDJSON' },
    { id: 'xlsx', label: 'XLSX' },
    { id: 'md', label: 'MD TABLE' },
    { id: 'sql', label: 'SQL' },
    { id: 'html', label: 'HTML' },
    { id: 'gzip', label: 'GZIP' },
  ],
  doc: [
    { id: 'html', label: 'HTML' },
    { id: 'pdf', label: 'PDF' },
    { id: 'txt', label: 'TXT' },
    { id: 'docx', label: 'DOCX' },
    { id: 'md', label: 'MD' },
    { id: 'gzip', label: 'GZIP' },
  ],
  av: [
    { id: 'mp3', label: 'MP3' },
    { id: 'm4a', label: 'M4A' },
    { id: 'aac', label: 'AAC' },
    { id: 'wav', label: 'WAV' },
    { id: 'flac', label: 'FLAC' },
    { id: 'aiff', label: 'AIFF' },
    { id: 'ogg', label: 'OGG' },
    { id: 'opus', label: 'OPUS' },
    { id: 'mp4', label: 'MP4' },
    { id: 'mov', label: 'MOV' },
    { id: 'webm', label: 'WEBM' },
    { id: 'mkv', label: 'MKV' },
    { id: 'gif', label: 'GIF' },
    { id: 'gzip', label: 'GZIP' },
  ],
  archive: [
    { id: 'inspect', label: 'Inspect' },
    { id: 'zip', label: 'Re-ZIP' },
    { id: 'gzip', label: 'GZIP' },
  ],
  compressed: [
    { id: 'gunzip', label: 'Un-GZIP' },
    { id: 'sha256', label: 'SHA-256' },
    { id: 'base64', label: 'Base64' },
  ],
  other: [
    { id: 'sha256', label: 'SHA-256' },
    { id: 'base64', label: 'Base64' },
    { id: 'gzip', label: 'GZIP' },
  ],
};

const SAMPLE_JSON = JSON.stringify(
  [
    { id: 1, product: 'Aurora Desk Lamp', category: 'Lighting', price: 89.5, stock: 24, active: true },
    { id: 2, product: 'Slate Mechanical Keyboard', category: 'Peripherals', price: 149, stock: 8, active: true },
    { id: 3, product: 'Teal Cable Organiser', category: 'Accessories', price: 12.75, stock: 132, active: false },
    { id: 4, product: 'Navy Laptop Stand', category: 'Accessories', price: 54.2, stock: 41, active: true },
  ],
  null,
  2
);

const UNIT_GROUPS = {
  storage: { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 },
  duration: { ns: 1e-9, 'µs': 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600, day: 86400 },
  frequency: { Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9, rpm: 1 / 60 },
};

/* ---------------------------------- state ---------------------------------- */

const state = {
  items: [],
  history: [],
  busy: false,
  currentId: null,
  logs: [],
  pretty: true,
  view: 'files',
};

/* =============================================================================
   FILE INTAKE
   ========================================================================== */

function detectCategory(file) {
  const ext = extOf(file.name);
  if (ext === 'gz' || ext === 'gzip') return 'compressed';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) return 'av';
  if (DATA_EXTS.has(ext)) return 'data';
  if (DOC_EXTS.has(ext)) return 'doc';
  if (ext === 'zip') return 'archive';

  const type = String(file.type || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'av';
  if (type === 'application/json' || type === 'text/csv') return 'data';
  if (type.startsWith('text/')) return 'doc';
  if (type === 'application/zip' || type === 'application/x-zip-compressed') return 'archive';
  if (type === 'application/gzip' || type === 'application/x-gzip') return 'compressed';
  return 'other';
}

function defaultTarget(item) {
  switch (item.category) {
    case 'image':
      return 'png';
    case 'data':
      return item.ext === 'json' ? 'csv' : 'json';
    case 'doc':
      if (item.ext === 'pdf') return 'txt';
      if (item.ext === 'md' || item.ext === 'markdown') return 'html';
      if (item.ext === 'html' || item.ext === 'htm') return 'md';
      return 'pdf';
    case 'av':
      return AUDIO_EXTS.has(item.ext) ? 'mp3' : 'mp4';
    case 'archive':
      return 'inspect';
    case 'compressed':
      return 'gunzip';
    default:
      return 'sha256';
  }
}

function makeItem(file) {
  const ext = extOf(file.name) || 'bin';
  const category = detectCategory(file);
  const item = {
    id: uid(),
    file,
    name: file.name || `pasted-${Date.now()}.${ext}`,
    size: file.size,
    ext,
    category,
    target: null,
    status: 'queued',
    progress: 0,
    result: null,
    error: null,
    hash: null,
    meta: {},
    entries: null,
    mediaKind: AUDIO_EXTS.has(ext) ? 'audio' : category === 'av' ? 'video' : null,
  };
  item.target = defaultTarget(item);
  return item;
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  let added = 0;
  for (const file of files) {
    if (!file || !file.size) {
      toast(`${file && file.name ? file.name : 'A file'} is empty — skipped`, 'warn');
      continue;
    }
    if (file.size > 2 * 1024 ** 3) {
      toast(`${file.name} is larger than 2 GB and cannot be handled safely in a tab`, 'err');
      continue;
    }
    const item = makeItem(file);
    state.items.push(item);
    added += 1;
    probeMeta(item);
  }

  if (!added) return;
  switchView('files');
  renderQueue();
  toast(`${added} file${added > 1 ? 's' : ''} queued — pick an output format`, 'ok');
}

async function probeMeta(item) {
  try {
    if (item.category === 'image') {
      if (item.ext === 'svg') {
        const text = await item.file.text();
        const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
        if (viewBox) {
          const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
          if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
            item.meta.width = Math.round(parts[2]);
            item.meta.height = Math.round(parts[3]);
          }
        }
        if (!item.meta.width) {
          const width = /\swidth\s*=\s*["']([\d.]+)/i.exec(text);
          const height = /\sheight\s*=\s*["']([\d.]+)/i.exec(text);
          if (width) item.meta.width = Math.round(parseFloat(width[1]));
          if (height) item.meta.height = Math.round(parseFloat(height[1]));
        }
      } else if ('createImageBitmap' in window) {
        const bitmap = await createImageBitmap(item.file);
        item.meta.width = bitmap.width;
        item.meta.height = bitmap.height;
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    } else if (item.category === 'av') {
      const url = URL.createObjectURL(item.file);
      const element = document.createElement(AUDIO_EXTS.has(item.ext) ? 'audio' : 'video');
      element.preload = 'metadata';
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, 5000);
        element.onloadedmetadata = () => {
          clearTimeout(timer);
          finish();
        };
        element.onerror = () => {
          clearTimeout(timer);
          finish();
        };
        element.src = url;
      });
      if (Number.isFinite(element.duration) && element.duration > 0) item.meta.duration = element.duration;
      if (element.videoWidth) {
        item.meta.width = element.videoWidth;
        item.meta.height = element.videoHeight;
        item.mediaKind = 'video';
      } else if (AUDIO_EXTS.has(item.ext)) {
        item.mediaKind = 'audio';
      }
      URL.revokeObjectURL(url);
    }
  } catch (_) {
    /* metadata is a nicety, not a requirement */
  }
  renderQueue();
}

/* =============================================================================
   QUEUE RENDERING
   ========================================================================== */

function metaLine(item) {
  const parts = [item.ext ? item.ext.toUpperCase() : 'FILE', fmtBytes(item.size)];
  if (item.meta.width && item.meta.height) parts.push(`${item.meta.width}×${item.meta.height}`);
  if (item.meta.duration) parts.push(fmtDuration(item.meta.duration));
  return parts;
}

function targetLabel(item) {
  const target = (TARGETS[item.category] || []).find((entry) => entry.id === item.target);
  return target ? target.label : String(item.target || '').toUpperCase();
}

function renderQueue() {
  const section = $('#queueSection');
  const list = $('#queueList');
  if (!section || !list) return;

  const hasItems = state.items.length > 0;
  section.hidden = !hasItems;
  $('#optionsBar').hidden = !hasItems;

  if (!hasItems) {
    list.innerHTML = '';
    updateGlobalButtons();
    return;
  }

  list.innerHTML = state.items.map(fileCardHtml).join('');
  updateGlobalButtons();
  refreshIcons();
}

function fileCardHtml(item) {
  const targets = TARGETS[item.category] || TARGETS.other;
  const done = item.status === 'done' && item.result;
  const classes = ['file-card', `cat-${item.category}`];
  if (done) classes.push('is-done');
  if (item.status === 'error') classes.push('is-error');

  const downloadButton = done && item.result && item.result.blob
    ? `<a class="btn btn-xs btn-teal" href="${item.result.url}" download="${escapeHtml(item.result.name)}"><i data-lucide="download"></i> Download</a>`
    : `<button class="btn btn-xs btn-primary" type="button" data-act="convert" ${state.busy ? 'disabled' : ''}><i data-lucide="zap"></i> Convert</button>`;

  const copyButton = done && item.result && item.result.text
    ? `<button class="btn btn-xs btn-ghost" type="button" data-act="copy-result"><i data-lucide="copy"></i> Copy</button>`
    : '';

  return `
    <article class="${classes.join(' ')}" data-id="${item.id}">
      <div class="fc-head">
        <div class="fc-badge"><i data-lucide="${CATEGORY_ICON[item.category] || 'file'}"></i></div>
        <div class="fc-title">
          <div class="fc-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="fc-meta">
            <span class="cat-tag">${CATEGORY_LABEL[item.category] || 'File'}</span>
            ${metaLine(item).map((part) => `<span>${escapeHtml(part)}</span>`).join('')}
          </div>
        </div>
        <button class="icon-btn" type="button" data-act="remove" aria-label="Remove ${escapeHtml(item.name)}">
          <i data-lucide="x"></i>
        </button>
      </div>

      <div class="fc-targets">
        <span class="targets-label">Convert to</span>
        <div class="pills">
          ${targets.map((target) => `
            <button type="button" class="pill ${target.id === item.target ? 'is-active' : ''}"
              data-act="target" data-target="${target.id}">${target.label}</button>`).join('')}
        </div>
      </div>

      ${statusBlock(item)}
      ${done ? resultBlock(item) : ''}
      ${item.hash ? hashBlock(item) : ''}

      <div class="fc-foot">
        <button class="link-btn" type="button" data-act="hash">
          <i data-lucide="fingerprint"></i> SHA-256 / SHA-512
        </button>
        <div class="fc-foot-actions">
          ${copyButton}
          ${downloadButton}
        </div>
      </div>
    </article>`;
}

function statusBlock(item) {
  if (item.status === 'converting') {
    const label = targetLabel(item);
    return `
      <div class="fc-status is-working">
        <span class="dot"></span>
        <span data-status-text>Converting to ${escapeHtml(label)}${item.category === 'av' ? ' — ffmpeg is working locally' : ''}…</span>
      </div>
      <div class="progress-wrap">
        <div class="progress"><span style="width:${clamp(item.progress, 0, 100)}%"></span></div>
        <span class="progress-label" data-progress-label>${Math.round(item.progress)}%</span>
      </div>`;
  }
  if (item.status === 'error') {
    return `<div class="fc-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(item.error || 'Conversion failed')}</span></div>`;
  }
  if (item.status === 'done') {
    return `<div class="fc-status"><span class="dot" style="background:#10b981"></span>Done${item.result && item.result.note ? ` · ${escapeHtml(item.result.note)}` : ` · ${escapeHtml(targetLabel(item))}`}</div>`;
  }
  return `<div class="fc-status"><span class="dot"></span>Ready — output set to ${escapeHtml(targetLabel(item))}</div>`;
}

function resultBlock(item) {
  const result = item.result;
  if (!result) return '';

  const saved = result.size != null && item.size ? Math.round((1 - result.size / item.size) * 100) : null;
  const parts = ['<div class="fc-result">'];

  if (result.size != null) {
    parts.push(`
      <div class="res-sizes">
        <span class="from">${fmtBytes(item.size)}</span>
        <i data-lucide="arrow-right"></i>
        <span class="to">${fmtBytes(result.size)}</span>
      </div>`);
  }

  if (saved !== null) {
    if (saved > 0) parts.push(`<span class="badge save">−${saved}% smaller</span>`);
    else if (saved < 0) parts.push(`<span class="badge grow">+${Math.abs(saved)}% larger</span>`);
    else parts.push('<span class="badge ghost">same size</span>');
  }

  if (result.note) parts.push(`<span class="res-note">${escapeHtml(result.note)}</span>`);
  parts.push(`<span class="badge ghost">${escapeHtml(String(item.target || '').toUpperCase())}</span>`);
  parts.push('</div>');

  if (result.kind === 'image' && result.url) {
    parts.push(`<div class="fc-preview"><img class="preview-thumb" src="${result.url}" alt="Preview of ${escapeHtml(result.name)}" loading="lazy" /></div>`);
  }

  if (result.previewHtml) {
    parts.push(`
      <details class="preview-details" ${item.category === 'doc' ? 'open' : ''}>
        <summary>Styled preview</summary>
        <div class="doc-preview md-preview">${result.previewHtml}</div>
      </details>`);
  }

  if (result.preview && !result.previewHtml && !(result.entries && result.entries.length)) {
    parts.push(`
      <details class="preview-details">
        <summary>Preview</summary>
        <pre class="preview-code">${escapeHtml(result.preview)}</pre>
      </details>`);
  }

  if (result.entries && result.entries.length) parts.push(zipEntriesHtml(item));

  return parts.join('');
}

function zipEntriesHtml(item) {
  const entries = (item.result && item.result.entries) || item.entries || [];
  if (!entries.length) return '';

  const rows = entries.map((entry, index) => `
    <div class="zip-row">
      <i data-lucide="file"></i>
      <span class="zip-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
      <span class="zip-size">${entry.size ? fmtBytes(entry.size) : '—'}</span>
      <button class="icon-btn" type="button" data-act="zip-entry" data-index="${index}" aria-label="Download ${escapeHtml(entry.name)}">
        <i data-lucide="download"></i>
      </button>
    </div>`).join('');

  return `
    <div class="zip-entries">${rows}</div>
    ${entries.length >= MAX_ZIP_ENTRIES ? `<div class="zip-note">Showing the first ${MAX_ZIP_ENTRIES} entries.</div>` : ''}
    <div class="fc-foot">
      <span class="res-note">${entries.length} extracted file${entries.length === 1 ? '' : 's'} available individually</span>
      <button class="btn btn-xs btn-ghost" type="button" data-act="extract-zip">
        <i data-lucide="archive"></i> Extract all (.zip)
      </button>
    </div>`;
}

function hashBlock(item) {
  if (!item.hash) return '';
  if (item.hash.loading) {
    return `<div class="hash-box"><div class="hash-row"><span class="hash-label">Hashing</span><span class="hash-value">computing SHA-256 &amp; SHA-512 locally…</span></div></div>`;
  }
  if (item.hash.error) {
    return `<div class="hash-box"><div class="hash-row"><span class="hash-label">Error</span><span class="hash-value">${escapeHtml(item.hash.error)}</span></div></div>`;
  }
  const copy = (algo) => `<button class="icon-btn" type="button" data-act="copy-hash" data-hash="${algo}" aria-label="Copy ${algo.toUpperCase()}"><i data-lucide="copy"></i></button>`;
  return `
    <div class="hash-box">
      <div class="hash-row">
        <span class="hash-label">SHA-256</span>
        <span class="hash-value" title="${item.hash.sha256}">${item.hash.sha256}</span>
        ${copy('sha256')}
      </div>
      <div class="hash-row">
        <span class="hash-label">SHA-512</span>
        <span class="hash-value" title="${item.hash.sha512}">${item.hash.sha512}</span>
        ${copy('sha512')}
      </div>
    </div>`;
}

function updateGlobalButtons() {
  const pending = state.items.filter((item) => item.status === 'queued' || item.status === 'error');
  const finished = state.items.filter((item) => item.result && item.result.blob);

  $('#queueCount').textContent = String(state.items.length);
  $('#convertAllLabel').textContent = state.busy ? 'Working…' : 'Convert all';
  $('#convertAll').disabled = state.busy || pending.length === 0;
  $('#clearQueue').disabled = state.busy;
  $('#zipOriginals').hidden = state.items.length < 2;
  $('#downloadZip').hidden = finished.length < 2;

  $('#queueSummary').textContent = state.busy
    ? 'Converting locally — ffmpeg jobs can take a while; keep this tab in the foreground.'
    : `${state.items.length} file${state.items.length === 1 ? '' : 's'} in the queue · ${finished.length} converted · nothing uploaded`;
}

function setItemProgress(item, percent) {
  item.progress = clamp(percent, 0, 100);
  const card = document.querySelector(`.file-card[data-id="${item.id}"]`);
  if (!card) return;
  const bar = card.querySelector('.progress > span');
  if (bar) bar.style.width = `${item.progress}%`;
  const label = card.querySelector('[data-progress-label]');
  if (label) label.textContent = `${Math.round(item.progress)}%`;
}

/* =============================================================================
   CONVERSION PIPELINE
   ========================================================================== */

async function convertAll() {
  if (state.busy) return;
  const queue = state.items.filter((item) => item.status !== 'done' && item.status !== 'converting');
  if (!queue.length) {
    toast('Everything in the queue is already converted', 'info');
    return;
  }

  state.busy = true;
  updateGlobalButtons();
  renderQueue();

  let succeeded = 0;
  let failed = 0;

  for (const item of queue) {
    item.status = 'converting';
    item.error = null;
    item.result = null;
    item.progress = 0;
    renderQueue();

    try {
      const result = await runConversion(item);
      applyResult(item, result);
      succeeded += 1;
    } catch (err) {
      console.error('[convert]', item.name, err);
      item.status = 'error';
      item.error = friendlyError(err);
      failed += 1;
      toast(`${item.name}: ${friendlyError(err)}`, 'err');
    }
    renderQueue();
  }

  state.busy = false;
  state.currentId = null;
  renderQueue();

  if (succeeded) {
    toast(`${succeeded} file${succeeded === 1 ? '' : 's'} converted on this device${failed ? ` · ${failed} failed` : ''}`, 'ok');
  }
}

async function convertSingle(item) {
  if (state.busy) return;
  state.busy = true;
  item.status = 'converting';
  item.error = null;
  item.result = null;
  item.progress = 0;
  renderQueue();
  try {
    const result = await runConversion(item);
    applyResult(item, result);
    toast(`${item.name} converted`, 'ok');
  } catch (err) {
    console.error('[convert]', item.name, err);
    item.status = 'error';
    item.error = friendlyError(err);
    toast(`${item.name}: ${friendlyError(err)}`, 'err');
  } finally {
    state.busy = false;
    state.currentId = null;
    renderQueue();
  }
}

function friendlyError(err) {
  const message = (err && err.message) || String(err) || 'Unknown error';
  if (/memory|allocat|out of bounds|Cannot enlarge/i.test(message)) {
    return `${message} — the tab ran out of memory. Try a smaller file or lower resolution.`;
  }
  return message;
}

async function runConversion(item) {
  const target = item.target;
  if (!target) throw new Error('Pick an output format first');

  if (target === 'sha256') {
    const hashes = await computeHashes(item.file);
    item.hash = hashes;
    const text = `SHA-256  ${hashes.sha256}\nSHA-512  ${hashes.sha512}\nFile     ${item.name}\nSize     ${item.size} bytes\n`;
    return {
      blob: new Blob([text], { type: 'text/plain' }),
      name: `${baseName(item.name)}.hashes.txt`,
      kind: 'text',
      text,
      preview: text,
    };
  }

  if (target === 'base64') return base64Result(item);
  if (target === 'gzip') return gzipResult(item);

  switch (item.category) {
    case 'image':
      return convertImage(item, target);
    case 'data':
      return convertData(item, target);
    case 'doc':
      return convertDoc(item, target);
    case 'av':
      return convertAV(item, target);
    case 'archive':
      return convertArchive(item, target);
    case 'compressed':
      return convertCompressed(item, target);
    default:
      return base64Result(item);
  }
}

function applyResult(item, result) {
  item.result = result;
  if (result.blob) result.url = URL.createObjectURL(result.blob);
  item.status = 'done';
  item.progress = 100;

  if (result.blob) {
    pushHistory({
      id: uid(),
      name: result.name,
      from: (item.ext || 'file').toUpperCase(),
      to: String(item.target || '').toUpperCase(),
      inSize: item.size,
      outSize: result.size,
      at: Date.now(),
    });

    const auto = $('#autoDownload');
    if (auto && auto.checked) {
      setTimeout(() => downloadBlob(result.blob, result.name), 250);
    }
  }
}

async function computeHashes(file) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto is unavailable — open the page over HTTPS or localhost');
  }
  const buffer = await file.arrayBuffer();
  const [sha256, sha512] = await Promise.all([
    crypto.subtle.digest('SHA-256', buffer),
    crypto.subtle.digest('SHA-512', buffer),
  ]);
  const toHex = (value) => Array.from(new Uint8Array(value)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { sha256: toHex(sha256), sha512: toHex(sha512) };
}

async function computeHashesForItem(item) {
  item.hash = { loading: true };
  renderQueue();
  try {
    item.hash = await computeHashes(item.file);
    toast('SHA-256 & SHA-512 computed locally', 'ok');
  } catch (err) {
    item.hash = { error: err.message || 'Hash failed' };
    toast(err.message || 'Hash failed', 'err');
  }
  renderQueue();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The browser could not read this file'));
    reader.readAsDataURL(file);
  });
}

async function base64Result(item) {
  const dataUrl = await fileToDataUrl(item.file);
  const text = `# ${item.name}\n# ${fmtBytes(item.size)} · ${item.file.type || 'application/octet-stream'}\n# Base64 data URI, generated in the browser\n${dataUrl}\n`;
  const blob = new Blob([text], { type: 'text/plain' });
  return {
    blob,
    name: `${baseName(item.name)}.base64.txt`,
    size: blob.size,
    kind: 'text',
    text,
    preview: text.slice(0, 1400),
  };
}

function uniqueName(name, used) {
  const candidate = String(name || 'file');
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const dot = candidate.lastIndexOf('.');
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot > 0 ? candidate.slice(dot) : '';
  let index = 2;
  let next = `${stem}-${index}${ext}`;
  while (used.has(next)) {
    index += 1;
    next = `${stem}-${index}${ext}`;
  }
  used.add(next);
  return next;
}

async function bundleZip(kind) {
  if (!window.JSZip) {
    toast('JSZip is unavailable — check your connection and reload', 'err');
    return;
  }
  const source = kind === 'originals'
    ? state.items.map((item) => ({ blob: item.file, name: item.name }))
    : state.items.filter((item) => item.result && item.result.blob).map((item) => ({ blob: item.result.blob, name: item.result.name }));

  if (!source.length) {
    toast('Nothing to bundle yet', 'warn');
    return;
  }

  try {
    const zip = new JSZip();
    const used = new Set();
    for (const entry of source) zip.file(uniqueName(entry.name, used), entry.blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, `convert-${kind === 'originals' ? 'originals' : 'results'}-${stamp()}.zip`);
    toast(`${source.length} files bundled into one ZIP`, 'ok');
  } catch (err) {
    toast('Could not build the ZIP: ' + err.message, 'err');
  }
}

function removeItem(item) {
  if (state.busy) {
    toast('Wait for the current conversion to finish', 'warn');
    return;
  }
  if (item.result && item.result.url) URL.revokeObjectURL(item.result.url);
  state.items = state.items.filter((candidate) => candidate.id !== item.id);
  renderQueue();
}

/* =============================================================================
   IMAGE CONVERSION (Canvas API)
   ========================================================================== */

function imageOptions() {
  const qualityInput = $('#quality');
  const widthInput = $('#maxWidth');
  const quality = clamp(Number(qualityInput ? qualityInput.value : 92) || 92, 10, 100) / 100;
  const maxWidth = Math.max(0, Number(widthInput ? widthInput.value : 0) || 0);
  return { quality, maxWidth };
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The browser could not decode this image'));
    image.src = url;
  });
}

async function drawImageToCanvas(file, maxWidth) {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  let width = 0;
  let height = 0;
  let draw = null;
  let cleanup = null;

  if (isSvg) {
    let text = '';
    try {
      text = await file.text();
    } catch (_) {
      text = '';
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const image = await loadHtmlImage(url);
    width = image.naturalWidth || 0;
    height = image.naturalHeight || 0;

    if ((!width || !height) && text) {
      const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
      if (viewBox) {
        const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          width = parts[2];
          height = parts[3];
        }
      }
      const widthAttr = /\swidth\s*=\s*["']([\d.]+)/i.exec(text);
      const heightAttr = /\sheight\s*=\s*["']([\d.]+)/i.exec(text);
      if (!width && widthAttr) width = parseFloat(widthAttr[1]);
      if (!height && heightAttr) height = parseFloat(heightAttr[1]);
    }

    if (!width || !height) {
      width = 1024;
      height = 1024;
    }
    draw = (ctx, w, h) => ctx.drawImage(image, 0, 0, w, h);
    cleanup = () => URL.revokeObjectURL(url);
  } else {
    if (!('createImageBitmap' in window)) {
      throw new Error('This browser cannot decode images into a canvas');
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error(`Could not decode ${file.name} — HEIC/RAW and some ICO files are not supported by the browser canvas`);
    }
    width = bitmap.width;
    height = bitmap.height;
    draw = (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h);
    cleanup = () => {
      if (typeof bitmap.close === 'function') bitmap.close();
    };
  }

  if (maxWidth && width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }

  const limit = 8192;
  if (width > limit || height > limit) {
    const scale = Math.min(limit / width, limit / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  draw(ctx, width, height);
  if (cleanup) cleanup();
  return canvas;
}

function flattenCanvas(canvas) {
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return flat;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(`This browser could not encode ${type}`));
        return;
      }
      if (blob.type && blob.type !== type) {
        reject(new Error(`${type.replace('image/', '').toUpperCase()} export is not supported by this browser — try PNG or JPG`));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function canvasToBmp(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const fileSize = 54 + pixelSize;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelSize, true);
  view.setUint32(38, 2835, true);
  view.setUint32(42, 2835, true);

  for (let y = height - 1; y >= 0; y -= 1) {
    let offset = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      bytes[offset] = pixels[index + 2];
      bytes[offset + 1] = pixels[index + 1];
      bytes[offset + 2] = pixels[index];
      offset += 3;
    }
  }

  return new Blob([buffer], { type: 'image/bmp' });
}

function canvasToTiff(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const dataSize = width * height * 3;
  const ifdOffset = 8;
  const entryCount = 12;
  const ifdSize = 2 + entryCount * 12 + 4;
  const bitsOffset = ifdOffset + ifdSize;
  const xResOffset = bitsOffset + 6;
  const yResOffset = xResOffset + 8;
  const pixelOffset = yResOffset + 8;
  const buffer = new ArrayBuffer(pixelOffset + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);

  let offset = ifdOffset + 2;
  const entry = (tag, type, count, value) => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(offset + 8, value, true);
    else view.setUint32(offset + 8, value, true);
    offset += 12;
  };

  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 3, bitsOffset);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 2);
  entry(273, 4, 1, pixelOffset);
  entry(277, 3, 1, 3);
  entry(278, 4, 1, height);
  entry(279, 4, 1, dataSize);
  entry(282, 5, 1, xResOffset);
  entry(283, 5, 1, yResOffset);
  entry(296, 3, 1, 2);
  view.setUint32(offset, 0, true);

  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);
  view.setUint32(xResOffset, 72, true);
  view.setUint32(xResOffset + 4, 1, true);
  view.setUint32(yResOffset, 72, true);
  view.setUint32(yResOffset + 4, 1, true);

  let cursor = pixelOffset;
  for (let index = 0; index < pixels.length; index += 4) {
    bytes[cursor] = pixels[index];
    bytes[cursor + 1] = pixels[index + 1];
    bytes[cursor + 2] = pixels[index + 2];
    cursor += 3;
  }

  return new Blob([buffer], { type: 'image/tiff' });
}

function pngToIco(pngBytes, width, height) {
  const header = new Uint8Array(6);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(2, 1, true);
  headerView.setUint16(4, 1, true);

  const directory = new Uint8Array(16);
  const dirView = new DataView(directory.buffer);
  dirView.setUint8(0, width >= 256 ? 0 : width);
  dirView.setUint8(1, height >= 256 ? 0 : height);
  dirView.setUint8(2, 0);
  dirView.setUint8(3, 0);
  dirView.setUint16(4, 1, true);
  dirView.setUint16(6, 32, true);
  dirView.setUint32(8, pngBytes.length, true);
  dirView.setUint32(12, 6 + 16, true);

  return new Blob([header, directory, pngBytes], { type: 'image/x-icon' });
}

function canvasToPdf(canvas) {
  const JsPdf = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdf) throw new Error('jsPDF is unavailable — check your connection and reload');
  const landscape = canvas.width > canvas.height;
  const pdf = new JsPdf({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
  const drawWidth = canvas.width * scale;
  const drawHeight = canvas.height * scale;
  const data = canvas.toDataURL('image/jpeg', 0.92);
  pdf.addImage(data, 'JPEG', (pageWidth - drawWidth) / 2, (pageHeight - drawHeight) / 2, drawWidth, drawHeight, undefined, 'FAST');
  return pdf.output('blob');
}

function imageResult(blob, name, canvas) {
  return {
    blob,
    name,
    size: blob.size,
    kind: 'image',
    width: canvas ? canvas.width : null,
    height: canvas ? canvas.height : null,
  };
}

async function convertImage(item, target) {
  const { quality, maxWidth } = imageOptions();
  const canvas = await drawImageToCanvas(item.file, maxWidth);
  const base = baseName(item.name);

  switch (target) {
    case 'png':
      return imageResult(await canvasToBlob(canvas, 'image/png'), `${base}.png`, canvas);

    case 'jpg':
      return imageResult(await canvasToBlob(flattenCanvas(canvas), 'image/jpeg', quality), `${base}.jpg`, canvas);

    case 'webp':
      return imageResult(await canvasToBlob(canvas, 'image/webp', quality), `${base}.webp`, canvas);

    case 'bmp':
      return imageResult(canvasToBmp(flattenCanvas(canvas)), `${base}.bmp`, canvas);

    case 'tiff':
      return imageResult(canvasToTiff(flattenCanvas(canvas)), `${base}.tiff`, canvas);

    case 'ico': {
      const size = 256;
      const icon = document.createElement('canvas');
      icon.width = size;
      icon.height = size;
      const ctx = icon.getContext('2d');
      const scale = Math.min(size / canvas.width, size / canvas.height);
      const drawWidth = Math.max(1, Math.round(canvas.width * scale));
      const drawHeight = Math.max(1, Math.round(canvas.height * scale));
      ctx.drawImage(canvas, Math.round((size - drawWidth) / 2), Math.round((size - drawHeight) / 2), drawWidth, drawHeight);
      const pngBlob = await canvasToBlob(icon, 'image/png');
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      return imageResult(pngToIco(pngBytes, size, size), `${base}.ico`, icon);
    }

    case 'pdf': {
      const blob = canvasToPdf(flattenCanvas(canvas));
      return { blob, name: `${base}.pdf`, size: blob.size, kind: 'image', width: canvas.width, height: canvas.height };
    }

    case 'base64': {
      const dataUrl = canvas.toDataURL('image/png');
      const text = `# ${item.name}\n# ${fmtBytes(item.size)} · converted to a PNG data URI\n${dataUrl}\n`;
      const blob = new Blob([text], { type: 'text/plain' });
      return { blob, name: `${base}.base64.txt`, size: blob.size, kind: 'text', text, preview: text.slice(0, 1200) };
    }

    default:
      throw new Error(`Unsupported image target: ${target}`);
  }
}

/* =============================================================================
   DATA / SPREADSHEET CONVERSION
   ========================================================================== */

function normalizeRows(rows) {
  const clean = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  const fields = [];
  for (const row of clean) {
    for (const key of Object.keys(row)) {
      if (!fields.includes(key)) fields.push(key);
    }
  }
  return { rows: clean, fields };
}

function flattenRow(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) result[key] = '';
    else if (typeof value === 'object') result[key] = JSON.stringify(value);
    else result[key] = value;
  }
  return result;
}

function normalizeJson(value) {
  let rows;
  if (Array.isArray(value)) {
    rows = value;
  } else if (value && typeof value === 'object') {
    const nestedArrays = Object.values(value).filter((entry) => Array.isArray(entry));
    if (nestedArrays.length === 1 && nestedArrays[0].length && typeof nestedArrays[0][0] === 'object' && !Array.isArray(nestedArrays[0][0])) {
      rows = nestedArrays[0];
    } else {
      rows = [value];
    }
  } else {
    rows = [{ value }];
  }
  const normalized = rows.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? flattenRow(row) : { value: row }));
  return normalizeRows(normalized);
}

async function readTable(item) {
  if (!window.Papa) throw new Error('PapaParse is unavailable — check your connection and reload');
  const ext = item.ext;

  if (ext === 'csv' || ext === 'tsv') {
    const text = await item.file.text();
    const parsed = Papa.parse(text.trim(), {
      header: true,
      skipEmptyLines: 'greedy',
      delimiter: ext === 'tsv' ? '\t' : undefined,
    });
    if (parsed.errors && parsed.errors.length && !parsed.data.length) {
      throw new Error('CSV parse error: ' + parsed.errors[0].message);
    }
    return normalizeRows(parsed.data.map(flattenRow));
  }

  if (ext === 'json') {
    const text = await item.file.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON: ' + err.message);
    }
    return normalizeJson(value);
  }

  if (ext === 'yaml' || ext === 'yml') {
    return normalizeJson(parseYaml(await item.file.text()));
  }

  if (ext === 'xml') {
    return normalizeJson(parseXml(await item.file.text()));
  }

  if (ext === 'ndjson' || ext === 'jsonl') {
    const lines = (await item.file.text()).split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw new Error('This NDJSON file has no records');
    const rows = lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid NDJSON on line ${index + 1}: ${err.message}`);
      }
    });
    return normalizeJson(rows);
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
    if (!window.XLSX) throw new Error('SheetJS is unavailable — check your connection and reload');
    const workbook = XLSX.read(await item.file.arrayBuffer());
    if (!workbook.SheetNames.length) throw new Error('This workbook contains no sheets');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    return normalizeRows(rows);
  }

  throw new Error('Unsupported spreadsheet format');
}

function rowsToCsv(rows, fields, delimiter) {
  const matrix = [fields, ...rows.map((row) => fields.map((field) => (row[field] == null ? '' : row[field])))];
  if (window.Papa) return Papa.unparse(matrix, { delimiter });
  return matrix.map((row) => row.map((value) => {
    const text = String(value == null ? '' : value);
    return /[",\n\r]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(delimiter)).join('\r\n');
}

function rowsToMarkdown(rows, fields) {
  const escapeCell = (value) => String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const header = `| ${fields.map(escapeCell).join(' | ')} |`;
  const divider = `| ${fields.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${fields.map((field) => escapeCell(row[field])).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function rowsToSql(rows, fields, tableName) {
  const ident = (name) => '`' + String(name).replace(/`/g, '``') + '`';
  const literal = (value) => {
    if (value === null || value === undefined || value === '') return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    return `'${String(value).replace(/'/g, "''")}'`;
  };
  const columns = fields.map(ident).join(', ');
  return rows.map((row) => `INSERT INTO ${ident(tableName)} (${columns}) VALUES (${fields.map((field) => literal(row[field])).join(', ')});`).join('\n');
}

function rowsToHtml(rows, fields, title) {
  const head = fields.map((field) => `<th>${escapeHtml(field)}</th>`).join('');
  const body = rows.map((row) => `<tr>${fields.map((field) => `<td>${escapeHtml(row[field])}</td>`).join('')}</tr>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 40px auto; max-width: 1000px; padding: 0 18px; background:#fff; color:#0f172a;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  h1 { font-size: 1.4rem; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #eef2ff; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>`;
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeXmlTag(name) {
  const tag = String(name || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z_]+/, '');
  return (tag || 'item').slice(0, 64);
}

function coerceXmlValue(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return '';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  return value;
}

function xmlNodeToValue(node) {
  const result = {};
  for (const attribute of Array.from(node.attributes || [])) result[attribute.name] = coerceXmlValue(attribute.value);
  const children = Array.from(node.children || []);
  if (!children.length) {
    const text = coerceXmlValue(node.textContent);
    if (!Object.keys(result).length) return text;
    if (text !== '') result['#text'] = text;
    return result;
  }
  const groups = {};
  for (const child of children) {
    const key = child.tagName;
    (groups[key] = groups[key] || []).push(xmlNodeToValue(child));
  }
  for (const [key, values] of Object.entries(groups)) result[key] = values.length === 1 ? values[0] : values;
  return result;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure) {
    throw new Error('Invalid XML: ' + (failure.textContent || 'could not parse the document').replace(/\s+/g, ' ').trim().slice(0, 120));
  }
  if (!doc.documentElement) throw new Error('This XML document is empty');
  return xmlNodeToValue(doc.documentElement);
}

function rowsToXml(rows, fields, title) {
  const root = safeXmlTag(slugify(title) || 'data');
  const body = rows.map((row) => {
    const cells = fields.map((field) => `    <${safeXmlTag(field)}>${xmlEscape(row[field])}</${safeXmlTag(field)}>`).join('\n');
    return `  <row>\n${cells}\n  </row>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n${body}\n</${root}>\n`;
}

function valueToXml(value, rootName = 'data') {
  const root = safeXmlTag(rootName);
  const render = (name, entry, depth) => {
    const pad = '  '.repeat(depth);
    const tag = safeXmlTag(name);
    if (Array.isArray(entry)) {
      if (!entry.length) return `${pad}<${tag}/>`;
      return entry.map((item) => render(name, item, depth)).join('\n');
    }
    if (entry && typeof entry === 'object') {
      const inner = Object.entries(entry).map(([key, nested]) => render(key, nested, depth + 1)).join('\n');
      return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
    }
    return `${pad}<${tag}>${xmlEscape(entry)}</${tag}>`;
  };
  const body = Array.isArray(value)
    ? value.map((entry) => render('item', entry, 0)).join('\n')
    : value && typeof value === 'object'
      ? Object.entries(value).map(([key, entry]) => render(key, entry, 0)).join('\n')
      : render('value', value, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n${body}\n</${root}>\n`;
}

async function convertData(item, target) {
  const table = await readTable(item);
  if (!table.rows.length) throw new Error('No data rows were found in this file');
  const fields = table.fields.length ? table.fields : ['value'];
  const rows = table.rows;
  const base = baseName(item.name);

  if (target === 'xlsx') {
    if (!window.XLSX) throw new Error('SheetJS is unavailable — check your connection and reload');
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: fields });
    worksheet['!cols'] = fields.map((field) => ({ wch: clamp(String(field).length + 4, 10, 42) }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Converted');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], { type: MIME.xlsx });
    return {
      blob,
      name: `${base}.xlsx`,
      size: blob.size,
      kind: 'data',
      preview: rowsToMarkdown(rows.slice(0, 8), fields),
    };
  }

  let text = '';
  if (target === 'json') text = JSON.stringify(rows, null, 2);
  else if (target === 'csv') text = rowsToCsv(rows, fields, ',');
  else if (target === 'tsv') text = rowsToCsv(rows, fields, '\t');
  else if (target === 'yaml') text = toYaml(rows);
  else if (target === 'xml') text = rowsToXml(rows, fields, base);
  else if (target === 'ndjson') text = rows.map((row) => JSON.stringify(row)).join('\n');
  else if (target === 'md') text = rowsToMarkdown(rows, fields);
  else if (target === 'sql') text = rowsToSql(rows, fields, slugify(base) || 'imported_data');
  else if (target === 'html') text = rowsToHtml(rows, fields, base);
  else throw new Error('Unsupported data target');

  const blob = new Blob([text], { type: MIME[target] || 'text/plain' });
  return {
    blob,
    name: `${base}.${OUT_EXT[target] || target}`,
    size: blob.size,
    kind: 'data',
    text,
    preview: text.split('\n').slice(0, 20).join('\n'),
  };
}

/* =============================================================================
   DOCUMENT CONVERSION (Markdown / HTML / TXT / PDF / DOCX)
   ========================================================================== */

function renderMarkdown(markdown) {
  if (!window.marked || typeof window.marked.parse !== 'function') {
    throw new Error('The Markdown renderer is unavailable — check your connection and reload');
  }
  const rendered = window.marked.parse(markdown);
  return typeof rendered === 'string' ? rendered : String(rendered);
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form, input, button, textarea, select').forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return doc.body.innerHTML;
}

function plainTextToHtml(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

function docToHtml(raw, source) {
  if (source === 'markdown') return sanitizeHtml(renderMarkdown(raw));
  if (source === 'html') return sanitizeHtml(raw);
  return plainTextToHtml(raw);
}

function buildHtmlDocument(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { max-width: 760px; margin: 48px auto; padding: 0 20px; background: #fff; color: #0f172a;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 .55em; letter-spacing: -.02em; }
  h1 { font-size: 2rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.22rem; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  ul, ol { padding-left: 1.4em; }
  a { color: #4f46e5; }
  code { background: #eef2ff; padding: .15em .35em; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
  pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 10px; overflow: auto; }
  pre code { background: none; padding: 0; color: inherit; }
  blockquote { border-left: 4px solid #c7d2fe; padding-left: 16px; color: #475569; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; }
  th { background: #f1f5f9; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid #cbd5e1; margin: 2em 0; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function htmlToPlainText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  doc.querySelectorAll('p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote, hr').forEach((node) => {
    node.append('\n');
  });
  return doc.body.textContent
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');

  const cellText = (cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

  const tableToMarkdown = (table) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const matrix = rows.map((row) => Array.from(row.querySelectorAll('th, td')).map(cellText));
    const columns = Math.max(...matrix.map((row) => row.length));
    const header = matrix[0].length ? matrix[0].slice() : Array.from({ length: columns }, (_, index) => `Column ${index + 1}`);
    while (header.length < columns) header.push('');
    const body = matrix.slice(1);
    return [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${Array.from({ length: columns }, (_, index) => row[index] || '').join(' | ')} |`),
    ].join('\n');
  };

  const convert = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';

    const inner = Array.from(node.childNodes).map(convert).join('');

    switch (tag) {
      case 'h1': return `\n# ${inner.trim()}\n`;
      case 'h2': return `\n## ${inner.trim()}\n`;
      case 'h3': return `\n### ${inner.trim()}\n`;
      case 'h4': return `\n#### ${inner.trim()}\n`;
      case 'h5': return `\n##### ${inner.trim()}\n`;
      case 'h6': return `\n###### ${inner.trim()}\n`;
      case 'p': return `\n${inner.trim()}\n`;
      case 'br': return '  \n';
      case 'strong':
      case 'b': return `**${inner.trim()}**`;
      case 'em':
      case 'i': return `*${inner.trim()}*`;
      case 'del':
      case 's': return `~~${inner.trim()}~~`;
      case 'code': return `\`${node.textContent}\``;
      case 'pre': return `\n\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        return href ? `[${inner.trim() || href}](${href})` : inner;
      }
      case 'img': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
      case 'blockquote': return `\n> ${inner.trim().replace(/\n/g, '\n> ')}\n`;
      case 'ul':
      case 'ol': {
        const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === 'li');
        const lines = items.map((item, index) => {
          const body = Array.from(item.childNodes).map(convert).join('').trim();
          return `${tag === 'ol' ? `${index + 1}.` : '-'} ${body}`;
        });
        return `\n${lines.join('\n')}\n`;
      }
      case 'hr': return '\n---\n';
      case 'table': return `\n${tableToMarkdown(node)}\n`;
      default: return inner;
    }
  };

  return Array.from(doc.body.childNodes)
    .map(convert)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function docBlocksFromHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const blocks = [];

  const push = (tag, text) => {
    const value = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (value) blocks.push({ tag, text: value });
  };

  const walk = (node) => {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'iframe', 'object', 'embed'].includes(tag)) return;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      push(tag, node.textContent);
      return;
    }
    if (tag === 'p') {
      push('p', node.textContent);
      return;
    }
    if (tag === 'li') {
      push('li', node.textContent);
      return;
    }
    if (tag === 'pre') {
      push('pre', node.textContent);
      return;
    }
    if (tag === 'blockquote') {
      push('blockquote', node.textContent);
      return;
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
        blocks.push({ tag: 'img', src, alt: node.getAttribute('alt') || '' });
      }
      return;
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'))
        .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim()))
        .filter((row) => row.length);
      if (rows.length) blocks.push({ tag: 'table', rows });
      return;
    }
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue.replace(/\s+/g, ' ').trim();
        if (text) push('p', text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    });
  };

  Array.from(doc.body.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    else if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim()) push('p', child.nodeValue);
  });

  if (!blocks.length) push('p', doc.body.textContent);
  return blocks;
}

function loadImageSize(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 480, height: image.naturalHeight || 320 });
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function pdfFromHtml(html, title) {
  const JsPdf = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdf) throw new Error('jsPDF is unavailable — check your connection and reload');

  const blocks = docBlocksFromHtml(html);
  const firstBlock = blocks[0];
  const hasOwnTitle = firstBlock && ['h1', 'title'].includes(firstBlock.tag)
    && String(firstBlock.text || '').trim().toLowerCase() === String(title || 'Converted document').trim().toLowerCase();
  const imageSizes = {};
  for (const block of blocks) {
    if (block.tag === 'img' && !imageSizes[block.src]) imageSizes[block.src] = await loadImageSize(block.src);
  }
  const pdf = new JsPdf({ unit: 'pt', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 54;
  const maxWidth = pageWidth - margin * 2;
  let y = margin + 4;

  const ensure = (height) => {
    if (y + height > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
  };

  const write = (text, options = {}) => {
    const { size = 11, style = 'normal', family = 'helvetica', lead = 1.55, gap = 7, indent = 0 } = options;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    pdf.setFont(family, style);
    pdf.setFontSize(size);
    pdf.setTextColor(23, 32, 51);
    const lines = pdf.splitTextToSize(clean, maxWidth - indent);
    const lineHeight = size * lead;
    for (const line of lines) {
      ensure(lineHeight);
      pdf.text(line, margin + indent, y);
      y += lineHeight;
    }
    y += gap;
  };

  if (!hasOwnTitle) write(title || 'Converted document', { size: 20, style: 'bold', gap: 14 });

  for (const block of blocks) {
    const tag = block.tag;
    if (tag === 'h1') write(block.text, { size: 17, style: 'bold', gap: 10 });
    else if (tag === 'h2') write(block.text, { size: 14.5, style: 'bold', gap: 8 });
    else if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') write(block.text, { size: 12.5, style: 'bold', gap: 7 });
    else if (tag === 'li') write('•  ' + block.text, { indent: 14, gap: 4 });
    else if (tag === 'blockquote') write(block.text, { style: 'italic', indent: 14 });
    else if (tag === 'pre') {
      pdf.setFont('courier', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(43, 55, 77);
      for (const rawLine of block.text.split('\n')) {
        const wrapped = pdf.splitTextToSize(rawLine || ' ', maxWidth - 16);
        for (const line of wrapped) {
          ensure(12);
          pdf.text(line, margin + 10, y);
          y += 12;
        }
      }
      y += 8;
    } else if (tag === 'table') {
      const rows = block.rows || [];
      for (let index = 0; index < rows.length; index += 1) {
        write(rows[index].join('   |   '), {
          size: 8.5,
          style: index === 0 ? 'bold' : 'normal',
          lead: 1.4,
          gap: 2,
        });
      }
      y += 6;
    } else if (tag === 'img') {
      const size = imageSizes[block.src];
      if (!size || !size.width || !size.height) continue;
      let width = Math.min(maxWidth, size.width);
      let height = (size.height * width) / size.width;
      const maxHeight = pageHeight - margin * 2;
      if (height > maxHeight) {
        width *= maxHeight / height;
        height = maxHeight;
      }
      ensure(height + 12);
      try {
        pdf.addImage(block.src, /^data:image\/jpe?g/i.test(block.src) ? 'JPEG' : 'PNG', margin, y, width, height);
        y += height + 12;
      } catch (_) {
        /* unsupported image format — skip it rather than failing the document */
      }
    } else {
      write(block.text);
    }
  }

  const total = pdf.getNumberOfPages();
  for (let index = 1; index <= total; index += 1) {
    pdf.setPage(index);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(148, 163, 184);
    pdf.text(`${index} / ${total}`, pageWidth - margin, pageHeight - 22, { align: 'right' });
  }

  return pdf.output('blob');
}

async function buildDocx(html, title) {
  if (!window.JSZip) throw new Error('JSZip is unavailable — DOCX export needs it');

  const escapeXml = (value) => String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const sourceBlocks = docBlocksFromHtml(html);
  const firstBlock = sourceBlocks[0];
  const hasOwnTitle = firstBlock && ['h1', 'title'].includes(firstBlock.tag)
    && String(firstBlock.text || '').trim().toLowerCase() === String(title || 'Converted document').trim().toLowerCase();
  const blocks = hasOwnTitle ? sourceBlocks : [{ tag: 'h1', text: title || 'Converted document' }, ...sourceBlocks];

  const media = [];
  for (const block of blocks) {
    if (block.tag !== 'img') continue;
    const match = /^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/=\s]+)$/i.exec(block.src);
    if (!match) continue;
    const extension = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
    const binary = atob(match[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const size = (await loadImageSize(block.src)) || { width: 480, height: 320 };
    block.media = {
      fileName: `image${media.length + 1}.${extension}`,
      relationship: `rId${media.length + 1}`,
      extension,
      bytes,
      width: size.width,
      height: size.height,
    };
    media.push(block.media);
  }

  const docxTable = (rows) => {
    const borders = '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D3D3D5"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D3D3D5"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D3D3D5"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D3D3D5"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D3D3D5"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D3D3D5"/></w:tblBorders>';
    const body = rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${body}</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`;
  };

  const docxImage = (block) => {
    const image = block.media;
    if (!image) return '';
    const reference = media.indexOf(image) + 1;
    const width = Math.min(480, image.width);
    const height = Math.max(1, Math.round((image.height * width) / image.width));
    const cx = Math.round(width * 9525);
    const cy = Math.round(height * 9525);
    return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${reference}" name="Picture ${reference}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${reference}" name="${image.fileName}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  };

  const paragraphs = blocks.map((block) => {
    if (block.tag === 'table') return docxTable(block.rows || []);
    if (block.tag === 'img') return docxImage(block);

    const tag = block.tag;
    const heading = /^h([1-6])$/.exec(tag);
    const isHeading = tag === 'title' || Boolean(heading);
    const sizes = { title: 36, h1: 32, h2: 28, h3: 24, h4: 22, h5: 22, h6: 22 };
    const size = sizes[tag] || 22;
    const bold = '';
    const spacing = isHeading ? 200 : 100;
    const style = isHeading ? `<w:pStyle w:val="${tag === 'title' ? 'Heading1' : `Heading${heading[1]}`}"/>` : '';
    return `<w:p><w:pPr>${style}<w:spacing w:after="${spacing}"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(block.text)}</w:t></w:r></w:p>`;
  }).join('');

  const zip = new JSZip();
  const imageDefaults = [...new Set(media.map((image) => image.extension))]
    .map((extension) => `<Default Extension="${extension}" ContentType="image/${extension === 'jpeg' ? 'jpeg' : extension}"/>`)
    .join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${imageDefaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${media.map((image) => `<Relationship Id="${image.relationship}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.fileName}"/>`).join('\n')}
</Relationships>`);
  for (const image of media) zip.file(`word/media/${image.fileName}`, image.bytes);

  const headingStyles = [1, 2, 3, 4, 5, 6].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[32, 28, 24, 22, 22, 22][level - 1]}"/></w:rPr></w:style>`).join('');
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${headingStyles}
</w:styles>`);

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>
${paragraphs}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body>
</w:document>`);

  return zip.generateAsync({ type: 'blob', mimeType: MIME.docx, compression: 'DEFLATE' });
}

function plainTextToMarkdown(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim() + '\n';
}

async function extractPdfText(file) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('The PDF reader is unavailable — check your connection and reload');
  lib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;

  let pdf;
  try {
    pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (err) {
    throw new Error('This PDF could not be opened: ' + (err && err.message ? err.message : 'invalid file'));
  }

  const pages = [];
  try {
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        if (!item || typeof item.str !== 'string') continue;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) text += '\n';
        else if (text && !/\s$/.test(text) && item.str && !/^\s/.test(item.str)) text += ' ';
        text += item.str;
        if (y !== null) lastY = y;
      }
      pages.push(text.trim());
    }
  } finally {
    if (typeof pdf.destroy === 'function') pdf.destroy();
  }

  return pages.join('\n\n');
}

async function convertDoc(item, target) {
  const base = baseName(item.name);
  let source;
  let raw;

  if (item.ext === 'docx') {
    if (!window.mammoth || typeof window.mammoth.convertToHtml !== 'function') {
      throw new Error('The DOCX reader is unavailable — check your connection and reload');
    }
    const result = await window.mammoth.convertToHtml({ arrayBuffer: await item.file.arrayBuffer() });
    raw = sanitizeHtml(result.value || '<p></p>');
    source = 'html';
  } else if (item.ext === 'pdf') {
    const text = await extractPdfText(item.file);
    if (!text.trim()) {
      throw new Error('This PDF has no text layer — it looks like a scan, and OCR is not available in this browser build');
    }
    raw = text;
    source = 'text';
  } else {
    raw = await item.file.text();
    source = ['md', 'markdown'].includes(item.ext) ? 'markdown' : ['html', 'htm'].includes(item.ext) ? 'html' : 'text';
  }

  const body = docToHtml(raw, source);
  const title = base;

  switch (target) {
    case 'html': {
      const html = buildHtmlDocument(title, body);
      const blob = new Blob([html], { type: 'text/html' });
      return { blob, name: `${base}.html`, size: blob.size, kind: 'doc', text: html, previewHtml: sanitizeHtml(body) };
    }

    case 'md': {
      const markdown = source === 'markdown' ? raw : source === 'html' ? htmlToMarkdown(raw) : plainTextToMarkdown(raw);
      const blob = new Blob([markdown], { type: 'text/markdown' });
      return {
        blob,
        name: `${base}.md`,
        size: blob.size,
        kind: 'doc',
        text: markdown,
        previewHtml: sanitizeHtml(docToHtml(markdown, 'markdown')),
      };
    }

    case 'txt': {
      const text = source === 'text' ? raw : htmlToPlainText(body);
      const blob = new Blob([text], { type: 'text/plain' });
      return { blob, name: `${base}.txt`, size: blob.size, kind: 'doc', text, preview: text.slice(0, 1600) };
    }

    case 'pdf': {
      const blob = await pdfFromHtml(body, title);
      return { blob, name: `${base}.pdf`, size: blob.size, kind: 'doc', preview: htmlToPlainText(body).slice(0, 900) };
    }

    case 'docx': {
      const blob = await buildDocx(body, title);
      return { blob, name: `${base}.docx`, size: blob.size, kind: 'doc', preview: htmlToPlainText(body).slice(0, 900) };
    }

    default:
      throw new Error(`Unsupported document target: ${target}`);
  }
}

/* =============================================================================
   AUDIO / VIDEO CONVERSION (ffmpeg.wasm single-thread core)
   ========================================================================== */

async function fetchAsBlobURL(url, mimeType) {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Could not download ${url.split('/').pop()} (HTTP ${response.status})`);
  const blob = await response.blob();
  return URL.createObjectURL(new Blob([blob], { type: mimeType }));
}

const FFmpegRunner = {
  instance: null,
  loading: null,
  lastProgressAt: 0,

  async ensure() {
    if (this.instance && this.instance.loaded) return this.instance;
    if (this.loading) return this.loading;

    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
      throw new Error('ffmpeg.wasm could not load. Audio and video conversion needs one online visit to fetch the engine (~32 MB)');
    }

    this.loading = (async () => {
      const { FFmpeg } = window.FFmpegWASM;
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => appendLog(message));
      ffmpeg.on('progress', ({ progress }) => {
        const item = state.items.find((candidate) => candidate.id === state.currentId);
        if (!item) return;
        const percent = clamp(Math.round((Number(progress) || 0) * 100), 1, 99);
        const now = performance.now();
        if (now - this.lastProgressAt > 180) {
          this.lastProgressAt = now;
          setItemProgress(item, percent);
        }
      });

      showLog(true);
      appendLog('Loading ffmpeg.wasm single-thread core (~32 MB, cached after first run)…');

      try {
        const [workerURL, coreURL, wasmURL] = await Promise.all([
          fetchAsBlobURL(CDN.ffmpegWorker, 'text/javascript'),
          fetchAsBlobURL(CDN.ffmpegCore, 'text/javascript'),
          fetchAsBlobURL(CDN.ffmpegWasm, 'application/wasm'),
        ]);

        await ffmpeg.load({ classWorkerURL: workerURL, coreURL, wasmURL });
        appendLog('ffmpeg core ready. No SharedArrayBuffer required.');
        this.instance = ffmpeg;
        return ffmpeg;
      } catch (err) {
        appendLog('ffmpeg load failed: ' + (err && err.message ? err.message : err));
        throw new Error('Could not start ffmpeg.wasm (' + (err && err.message ? err.message : 'unknown error') + '). Video/audio conversion needs a network connection for the first load');
      }
    })().catch((err) => {
      this.loading = null;
      throw err;
    });

    return this.loading;
  },
};

function appendLog(line) {
  const output = $('#logOutput');
  if (!output) return;
  const text = String(line == null ? '' : line).replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!text) return;
  state.logs.push(text);
  if (state.logs.length > 400) state.logs.shift();
  output.textContent = state.logs.join('\n');
  output.scrollTop = output.scrollHeight;
}

function showLog(open = true) {
  const panel = $('#logPanel');
  if (!panel) return;
  panel.hidden = !open;
}

function buildFfmpegArgs(item, target) {
  const inputName = `input.${item.ext || 'bin'}`;
  const outputName = `output.${target}`;
  const audioOnly = item.mediaKind === 'audio';
  const args = ['-i', inputName];

  switch (target) {
    case 'mp3':
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k');
      break;
    case 'm4a':
      args.push('-vn', '-c:a', 'aac', '-b:a', '192k');
      break;
    case 'aac':
      args.push('-vn', '-c:a', 'aac', '-b:a', '192k');
      break;
    case 'wav':
      args.push('-vn', '-c:a', 'pcm_s16le', '-ar', '44100');
      break;
    case 'flac':
      args.push('-vn', '-c:a', 'flac');
      break;
    case 'aiff':
      args.push('-vn', '-c:a', 'pcm_s16be');
      break;
    case 'ogg':
      args.push('-vn', '-c:a', 'libvorbis', '-q:a', '5');
      break;
    case 'opus':
      args.push('-vn', '-c:a', 'libopus', '-b:a', '128k');
      break;
    case 'mp4':
      if (audioOnly) {
        args.push('-vn', '-c:a', 'aac', '-b:a', '160k');
      } else {
        args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
      }
      break;
    case 'webm':
      if (audioOnly) {
        args.push('-vn', '-c:a', 'libvorbis', '-q:a', '5');
      } else {
        args.push('-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '6', '-crf', '32', '-b:v', '1M', '-c:a', 'libvorbis', '-q:a', '5');
      }
      break;
    case 'mov':
      if (audioOnly) {
        args.push('-vn', '-c:a', 'aac', '-b:a', '160k');
      } else {
        args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k');
      }
      break;
    case 'mkv':
      if (audioOnly) {
        args.push('-vn', '-c:a', 'aac', '-b:a', '160k');
      } else {
        args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k');
      }
      break;
    case 'gif':
      args.push('-vf', 'fps=10,scale=720:-1:flags=lanczos', '-loop', '0');
      break;
    default:
      throw new Error(`Unsupported media target: ${target}`);
  }

  args.push('-y', outputName);
  return { args, inputName, outputName };
}

async function convertAV(item, target) {
  if (item.file.size > MAX_FFMPEG_BYTES) {
    throw new Error(`This ${fmtBytes(item.size)} file is beyond the safe in-browser ffmpeg limit (~${fmtBytes(MAX_FFMPEG_BYTES)}). Trim or compress it first`);
  }

  const ffmpeg = await FFmpegRunner.ensure();
  const { args, inputName, outputName } = buildFfmpegArgs(item, target);

  state.currentId = item.id;
  item.progress = 2;
  setItemProgress(item, 2);
  appendLog(`$ ffmpeg ${args.filter((value) => value !== '-y').join(' ')}`);

  try {
    const inputData = new Uint8Array(await item.file.arrayBuffer());
    await ffmpeg.writeFile(inputName, inputData);

    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}. Try a different target or a smaller clip`);
    }

    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    if (!bytes || !bytes.length) {
      throw new Error('ffmpeg produced an empty file — the source codec may not be supported by this build');
    }

    const blob = new Blob([bytes], { type: MIME[target] || 'application/octet-stream' });
    appendLog(`Done: ${outputName} (${fmtBytes(blob.size)})`);
    return {
      blob,
      name: `${baseName(item.name)}.${target}`,
      size: blob.size,
      kind: 'av',
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/memory|allocat|out of bounds|OOM/i.test(message)) {
      throw new Error('The browser ran out of memory while transcoding. Try a shorter clip, a smaller resolution, or convert to audio only');
    }
    throw err;
  } finally {
    state.currentId = null;
    try {
      await ffmpeg.deleteFile(inputName);
    } catch (_) {
      /* already gone */
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch (_) {
      /* already gone */
    }
  }
}

async function gzipResult(item) {
  if (typeof CompressionStream !== 'function') {
    throw new Error('This browser cannot create GZIP files — Chrome, Edge, Firefox 113+ or Safari 16.4+ are required');
  }
  try {
    const stream = item.file.stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    const blob = new Blob([buffer], { type: MIME.gz });
    return {
      blob,
      name: `${item.name}.gz`,
      size: blob.size,
      kind: 'archive',
      note: `${fmtBytes(item.size)} → ${fmtBytes(blob.size)}`,
    };
  } catch (err) {
    throw new Error('GZIP compression failed: ' + (err && err.message ? err.message : err));
  }
}

async function convertCompressed(item, target) {
  if (target !== 'gunzip') throw new Error('Unsupported compressed-file action');
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot extract GZIP files — Chrome, Edge, Firefox 113+ or Safari 16.4+ are required');
  }
  let buffer;
  try {
    const stream = item.file.stream().pipeThrough(new DecompressionStream('gzip'));
    buffer = await new Response(stream).arrayBuffer();
  } catch (err) {
    throw new Error('This file could not be decompressed — it may be corrupt or not a GZIP archive');
  }
  const name = item.name.replace(/\.(gz|gzip)$/i, '') || `${baseName(item.name)}.out`;
  const ext = extOf(name);
  const blob = new Blob([buffer], { type: MIME[ext] || 'application/octet-stream' });
  return {
    blob,
    name,
    size: blob.size,
    kind: 'file',
    note: `${fmtBytes(item.size)} → ${fmtBytes(blob.size)} decompressed`,
  };
}

/* =============================================================================
   ARCHIVES (JSZip)
   ========================================================================== */

async function convertArchive(item, target) {
  if (!window.JSZip) throw new Error('JSZip is unavailable — check your connection and reload');

  let zip;
  try {
    zip = await JSZip.loadAsync(await item.file.arrayBuffer());
  } catch (err) {
    throw new Error('This archive could not be read: ' + (err.message || 'invalid ZIP data'));
  }

  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (!files.length) throw new Error('This archive contains no files');

  if (target === 'inspect') {
    const entries = files.slice(0, MAX_ZIP_ENTRIES).map((entry) => ({
      name: entry.name,
      size: Number(entry._data && entry._data.uncompressedSize) || 0,
      file: entry,
    }));
    const total = files.reduce((sum, entry) => sum + (Number(entry._data && entry._data.uncompressedSize) || 0), 0);
    item.entries = entries;
    return {
      blob: null,
      name: item.name,
      size: null,
      kind: 'archive',
      note: `${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(total)} uncompressed`,
      entries,
    };
  }

  if (target === 'zip') {
    const output = new JSZip();
    const used = new Set();
    for (const entry of files) {
      const data = await entry.async('uint8array');
      output.file(uniqueName(entry.name, used), data);
    }
    const blob = await output.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return {
      blob,
      name: `${baseName(item.name)}.repacked.zip`,
      size: blob.size,
      kind: 'archive',
      preview: `${files.length} entries recompressed locally`,
    };
  }

  throw new Error('Unsupported archive action');
}

async function downloadZipEntry(item, index) {
  const entries = (item.result && item.result.entries) || item.entries || [];
  const entry = entries[index];
  if (!entry || !entry.file) {
    toast('That archive entry is no longer available — inspect the ZIP again', 'warn');
    return;
  }
  try {
    const blob = await entry.file.async('blob');
    downloadBlob(blob, entry.name.split('/').pop() || 'file');
  } catch (err) {
    toast('Could not extract that entry: ' + err.message, 'err');
  }
}

async function extractArchive(item) {
  const entries = (item.result && item.result.entries) || item.entries || [];
  if (!entries.length) {
    toast('Inspect the archive first', 'warn');
    return;
  }
  if (!window.JSZip) {
    toast('JSZip is unavailable', 'err');
    return;
  }
  try {
    const zip = new JSZip();
    const used = new Set();
    for (const entry of entries) {
      if (!entry.file) continue;
      const data = await entry.file.async('uint8array');
      zip.file(uniqueName(entry.name, used), data);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, `${baseName(item.name)}-extracted.zip`);
    toast(`${entries.length} files extracted into a new ZIP`, 'ok');
  } catch (err) {
    toast('Extraction failed: ' + err.message, 'err');
  }
}

/* =============================================================================
   HISTORY (localStorage)
   ========================================================================== */

function loadHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.history = Array.isArray(parsed) ? parsed.slice(0, 40) : [];
  } catch (_) {
    state.history = [];
  }
}

function saveHistory() {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 40)));
  } catch (_) {
    /* private mode or quota — history is a nicety */
  }
}

function pushHistory(entry) {
  state.history.unshift(entry);
  if (state.history.length > 40) state.history.length = 40;
  saveHistory();
  renderHistory();
}

function historyIcon(extension) {
  const ext = String(extension || '').toLowerCase();
  if (ext === 'gz' || ext === 'gzip') return 'archive';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'film';
  if (AUDIO_EXTS.has(ext)) return 'music';
  if (DATA_EXTS.has(ext)) return 'table';
  if (DOC_EXTS.has(ext) || ext === 'pdf' || ext === 'docx') return 'file-text';
  if (ext === 'zip') return 'archive';
  return 'file';
}

function renderHistory() {
  const list = $('#historyList');
  const summary = $('#historySummary');
  if (!list) return;

  if (!state.history.length) {
    list.innerHTML = `<div class="history-empty"><i data-lucide="history"></i>No conversions yet. Drop a file to start — this log never leaves your browser.</div>`;
    if (summary) summary.textContent = 'Stored only in this browser.';
    refreshIcons();
    return;
  }

  list.innerHTML = state.history.map((entry) => {
    const saved = entry.inSize && entry.outSize ? Math.round((1 - entry.outSize / entry.inSize) * 100) : null;
    const savings = saved === null ? '' : saved > 0 ? `−${saved}%` : saved < 0 ? `+${Math.abs(saved)}%` : '0%';
    return `
      <div class="history-row">
        <span class="hi-icon"><i data-lucide="${historyIcon(entry.to)}"></i></span>
        <div class="hi-main">
          <div class="hi-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
          <div class="hi-sub">${escapeHtml(entry.from)} → ${escapeHtml(entry.to)} · ${escapeHtml(timeAgo(entry.at))}</div>
        </div>
        <div class="hi-sizes">
          <span>${fmtBytes(entry.inSize)} → ${fmtBytes(entry.outSize)}</span>
          ${savings ? `<span class="badge ${saved > 0 ? 'save' : saved < 0 ? 'grow' : 'ghost'}">${savings}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  if (summary) {
    summary.textContent = `${state.history.length} recent conversion${state.history.length === 1 ? '' : 's'} · stored in localStorage only.`;
  }
  refreshIcons();
}

/* =============================================================================
   DATA & TEXT TOOL
   ========================================================================== */

function b64ToUtf8(base64) {
  const normalized = String(base64 || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function parseScalar(raw) {
  const value = String(raw).trim();
  if (!value) return '';

  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value.replace(/'/g, '"'));
    } catch (_) {
      return value;
    }
  }
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^(false|no|off)$/i.test(value)) return false;
  if (/^(null|~)$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value.replace(/\s+#.*$/, '');
}

function parseYaml(source) {
  const lines = String(source || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() && !/^\s*#/.test(line));

  if (!lines.length) return {};

  let index = 0;
  const indentOf = (line) => (/^\s*/.exec(line) || [''])[0].length;
  const nextMoreIndented = (baseIndent) => index < lines.length && indentOf(lines[index]) > baseIndent;

  const parseBlock = (indent) => {
    const first = lines[index];
    const isList = /^\s*-(\s|$)/.test(first) && indentOf(first) === indent;

    if (isList) {
      const list = [];
      while (index < lines.length) {
        const line = lines[index];
        const match = /^(\s*)-(\s*)(.*)$/.exec(line);
        if (!match || match[1].length !== indent) break;
        const rest = match[3].trim();
        index += 1;

        if (!rest) {
          list.push(nextMoreIndented(indent) ? parseBlock(indentOf(lines[index])) : null);
          continue;
        }

        const keyValue = /^([^:]+):(?:\s+(.*))?$/.exec(rest);
        if (keyValue) {
          const object = {};
          const key = keyValue[1].trim().replace(/^["']|["']$/g, '');
          if (keyValue[2] === undefined || keyValue[2] === '') {
            object[key] = nextMoreIndented(indent) ? parseBlock(indentOf(lines[index])) : null;
          } else {
            object[key] = parseScalar(keyValue[2]);
          }
          while (index < lines.length) {
            const nestedLine = lines[index];
            const nestedMatch = /^(\s*)([^:]+):(?:\s+(.*))?$/.exec(nestedLine);
            if (!nestedMatch || nestedMatch[1].length <= indent) break;
            index += 1;
            const nestedKey = nestedMatch[2].trim().replace(/^["']|["']$/g, '');
            if (nestedMatch[3] === undefined || nestedMatch[3] === '') {
              object[nestedKey] = nextMoreIndented(indent) ? parseBlock(indentOf(lines[index])) : null;
            } else {
              object[nestedKey] = parseScalar(nestedMatch[3]);
            }
          }
          list.push(object);
        } else {
          list.push(parseScalar(rest));
        }
      }
      return list;
    }

    const object = {};
    while (index < lines.length) {
      const line = lines[index];
      const match = /^(\s*)([^:]+):(?:\s+(.*))?$/.exec(line);
      if (!match || match[1].length !== indent) break;
      index += 1;
      const key = match[2].trim().replace(/^["']|["']$/g, '');
      if (match[3] === undefined || match[3] === '') {
        object[key] = nextMoreIndented(indent) ? parseBlock(indentOf(lines[index])) : null;
      } else {
        object[key] = parseScalar(match[3]);
      }
    }
    return object;
  };

  const result = parseBlock(indentOf(lines[0]));
  if (index < lines.length) {
    throw new Error('Could not parse YAML near: ' + lines[index].trim().slice(0, 48));
  }
  return result;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (!text) return '""';
  if (/^[\s]|[\s]$|[:#\-?&*!|>'"%@`{}\[\],]|^(true|false|yes|no|null|~|-?\d)/i.test(text) || text.includes('\n')) {
    return JSON.stringify(text);
  }
  return text;
}

function toYaml(value, depth = 0) {
  const pad = '  '.repeat(depth);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((entry) => {
      if (entry && typeof entry === 'object') {
        if (Array.isArray(entry)) return `${pad}- ${toYaml(entry, depth + 1).trimStart()}`;
        const keys = Object.keys(entry);
        if (!keys.length) return `${pad}- {}`;
        const [firstKey, ...restKeys] = keys;
        const firstValue = entry[firstKey];
        const firstLine = firstValue && typeof firstValue === 'object'
          ? `${pad}- ${firstKey}:\n${toYaml(firstValue, depth + 2)}`
          : `${pad}- ${firstKey}: ${yamlScalar(firstValue)}`;
        const rest = restKeys.map((key) => {
          const nested = entry[key];
          return nested && typeof nested === 'object'
            ? `${pad}  ${key}:\n${toYaml(nested, depth + 2)}`
            : `${pad}  ${key}: ${yamlScalar(nested)}`;
        }).join('\n');
        return rest ? `${firstLine}\n${rest}` : firstLine;
      }
      return `${pad}- ${yamlScalar(entry)}`;
    }).join('\n');
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return keys.map((key) => {
      const nested = value[key];
      if (nested && typeof nested === 'object') {
        return `${pad}${key}:\n${toYaml(nested, depth + 1)}`;
      }
      return `${pad}${key}: ${yamlScalar(nested)}`;
    }).join('\n');
  }

  return `${pad}${yamlScalar(value)}`;
}

function decodeJwt(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length < 2) throw new Error('This does not look like a JWT (expected header.payload.signature)');

  let header;
  let payload;
  try {
    header = JSON.parse(b64ToUtf8(parts[0]));
  } catch (_) {
    throw new Error('The JWT header is not valid base64url JSON');
  }
  try {
    payload = JSON.parse(b64ToUtf8(parts[1]));
  } catch (_) {
    throw new Error('The JWT payload is not valid base64url JSON');
  }

  const result = { header, payload, signature: parts[2] || '' };

  if (payload && typeof payload === 'object' && payload.exp) {
    const expiresAt = new Date(payload.exp * 1000);
    result.expiresAt = expiresAt.toISOString();
    result.expired = expiresAt.getTime() < Date.now();
  }
  if (payload && typeof payload === 'object' && payload.iat) {
    result.issuedAt = new Date(payload.iat * 1000).toISOString();
  }

  return result;
}

function parseDataText(raw, format) {
  switch (format) {
    case 'json': {
      const value = JSON.parse(raw);
      const count = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
      return { value, note: Array.isArray(value) ? `${count} items` : `${count} keys` };
    }
    case 'csv':
    case 'tsv': {
      if (!window.Papa) throw new Error('PapaParse is unavailable — check your connection');
      const parsed = Papa.parse(raw.trim(), {
        header: true,
        skipEmptyLines: 'greedy',
        delimiter: format === 'tsv' ? '\t' : undefined,
      });
      if (parsed.errors && parsed.errors.length && !parsed.data.length) {
        throw new Error(parsed.errors[0].message);
      }
      const table = normalizeRows(parsed.data.map(flattenRow));
      return { value: table.rows, note: `${table.rows.length} rows × ${table.fields.length} cols` };
    }
    case 'yaml': {
      const value = parseYaml(raw);
      const count = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
      return { value, note: `${count} ${Array.isArray(value) ? 'items' : 'keys'}` };
    }
    case 'xml': {
      const value = parseXml(raw);
      const count = value && typeof value === 'object' ? Object.keys(value).length : 1;
      return { value, note: `${count} node${count === 1 ? '' : 's'}` };
    }
    case 'ndjson': {
      const lines = raw.split(/\r?\n/).filter((line) => line.trim());
      if (!lines.length) throw new Error('This NDJSON input has no records');
      const rows = lines.map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw new Error(`Invalid NDJSON on line ${index + 1}: ${err.message}`);
        }
      });
      return { value: rows, note: `${rows.length} record${rows.length === 1 ? '' : 's'}` };
    }
    case 'base64': {
      const decoded = b64ToUtf8(raw);
      try {
        return { value: JSON.parse(decoded), note: 'base64 → JSON' };
      } catch (_) {
        return { value: decoded, note: `${decoded.length} chars` };
      }
    }
    case 'url': {
      const decoded = decodeURIComponent(raw.trim());
      try {
        return { value: JSON.parse(decoded), note: 'URL-decoded JSON' };
      } catch (_) {
        return { value: decoded, note: `${decoded.length} chars` };
      }
    }
    case 'jwt': {
      const value = decodeJwt(raw);
      return { value, note: value.expired ? 'decoded · token expired' : 'decoded locally' };
    }
    default:
      throw new Error('Unsupported input format');
  }
}

function toDelimited(value, delimiter) {
  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      const table = normalizeRows(value.map(flattenRow));
      return rowsToCsv(table.rows, table.fields, delimiter);
    }
    return value.map((entry) => (entry && typeof entry === 'object' ? JSON.stringify(entry) : String(entry == null ? '' : entry)))
      .map((cell) => (/[",\n\r]/.test(cell) || cell.includes(delimiter) ? `"${cell.replace(/"/g, '""')}"` : cell))
      .join(delimiter);
  }
  if (value && typeof value === 'object') {
    return rowsToCsv(
      Object.entries(value).map(([key, entry]) => ({ key, value: entry && typeof entry === 'object' ? JSON.stringify(entry) : entry })),
      ['key', 'value'],
      delimiter
    );
  }
  return String(value == null ? '' : value);
}

function stringifyDataValue(value, format, pretty) {
  switch (format) {
    case 'json':
      return JSON.stringify(value, null, pretty ? 2 : 0);
    case 'yaml':
      return toYaml(value);
    case 'xml':
      return valueToXml(value, 'data');
    case 'ndjson':
      return Array.isArray(value)
        ? value.map((entry) => JSON.stringify(entry)).join('\n')
        : JSON.stringify(value);
    case 'csv':
      return toDelimited(value, ',');
    case 'tsv':
      return toDelimited(value, '\t');
    case 'base64':
      return utf8ToB64(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    case 'url':
      return encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : 0));
    case 'sql': {
      if (Array.isArray(value) && value.length && value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
        const table = normalizeRows(value.map(flattenRow));
        return rowsToSql(table.rows, table.fields.length ? table.fields : ['value'], 'converted_data');
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const rows = Object.entries(value).map(([key, entry]) => ({
          key,
          value: entry && typeof entry === 'object' ? JSON.stringify(entry) : entry,
        }));
        return rowsToSql(rows, ['key', 'value'], 'converted_data');
      }
      return rowsToSql([{ value }], ['value'], 'converted_data');
    }
    case 'html': {
      if (Array.isArray(value) && value.length && value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
        const table = normalizeRows(value.map(flattenRow));
        return rowsToHtml(table.rows, table.fields.length ? table.fields : ['value'], 'Converted data');
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const rows = Object.entries(value).map(([key, entry]) => ({
          key,
          value: entry && typeof entry === 'object' ? JSON.stringify(entry) : entry,
        }));
        return rowsToHtml(rows, ['key', 'value'], 'Converted data');
      }
      return rowsToHtml([{ value }], ['value'], 'Converted data');
    }
    default:
      throw new Error('Unsupported output format');
  }
}

function convertDataTool() {
  const input = $('#dataInput');
  const output = $('#dataOutput');
  const status = $('#dataStatus');
  if (!input || !output || !status) return;

  const raw = input.value;
  $('#dataInMeta').textContent = fmtBytes(new Blob([raw]).size);

  if (!raw.trim()) {
    output.value = '';
    $('#dataOutMeta').textContent = '';
    status.textContent = 'Ready';
    status.style.color = '';
    return;
  }

  const inFormat = $('#dataInFmt').value;
  const outFormat = $('#dataOutFmt').value;

  try {
    const parsed = parseDataText(raw, inFormat);
    const text = stringifyDataValue(parsed.value, outFormat, state.pretty);
    output.value = text;
    $('#dataOutMeta').textContent = `${fmtBytes(new Blob([text]).size)} · ${outFormat.toUpperCase()}`;
    status.textContent = `✓ ${inFormat.toUpperCase()} → ${outFormat.toUpperCase()}${parsed.note ? ` · ${parsed.note}` : ''}`;
    status.style.color = '#5eead4';
  } catch (err) {
    output.value = '';
    $('#dataOutMeta').textContent = '';
    status.textContent = '✕ ' + (err.message || 'Could not convert this input');
    status.style.color = '#fca5a5';
  }
}

/* =============================================================================
   UNIT & COLOUR TOOLS
   ========================================================================== */

function cssPxPerUnit(unit) {
  const remBase = clamp(parseFloat($('#cssRemBase').value) || 16, 1, 200);
  const viewport = clamp(parseFloat($('#cssViewport').value) || 1440, 1, 100000);
  switch (unit) {
    case 'px':
      return 1;
    case 'rem':
    case 'em':
      return remBase;
    case 'pt':
      return 96 / 72;
    case 'vw':
      return viewport / 100;
    case '%':
      return remBase / 100;
    default:
      return 1;
  }
}

function syncCss(sourceUnit, value, sourceElement) {
  const px = value * cssPxPerUnit(sourceUnit);
  $$('.unit-input[data-group="css"]').forEach((element) => {
    if (element === sourceElement) return;
    element.value = Number.isFinite(px) ? fmtNum(px / cssPxPerUnit(element.dataset.unit)) : '';
  });
}

function initUnits() {
  $$('.unit-input').forEach((input) => {
    input.addEventListener('input', () => {
      const group = input.dataset.group;
      const unit = input.dataset.unit;
      const value = parseFloat(String(input.value).replace(',', '.'));
      if (!Number.isFinite(value)) {
        $$(`.unit-input[data-group="${group}"]`).forEach((other) => {
          if (other !== input) other.value = '';
        });
        return;
      }
      if (group === 'css') {
        syncCss(unit, value, input);
        return;
      }
      const factors = UNIT_GROUPS[group];
      if (!factors) return;
      const base = value * factors[unit];
      $$(`.unit-input[data-group="${group}"]`).forEach((other) => {
        if (other === input) return;
        other.value = fmtNum(base / factors[other.dataset.unit]);
      });
    });
  });

  ['#cssRemBase', '#cssViewport'].forEach((selector) => {
    const input = $(selector);
    if (!input) return;
    input.addEventListener('input', () => {
      const pxInput = $('.unit-input[data-group="css"][data-unit="px"]');
      const value = parseFloat(pxInput && pxInput.value);
      if (Number.isFinite(value)) syncCss('px', value, pxInput);
    });
  });

  const megabyte = $('.unit-input[data-group="storage"][data-unit="MB"]');
  if (megabyte) {
    megabyte.value = '1';
    megabyte.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const pixels = $('.unit-input[data-group="css"][data-unit="px"]');
  if (pixels) {
    pixels.value = '16';
    pixels.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function parseHexColor(value) {
  let hex = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((character) => character + character).join('');
  if (/^[0-9a-f]{4}$/i.test(hex)) hex = hex.slice(0, 3).split('').map((character) => character + character).join('');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  if (/^[0-9a-f]{8}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

function rgbToHex(r, g, b) {
  const toHex = (channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r, g, b) {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) * 60;
    else if (max === green) hue = ((blue - red) / delta + 2) * 60;
    else hue = ((red - green) / delta + 4) * 60;
  }

  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function hslToRgb(hue, saturation, lightness) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;

  if (s === 0) {
    const channel = Math.round(l * 255);
    return { r: channel, g: channel, b: channel };
  }

  const hueToChannel = (p, q, t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, h) * 255),
    b: Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  };
}

function relativeLuminance(r, g, b) {
  const channels = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function initColor() {
  const hexInput = $('#colorHex');
  const rInput = $('#colorR');
  const gInput = $('#colorG');
  const bInput = $('#colorB');
  const hInput = $('#colorH');
  const sInput = $('#colorS');
  const lInput = $('#colorL');
  const picker = $('#colorPicker');
  if (!hexInput || !rInput || !hInput || !picker) return;

  const apply = (r, g, b, source) => {
    const red = clamp(Math.round(r), 0, 255);
    const green = clamp(Math.round(g), 0, 255);
    const blue = clamp(Math.round(b), 0, 255);
    const hsl = rgbToHsl(red, green, blue);
    const hex = rgbToHex(red, green, blue);

    if (source !== 'hex') hexInput.value = hex.toUpperCase();
    if (source !== 'rgb') {
      rInput.value = red;
      gInput.value = green;
      bInput.value = blue;
    }
    if (source !== 'hsl') {
      hInput.value = String(Math.round(hsl.h));
      sInput.value = String(Math.round(hsl.s));
      lInput.value = String(Math.round(hsl.l));
    }

    picker.value = hex;
    $('#colorSwatch').style.background = `rgb(${red}, ${green}, ${blue})`;
    const label = $('#colorHexLabel');
    label.textContent = hex.toUpperCase();
    label.style.color = relativeLuminance(red, green, blue) > 0.5 ? '#0f172a' : '#f8fafc';
    $('#colorCss').textContent = `rgb(${red} ${green} ${blue}) · hsl(${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%)`;
  };

  hexInput.addEventListener('input', () => {
    const rgb = parseHexColor(hexInput.value);
    if (rgb) apply(rgb.r, rgb.g, rgb.b, 'hex');
  });
  hexInput.addEventListener('blur', () => {
    const rgb = parseHexColor(hexInput.value);
    if (rgb) hexInput.value = rgbToHex(rgb.r, rgb.g, rgb.b).toUpperCase();
  });

  [rInput, gInput, bInput].forEach((input) => input.addEventListener('input', () => {
    apply(Number(rInput.value) || 0, Number(gInput.value) || 0, Number(bInput.value) || 0, 'rgb');
  }));

  [hInput, sInput, lInput].forEach((input) => input.addEventListener('input', () => {
    const rgb = hslToRgb(Number(hInput.value) || 0, Number(sInput.value) || 0, Number(lInput.value) || 0);
    apply(rgb.r, rgb.g, rgb.b, 'hsl');
  }));

  picker.addEventListener('input', () => {
    const rgb = parseHexColor(picker.value);
    if (rgb) apply(rgb.r, rgb.g, rgb.b, 'picker');
  });

  const copyButton = $('#colorCopy');
  if (copyButton) {
    copyButton.addEventListener('click', () => copyText($('#colorCss').textContent));
  }

  apply(35, 131, 226, 'init');
}

/* =============================================================================
   VIEW SWITCHING & EVENT WIRING
   ========================================================================== */

function switchView(view) {
  const changed = state.view !== view;
  state.view = view;
  $$('.mode-btn').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  $$('.view').forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });
  if (changed) window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function pasteFromClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    toast('Clipboard API unavailable — press Ctrl+V instead', 'warn');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    const extensions = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
      'image/svg+xml': 'svg',
    };
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], `pasted-${Date.now()}.${extensions[type] || 'png'}`, { type }));
      }
    }
    if (!files.length) throw new Error('No image found on the clipboard');
    addFiles(files);
  } catch (_) {
    toast('Clipboard read failed — press Ctrl+V to paste an image instead', 'warn');
  }
}

function bindNavigation() {
  $$('.mode-btn').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
}

function bindDropzone() {
  const dropzone = $('#dropzone');
  const input = $('#fileInput');
  if (!dropzone || !input) return;

  $('#browseBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    input.click();
  });
  $('#pasteBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    pasteFromClipboard();
  });

  dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input')) return;
    input.click();
  });
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });

  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });

  const isFileDrag = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files');
  let dragDepth = 0;

  window.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-dragging');
    dropzone.classList.add('is-dragover');
  });

  window.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      document.body.classList.remove('is-dragging');
      dropzone.classList.remove('is-dragover');
    }
  });

  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    dropzone.classList.remove('is-dragover');
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      addFiles(event.dataTransfer.files);
    }
  });
}

function bindPaste() {
  window.addEventListener('paste', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const files = Array.from(clipboard.files || []);
    if (!files.length) {
      Array.from(clipboard.items || []).forEach((item) => {
        if (item.kind !== 'file') return;
        const file = item.getAsFile();
        if (file) files.push(file);
      });
    }
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });
}

function bindQueue() {
  const list = $('#queueList');
  if (!list) return;

  list.addEventListener('click', async (event) => {
    const card = event.target.closest('.file-card');
    if (!card) return;
    const item = state.items.find((entry) => entry.id === card.dataset.id);
    if (!item) return;
    const button = event.target.closest('[data-act]');
    if (!button) return;

    switch (button.dataset.act) {
      case 'remove':
        removeItem(item);
        break;

      case 'target': {
        if (state.busy) {
          toast('Wait for the current conversion to finish', 'warn');
          break;
        }
        if (item.result && item.result.url) URL.revokeObjectURL(item.result.url);
        item.target = button.dataset.target;
        item.status = 'queued';
        item.result = null;
        item.error = null;
        item.progress = 0;
        renderQueue();
        break;
      }

      case 'convert':
        await convertSingle(item);
        break;

      case 'hash':
        await computeHashesForItem(item);
        break;

      case 'copy-hash':
        if (item.hash) await copyText(item.hash[button.dataset.hash]);
        break;

      case 'copy-result':
        if (item.result) await copyText(item.result.text || item.result.preview || '');
        break;

      case 'zip-entry':
        await downloadZipEntry(item, Number(button.dataset.index));
        break;

      case 'extract-zip':
        await extractArchive(item);
        break;

      default:
        break;
    }
  });
}

function syncQualityUI() {
  const range = $('#quality');
  const output = $('#qualityVal');
  if (!range || !output) return;
  const value = Number(range.value);
  output.textContent = `${value}%`;
  range.style.background = `linear-gradient(90deg, #2383e2 0%, #2383e2 ${value}%, #373737 ${value}%)`;
}

function bindOptions() {
  const quality = $('#quality');
  if (quality) quality.addEventListener('input', syncQualityUI);

  const convertButton = $('#convertAll');
  if (convertButton) convertButton.addEventListener('click', convertAll);

  const clearQueue = $('#clearQueue');
  if (clearQueue) {
    clearQueue.addEventListener('click', () => {
      if (state.busy) {
        toast('Wait for the current conversion to finish', 'warn');
        return;
      }
      state.items.forEach((item) => {
        if (item.result && item.result.url) URL.revokeObjectURL(item.result.url);
      });
      state.items = [];
      renderQueue();
      toast('Queue cleared', 'info');
    });
  }

  const zipOriginals = $('#zipOriginals');
  if (zipOriginals) zipOriginals.addEventListener('click', () => bundleZip('originals'));

  const downloadZip = $('#downloadZip');
  if (downloadZip) downloadZip.addEventListener('click', () => bundleZip('results'));
}

function bindLogControls() {
  const toggle = $('#logToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const panel = $('#logPanel');
      showLog(Boolean(panel && panel.hidden));
    });
  }

  const close = $('#logClose');
  if (close) close.addEventListener('click', () => showLog(false));

  const clear = $('#logClear');
  if (clear) {
    clear.addEventListener('click', () => {
      state.logs = [];
      const output = $('#logOutput');
      if (output) output.textContent = '';
    });
  }
}

function bindDataTool() {
  const input = $('#dataInput');
  if (!input) return;

  input.addEventListener('input', debounce(convertDataTool, 160));
  $('#dataInFmt').addEventListener('change', convertDataTool);
  $('#dataOutFmt').addEventListener('change', convertDataTool);

  $('#dataFormat').addEventListener('click', () => {
    state.pretty = true;
    convertDataTool();
  });
  $('#dataMinify').addEventListener('click', () => {
    state.pretty = false;
    convertDataTool();
  });

  $('#dataSample').addEventListener('click', () => {
    input.value = SAMPLE_JSON;
    $('#dataInFmt').value = 'json';
    $('#dataOutFmt').value = 'csv';
    convertDataTool();
  });

  $('#dataClear').addEventListener('click', () => {
    input.value = '';
    $('#dataOutput').value = '';
    $('#dataOutMeta').textContent = '';
    $('#dataInMeta').textContent = '0 B';
    $('#dataStatus').textContent = 'Ready';
    $('#dataStatus').style.color = '';
    input.focus();
  });

  $('#dataCopy').addEventListener('click', () => copyText($('#dataOutput').value));

  $('#dataDownload').addEventListener('click', () => {
    const text = $('#dataOutput').value;
    if (!text) {
      toast('Nothing to download yet', 'warn');
      return;
    }
    const format = $('#dataOutFmt').value;
    const extension = { json: 'json', csv: 'csv', tsv: 'tsv', yaml: 'yml', base64: 'txt', url: 'txt', sql: 'sql', html: 'html' }[format] || 'txt';
    downloadBlob(new Blob([text], { type: MIME[format] || 'text/plain' }), `converted.${extension}`);
  });

  $('#dataSwap').addEventListener('click', () => {
    const inSelect = $('#dataInFmt');
    const outSelect = $('#dataOutFmt');
    const previousIn = inSelect.value;
    const previousOut = outSelect.value;
    const canBeInput = Array.from(inSelect.options).some((option) => option.value === previousOut);
    if (!canBeInput) {
      toast(`${previousOut.toUpperCase()} cannot be used as input`, 'warn');
      return;
    }
    inSelect.value = previousOut;
    outSelect.value = Array.from(outSelect.options).some((option) => option.value === previousIn) ? previousIn : 'json';
    if ($('#dataOutput').value) input.value = $('#dataOutput').value;
    convertDataTool();
  });
}

function bindHistoryControls() {
  const clear = $('#clearHistory');
  if (!clear) return;
  clear.addEventListener('click', () => {
    state.history = [];
    saveHistory();
    renderHistory();
    toast('Local conversion history cleared', 'ok');
  });
}

/* =============================================================================
   THEME
   ========================================================================== */

const THEME_KEY = 'convert.theme.v1';

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const button = $('#themeToggle');
  if (button) {
    button.innerHTML = `<i data-lucide="${next === 'light' ? 'moon' : 'sun'}"></i>`;
    button.title = next === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(next === 'light'));
  }
  refreshIcons();
}

function initTheme() {
  let saved = 'dark';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'dark';
  } catch (_) {
    saved = 'dark';
  }
  applyTheme(saved === 'light' ? 'light' : 'dark');

  const button = $('#themeToggle');
  if (!button) return;
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {
      /* private mode — theme is a nicety */
    }
    applyTheme(next);
  });
}

/* =============================================================================
   BOOT
   ========================================================================== */

function init() {
  loadHistory();
  renderHistory();

  bindNavigation();
  bindDropzone();
  bindPaste();
  bindQueue();
  bindOptions();
  bindLogControls();
  bindDataTool();
  bindHistoryControls();
  initTheme();

  initUnits();
  initColor();
  syncQualityUI();

  refreshIcons();
  renderQueue();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

