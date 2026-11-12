import { DESKTOP } from '../env.js';
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
  if (DESKTOP) return execNative({ inputs, args, outExt, name, progress });
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
 * Desktop app: the same command, run by the app with the FFmpeg installed next to it, which is many
 * times faster, can use the graphics card and has no file size limit (see electron/native.js).
 */
async function execNative({ inputs, args, outExt, name, progress }) {
  const id = crypto.randomUUID();
  const api = (step, params = {}) => `/api/ffmpeg/${step}?${new URLSearchParams({ id, ...params })}`;
  const failed = async (response, message) => new Error((await response.text()) || message);
  for (const { name: file, data } of inputs) {
    const response = await fetch(api('input', { name: file }), { method: 'POST', body: data });
    if (!response.ok) throw await failed(response, 'No se pudo preparar el archivo.');
  }
  const timer = setInterval(() => {
    fetch(api('progress'), { method: 'POST' })
      .then((response) => response.ok && response.json())
      .then((answer) => answer && progress?.(answer.progress))
      .catch(() => {});
  }, 500);
  try {
    const response = await fetch(api('run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args, output: `output.${outExt}` }),
    });
    if (!response.ok) throw await failed(response, 'FFmpeg no pudo procesar el archivo.');
    return { blob: new Blob([await response.blob()], { type: MIME[outExt] || 'application/octet-stream' }), name };
  } finally {
    clearInterval(timer);
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

/**
 * Desktop app only: runs one of the jobs the app's own server knows (see electron/main.js) with the
 * FFmpeg installed next to it, which is faster and has filters the WebAssembly build lacks.
 * Returns the output as `{ blob, name }`.
 */
export async function runNative({ file, job, params = {}, outExt, suffix }) {
  const query = new URLSearchParams({ job, ext: ext(file.name) || 'bin', ...params });
  const response = await fetch(`/api/ffmpeg?${query}`, { method: 'POST', body: file });
  if (!response.ok) throw new Error((await response.text()) || 'FFmpeg no pudo procesar el archivo.');
  const blob = await response.blob();
  return { blob: new Blob([blob], { type: MIME[outExt] || 'application/octet-stream' }), name: `${base(file.name)}-${suffix}.${outExt}` };
}
