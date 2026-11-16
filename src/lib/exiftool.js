// ExifTool (WebAssembly) to read and write photo metadata, RAW files included, without re-encoding.
// Its 25 MB wasm (5 MB compressed) is too big to ship with the app, so it is downloaded the
// first time a tool needs it and kept in the Cache API for offline use.
import { base, ext } from '../ui.js';

// Same version as the @6over3/zeroperl-ts that @uswriting/exiftool 1.0.9 (pinned in package.json) depends on.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@6over3/zeroperl-ts@1.0.10/dist/esm/zeroperl.wasm';
const WASM_SHA256 = 'sha256-pq6X8YT6vERLC3DXfD0WR1v7PeFuv7WKuLL7+YpTg14=';
const CACHE = 'todoenuno-exiftool'; // Spared by the service worker (vite.config.js).

export const RAW_EXT = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf',
  'pef', 'srw', '3fr', 'iiq', 'erf', 'kdc', 'mrw', 'x3f', 'rwl', 'mef', 'mos', 'dcr',
];
// RAW files usually have no MIME type, so the picker needs their extensions.
export const PHOTO_ACCEPT = ['image/*', '.heic', '.heif', ...RAW_EXT.map((e) => `.${e}`)].join(',');
export const isRaw = (file) => RAW_EXT.includes(ext(file.name));

async function wasmResponse() {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(WASM_URL);
    if (hit) return hit;
  } catch {
    // No Cache API (private window, file://): download every time.
  }
  let response;
  try {
    response = await fetch(WASM_URL, { integrity: WASM_SHA256 });
  } catch {
    throw new Error('Esta herramienta descarga su motor (unos 5 MB) la primera vez y necesita conexión a internet.');
  }
  if (!response.ok) throw new Error(`No se pudo descargar el motor de metadatos (${response.status}).`);
  if (cache) await cache.put(WASM_URL, response.clone()).catch(() => {});
  return response;
}

let lib = null;
let queue = Promise.resolve();

/** Runs `job(exiftool)` after the previous one: the library shares a single interpreter. */
function serial(job) {
  const next = queue.then(async () => {
    lib ??= import('@uswriting/exiftool');
    return job(await lib);
  });
  queue = next.catch(() => {});
  return next;
}

// ExifTool only needs the extension to know the format; a plain name avoids trouble with odd characters.
const input = (file) => ({ name: `foto.${ext(file.name) || 'jpg'}`, data: file });
const options = { fetch: () => wasmResponse() };
// "Error: Not a valid NEF - /foto.nef" → "Not a valid NEF".
const reason = (error) => String(error).replace(/^(Warning|Error): /i, '').replace(/ - \/foto\.\w+\s*$/, '').trim();

/** All tags of `file` as `{ 'Group:Tag': value }`, with readable values. */
export const readTags = (file) =>
  serial(async ({ parseMetadata }) => {
    const result = await parseMetadata(input(file), {
      ...options,
      args: ['-json', '-G1', '-a', '-s', '-charset', 'utf8', '-c', '%+.6f'],
      transform: (data) => JSON.parse(data)[0],
    });
    if (!result.success) throw new Error(`No se pudieron leer los metadatos de ${file.name}: ${reason(result.error)}`);
    delete result.data.SourceFile;
    return result.data;
  });

/**
 * Writes `tags` ({ Tag: value }, '' deletes the tag) after the ExifTool arguments `args`. Returns the
 * new file, named like the original plus `suffix`. Warnings are silenced: the library treats any
 * message as a failure.
 */
export const writeTags = (file, tags, args, suffix) =>
  serial(async ({ writeMetadata }) => {
    const result = await writeMetadata(input(file), tags, { ...options, args: ['-q', '-q', '-m', '-charset', 'utf8', ...args] });
    if (!result.success) throw new Error(`No se pudieron guardar los metadatos de ${file.name}: ${reason(result.error)}`);
    return {
      blob: new Blob([result.data], { type: file.type }),
      name: `${base(file.name)}-${suffix}.${ext(file.name) || 'jpg'}`,
    };
  });
