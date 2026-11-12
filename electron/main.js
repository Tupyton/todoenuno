// Desktop app: serves the built site from this computer and adds what a browser tab cannot do
// by itself (downloading with yt-dlp, choosing a screen to record).
import { app, BrowserWindow, desktopCapturer, Menu, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { createBrotliDecompress } from 'node:zlib';
import { createDownloadHandler } from '../server/downloader.js';

// A fixed port keeps the page's address the same on every start, and with it the saved
// favourites, recent tools and theme. If something else has it, any free port will do for this run.
const PORT = 47823;
const DIST = join(app.getAppPath(), 'dist');
const WASM = '/ffmpeg/ffmpeg-core.wasm';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * Where yt-dlp and ffmpeg are. The Windows build ships them in resources/bin; elsewhere, and when
 * running from source, the ones installed on the system are used.
 */
async function downloadTools() {
  const bundled = join(process.resourcesPath, 'bin');
  if (!app.isPackaged || !existsSync(join(bundled, 'yt-dlp.exe'))) return {};
  // yt-dlp goes stale quickly and updates itself in place, so it lives where the user can write.
  const ytDlp = join(app.getPath('userData'), 'yt-dlp.exe');
  if (!existsSync(ytDlp)) {
    await mkdir(app.getPath('userData'), { recursive: true });
    await copyFile(join(bundled, 'yt-dlp.exe'), ytDlp);
  }
  // Best effort: without a connection the current version keeps working.
  spawn(ytDlp, ['-U'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  return { ytDlp, ffmpegLocation: bundled };
}

function sendFile(url, res) {
  const path = normalize(join(DIST, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!path.startsWith(DIST + sep) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  const file = createReadStream(path).on('error', () => res.destroy());
  // The FFmpeg core is stored Brotli-compressed (see scripts/ffmpeg-core.mjs).
  if (url.pathname === WASM) file.pipe(createBrotliDecompress()).pipe(res);
  else file.pipe(res);
}

function startServer(download) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      // Only this app's own page: a website open in the user's browser must not reach this server.
      if (req.headers.host !== `127.0.0.1:${port}`) return res.writeHead(403).end();
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin !== origin) return res.writeHead(403).end();
        if (req.method === 'POST' && url.pathname === '/api/download') return download(req, res);
        return res.writeHead(404).end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
      sendFile(url, res);
    });
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      server.once('error', reject).listen(0, '127.0.0.1');
    });
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.listen(PORT, '127.0.0.1');
  });
}

function openWindow(origin) {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#0e1016',
    title: 'TodoEnUno',
    icon: join(DIST, 'icon-512.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const external = (url) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url);
  };
  // Links to other sites open in the user's browser; this window only ever shows the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    external(url);
  });
  window.loadURL(origin);
}

// A second start focuses the window that is already open: two copies would fight over the port.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Screen recording: Electron has no built-in picker, so the recorder gets the main screen.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then(([screen]) => callback(screen ? { video: screen } : {}))
        .catch(() => callback({}));
    });
    openWindow(await startServer(createDownloadHandler(await downloadTools())));
  });
}
