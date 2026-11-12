import { base, ext } from '../ui.js';

// Served by the site itself; scripts/ffmpeg-core.mjs puts the files in public/ffmpeg.
const coreURL = new URL('/ffmpeg/ffmpeg-core.js', location.href).href;
const wasmURL = new URL('/ffmpeg/ffmpeg-core.wasm', location.href).href;

const MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
  png: 'image/png',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

let loading;
function getFFmpeg() {
  loading ??= (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({ coreURL, wasmURL });
    return ffmpeg;
  })().catch((error) => {
    loading = undefined;
    throw new Error(`No se pudo cargar FFmpeg: ${error.message || error}`);
  });
  return loading;
}

/**
 * Runs `ffmpeg [args] <output>` after writing `inputs` ([{ name, data }], data being a Blob or a string)
 * to FFmpeg's file system. Returns the output as `{ blob, name }`.
 */
export async function execFFmpeg({ inputs, args, outExt, name, progress }) {
  const ffmpeg = await getFFmpeg();
  const output = `output.${outExt}`;
  const logs = [];
  const onLog = ({ message }) => logs.push(message);
  const onProgress = ({ progress: p }) => progress(p);
  ffmpeg.on('log', onLog);
  ffmpeg.on('progress', onProgress);
  try {
    for (const { name: path, data } of inputs) {
      await ffmpeg.writeFile(path, typeof data === 'string' ? data : new Uint8Array(await data.arrayBuffer()));
    }
    const code = await ffmpeg.exec([...args, output]);
    if (code !== 0) throw new Error(`FFmpeg no pudo procesar el archivo:\n${logs.slice(-4).join('\n')}`);
    const data = await ffmpeg.readFile(output);
    return { blob: new Blob([data], { type: MIME[outExt] || 'application/octet-stream' }), name };
  } finally {
    ffmpeg.off('log', onLog);
    ffmpeg.off('progress', onProgress);
    for (const path of [...inputs.map((i) => i.name), output]) await ffmpeg.deleteFile(path).catch(() => {});
  }
}

/**
 * Runs `ffmpeg [pre] -i <file> [args] <output>` and returns the output as `{ blob, name }`.
 * `pre` holds input options such as `-ss`.
 */
export function runFFmpeg({ file, pre = [], args, outExt, suffix, progress }) {
  const input = `input.${ext(file.name) || 'bin'}`;
  return execFFmpeg({
    inputs: [{ name: input, data: file }],
    args: [...pre, '-i', input, ...args],
    outExt,
    name: `${base(file.name)}-${suffix}.${outExt}`,
    progress,
  });
}
