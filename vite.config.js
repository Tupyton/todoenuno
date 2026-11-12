import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig } from 'vite';

// public/ffmpeg/ffmpeg-core.wasm is stored Brotli-compressed; Netlify gets the header from public/_headers.
const brotliWasm = (server) => {
  server.middlewares.use((req, res, next) => {
    if (req.url.startsWith('/ffmpeg/ffmpeg-core.wasm')) res.setHeader('Content-Encoding', 'br');
    next();
  });
};

const WASM = '/ffmpeg/ffmpeg-core.wasm';
// Only needed by the archive extractor: cached the first time it is used, not on every visit.
const ARCHIVE_WASM = '/libarchive/libarchive.wasm';

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/**
 * Writes dist/sw.js: precaches every built file so the app works offline.
 * The FFmpeg wasm (7 MB) and the archive one (1 MB) are left out and cached the first time a tool loads them.
 */
function serviceWorker() {
  return {
    name: 'service-worker',
    apply: 'build',
    closeBundle() {
      const dist = 'dist';
      const hash = createHash('sha256');
      const files = walk(dist)
        .map((path) => {
          hash.update(path).update(readFileSync(path));
          return `/${relative(dist, path).split('\\').join('/')}`;
        })
        .filter((url) => url !== WASM && url !== ARCHIVE_WASM && url !== '/_headers' && url !== '/sw.js')
        .map((url) => (url === '/index.html' ? '/' : url));
      const cache = `todoenuno-${hash.digest('hex').slice(0, 12)}`;
      writeFileSync(
        join(dist, 'sw.js'),
        `const CACHE = ${JSON.stringify(cache)};
const FFMPEG = 'todoenuno-ffmpeg-0.12.10';
const FILES = ${JSON.stringify(files)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== FFMPEG).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function cached(request, cacheName, key = request) {
  const cache = await caches.open(cacheName);
  // Files are identical for every origin, whatever a server's Vary header says.
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(key, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === ${JSON.stringify(WASM)}) event.respondWith(cached(request, FFMPEG));
  else if (request.mode === 'navigate') event.respondWith(cached(request, CACHE, '/'));
  else event.respondWith(cached(request, CACHE));
});
`,
      );
    },
  };
}

export default defineConfig({
  // @ffmpeg/ffmpeg starts its own module worker; pre-bundling breaks that worker's URL.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  // The worker loads the ESM build of ffmpeg-core with a dynamic import.
  worker: { format: 'es' },
  plugins: [{ name: 'brotli-wasm', configureServer: brotliWasm, configurePreviewServer: brotliWasm }, serviceWorker()],
});
