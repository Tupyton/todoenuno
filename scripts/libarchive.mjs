// Copies libarchive.js' worker and its WebAssembly into public/libarchive. The worker finds the wasm
// next to itself, so both are served as they are instead of going through the bundler.
import { copyFileSync, mkdirSync } from 'node:fs';

const src = 'node_modules/libarchive.js/dist';
const out = 'public/libarchive';
mkdirSync(out, { recursive: true });
for (const file of ['worker-bundle.js', 'libarchive.wasm']) copyFileSync(`${src}/${file}`, `${out}/${file}`);
