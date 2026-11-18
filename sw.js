/* Convert — offline service worker.
   Caches the app shell and conversion engines so the app keeps working
   without a network connection after the first visit. */

const VERSION = 'convert-v1';
const CACHE = `convert-runtime-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

const ENGINES = [
  'https://cdn.jsdelivr.net/npm/lucide@1.74.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js',
];

const RUNTIME_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One failed asset must not abort the whole install (CDN hiccups,
    // blocked fonts, or a new ffmpeg worker filename).
    await Promise.all([...SHELL, ...ENGINES].map(async (url) => {
      try {
        const request = new Request(url, { mode: 'cors', credentials: 'omit' });
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') await cache.put(request, response);
      } catch (_) {
        /* cache what we can; the fetch handler fills gaps later */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('convert-runtime-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match(new URL('./index.html', self.location.href).href);
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});
