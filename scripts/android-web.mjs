// Prepares the site for the Android app in www/: the same files as dist/, except that the FFmpeg core
// is stored uncompressed (the app's local server does not send Content-Encoding like Netlify does)
// and without the service worker and Netlify headers, which the app has no use for.
// It also carries ONNX Runtime, see below.
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

rmSync('www', { recursive: true, force: true });
cpSync('dist', 'www', { recursive: true, filter: (path) => !/(^|[\\/])(sw\.js|_headers)$/.test(path) });
const wasm = 'www/ffmpeg/ffmpeg-core.wasm';
writeFileSync(wasm, brotliDecompressSync(readFileSync(wasm)));
// ONNX Runtime for "Quitar fondo" travels inside the APK (about 4 MB compressed); the Windows app
// downloads it instead, and the website does not have the tool.
mkdirSync('www/components/ort', { recursive: true });
for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copyFileSync(`node_modules/onnxruntime-web/dist/${file}`, `www/components/ort/${file}`);
}
console.log('Listo: www');
