// Prepares the site for the Android app in www/: the same files as dist/, except that the FFmpeg core
// is stored uncompressed (the app's local server does not send Content-Encoding like Netlify does)
// and without the service worker and Netlify headers, which the app has no use for.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

rmSync('www', { recursive: true, force: true });
cpSync('dist', 'www', { recursive: true, filter: (path) => !/(^|[\\/])(sw\.js|_headers)$/.test(path) });
const wasm = 'www/ffmpeg/ffmpeg-core.wasm';
writeFileSync(wasm, brotliDecompressSync(readFileSync(wasm)));
console.log('Listo: www');
