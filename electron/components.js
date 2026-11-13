// Optional programs and models of the desktop app. They would make the installer several hundred MB
// bigger, so each one is downloaded the first time a tool needs it, checked against a fixed SHA-256
// and kept in the user's folder. The files are published in this project's "componentes" release.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://github.com/Tupyton/todoenuno/releases/download/componentes';

/** name: { file, sha256, size }. Zips are extracted to a folder with the component's name. */
export const COMPONENTS = {
  whisper: { file: 'whisper.zip', size: 3920584, sha256: '48a99fdc6527e06753ebdbaad5875609bd446c537912471a5d489bfabfbab904' },
  'whisper-base': { file: 'whisper-base.bin', size: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
  'whisper-small': { file: 'whisper-small.bin', size: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  realesrgan: { file: 'realesrgan.zip', size: 41318444, sha256: '790eb71b4e41dedb7120bf8263caff664da9a6c80c239586f6583eb2b4ef6a4d' },
  ghostscript: { file: 'ghostscript.zip', size: 13919788, sha256: '9e95d0e4acf3c6ec5f3f096c731bb6f9df9a5c42b741961c5f6e08d0c5cc2578' },
  ort: { file: 'ort.zip', size: 3826595, sha256: '8335256f0fb6ec9d7687f976fa144aeb99096f13c70cd6f120dc0e943a133b42' },
  silueta: { file: 'silueta.onnx', size: 44173029, sha256: '75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb' },
};

const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

export function createComponents(folder) {
  /** name → { received, total, promise } while downloading. */
  const downloads = new Map();
  const zip = (name) => COMPONENTS[name].file.endsWith('.zip');

  /** Where a component lives once installed: its folder (zips) or its file. */
  const path = (name) => join(folder, zip(name) ? name : COMPONENTS[name].file);
  const installed = (name) => existsSync(path(name));

  /** Extracts with the tar.exe Windows 10 and later include (it reads zips), or unzip elsewhere. */
  function unzip(file, to) {
    const [command, args] =
      process.platform === 'win32'
        ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', to]]
        : ['unzip', ['-oq', file, '-d', to]];
    return new Promise((resolve, reject) => {
      spawn(command, args, { stdio: 'ignore', windowsHide: true })
        .on('error', reject)
        .on('close', (code) => (code === 0 ? resolve() : reject(new Error(`No se pudo descomprimir (código ${code}).`))));
    });
  }

  async function download(name, state) {
    const { file, sha256, size } = COMPONENTS[name];
    await mkdir(folder, { recursive: true });
    const partial = join(folder, `${file}.parcial`);
    const response = await fetch(`${BASE}/${file}`);
    if (!response.ok) throw new Error(`No se pudo descargar (${response.status}).`);
    state.total = Number(response.headers.get('content-length')) || size;
    const hash = createHash('sha256');
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
      hash.update(chunk);
      state.received += chunk.length;
    });
    await pipeline(body, createWriteStream(partial));
    // A file that does not match exactly what was published is never used.
    if (hash.digest('hex') !== sha256) {
      await rm(partial, { force: true });
      throw new Error('El archivo descargado no coincide con el publicado. Inténtalo de nuevo.');
    }
    if (!zip(name)) return rename(partial, path(name));
    const staging = `${path(name)}.parcial`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await unzip(partial, staging);
      await rename(staging, path(name));
    } finally {
      await rm(partial, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Installs the component unless it is there already. Concurrent calls share one download. */
  function install(name) {
    if (installed(name)) return Promise.resolve();
    let state = downloads.get(name);
    if (!state) {
      state = { received: 0, total: COMPONENTS[name].size };
      state.promise = download(name, state).finally(() => downloads.delete(name));
      downloads.set(name, state);
    }
    return state.promise;
  }

  function status(name) {
    const state = downloads.get(name);
    return { installed: installed(name), size: COMPONENTS[name].size, ...(state && { received: state.received, total: state.total }) };
  }

  /** POST /api/components/status?names=a,b and /api/components/install?name=a. */
  async function handle(req, res, url) {
    const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      if (url.pathname === '/api/components/status') {
        const names = (url.searchParams.get('names') || '').split(',').filter((n) => n in COMPONENTS);
        return json(200, Object.fromEntries(names.map((n) => [n, status(n)])));
      }
      const name = url.searchParams.get('name');
      if (url.pathname !== '/api/components/install' || !(name in COMPONENTS)) return json(404, {});
      await install(name);
      return json(200, status(name));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`No se pudo instalar el componente: ${error.message}`);
    }
  }

  /** GET /components/<file>: the files the page loads itself (ONNX Runtime and its model). */
  function serve(url, res) {
    const file = normalize(join(folder, decodeURIComponent(url.pathname.slice('/components/'.length))));
    if (!file.startsWith(folder + sep) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  return { path, install, handle, serve };
}
