// Copies the FFmpeg core into public/ffmpeg so the site serves it itself.
// The 32 MB wasm is stored Brotli-compressed (about 7 MB) and served with
// `Content-Encoding: br` (see public/_headers and vite.config.js), so the browser decodes it natively.
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';

const src = 'node_modules/@ffmpeg/core/dist/esm';
const out = 'public/ffmpeg';
mkdirSync(out, { recursive: true });
copyFileSync(`${src}/ffmpeg-core.js`, `${out}/ffmpeg-core.js`);
if (!existsSync(`${out}/ffmpeg-core.wasm`)) {
  console.log('Comprimiendo ffmpeg-core.wasm (tarda cerca de un minuto, solo la primera vez)…');
  const wasm = readFileSync(`${src}/ffmpeg-core.wasm`);
  writeFileSync(
    `${out}/ffmpeg-core.wasm`,
    brotliCompressSync(wasm, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: wasm.length,
      },
    }),
  );
}
