// Local downloads for TodoEnUno: runs yt-dlp on this machine and hands the file to the page.
// As a server for the site in a browser: `npm run downloader` (listens on 127.0.0.1 only).
// The desktop app (electron/main.js) uses createDownloadHandler() on its own server instead.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = 47821;
const MAX_BODY = 4096;

// Only these pages may use the server; any other website calling it is refused.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'https://todoenunoapp.netlify.app',
  ...(process.env.TODOENUNO_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
]);

const HEIGHTS = new Set(['2160', '1440', '1080', '720', '480', '360']);

function ytDlpArgs({ kind, quality }, dir) {
  const common = ['--no-playlist', '--no-progress', '--no-warnings', '--restrict-filenames', '-o', join(dir, '%(title).100B.%(ext)s')];
  if (kind === 'audio') return [...common, '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  const limit = HEIGHTS.has(quality) ? `[height<=${quality}]` : '';
  return [...common, '-f', `bv*${limit}+ba/b${limit}/b`, '--merge-output-format', 'mp4'];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    child.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? 'yt-dlp no está instalado en este equipo.' : error.message)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const lines = stderr.trim().split('\n');
      reject(new Error(lines.findLast((line) => line.startsWith('ERROR')) || lines.at(-1) || `yt-dlp terminó con código ${code}`));
    });
  });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('Petición demasiado grande.');
  }
  return JSON.parse(body);
}

function parseRequest(data) {
  let url;
  try {
    url = new URL(String(data.url));
  } catch {
    throw new Error('La URL no es válida.');
  }
  // http(s) only: keeps yt-dlp away from local files and other schemes.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Solo se admiten URL http o https.');
  return { url: url.href, kind: data.kind === 'audio' ? 'audio' : 'video', quality: String(data.quality || '') };
}

/**
 * Returns the handler for POST /download. `ytDlp` is the program to run; `ffmpegLocation` is the folder
 * with ffmpeg and ffprobe when they are not on the PATH (the desktop app ships its own).
 */
export function createDownloadHandler({ ytDlp = 'yt-dlp', ffmpegLocation } = {}) {
  const extra = ffmpegLocation ? ['--ffmpeg-location', ffmpegLocation] : [];
  return async function download(req, res) {
    let dir;
    try {
      const request = parseRequest(await readJson(req));
      dir = await mkdtemp(join(tmpdir(), 'todoenuno-'));
      // `--` ends the options, so the URL can never be read as a yt-dlp flag.
      await run(ytDlp, [...ytDlpArgs(request, dir), ...extra, '--', request.url]);
      const [name] = await readdir(dir);
      if (!name) throw new Error('yt-dlp no produjo ningún archivo.');
      const path = join(dir, name);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': (await stat(path)).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      await new Promise((resolve, reject) => createReadStream(path).on('error', reject).on('close', resolve).pipe(res));
    } catch (error) {
      if (res.headersSent) res.destroy();
      else res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}

function serve() {
  const download = createDownloadHandler();
  createServer((req, res) => {
    const origin = req.headers.origin;
    if (!ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Origen no permitido.' }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    // Chrome asks this before letting a public page reach a local address.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') res.writeHead(204).end();
    else if (req.method === 'GET' && req.url === '/health') res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    else if (req.method === 'POST' && req.url === '/download') download(req, res);
    else res.writeHead(404).end();
  }).listen(PORT, '127.0.0.1', () => console.log(`Servidor de descargas en http://127.0.0.1:${PORT}`));
}

// Only when run as a program, not when the desktop app imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
