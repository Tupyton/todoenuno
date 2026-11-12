// Downloads the programs the Windows desktop app ships with, into desktop/bin/win:
// yt-dlp.exe, and ffmpeg.exe + ffprobe.exe with their libraries (yt-dlp needs both to merge and convert).
// Both come from the yt-dlp project's own GitHub releases and are checked against the published SHA-256.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';

const OUT = 'desktop/bin/win';
const YT_DLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest';
const FFMPEG_ZIP = 'ffmpeg-master-latest-win64-gpl-shared.zip';

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads `name` and fails unless it matches its line in the release's checksum list. */
async function verified(base, name, sumsFile) {
  const sums = (await get(`${base}/${sumsFile}`)).toString();
  const expected = sums.split('\n').find((line) => line.trim().endsWith(name))?.trim().split(/\s+/)[0];
  if (!expected) throw new Error(`${name} no aparece en ${sumsFile}`);
  console.log(`Descargando ${name}…`);
  const data = await get(`${base}/${name}`);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${name}: la suma SHA-256 no coincide`);
  return data;
}

if (existsSync(join(OUT, 'yt-dlp.exe')) && existsSync(join(OUT, 'ffmpeg.exe')) && existsSync(join(OUT, 'ffprobe.exe'))) {
  console.log(`${OUT} ya tiene los programas. Bórrala para descargarlos de nuevo.`);
} else {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'yt-dlp.exe'), await verified(YT_DLP, 'yt-dlp.exe', 'SHA2-256SUMS'));

  const zip = await JSZip.loadAsync(await verified(FFMPEG, FFMPEG_ZIP, 'checksums.sha256'));
  for (const entry of Object.values(zip.files)) {
    // Everything in the build's bin/ folder except the player, which nothing uses.
    const name = entry.name.match(/\/bin\/([^/]+)$/)?.[1];
    if (!name || entry.dir || name === 'ffplay.exe') continue;
    await writeFile(join(OUT, name), await entry.async('nodebuffer'));
  }
  console.log(`Listo: ${OUT}`);
}
