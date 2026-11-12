// Jobs the desktop app runs with programs on this computer instead of WebAssembly: FFmpeg filters
// the browser build lacks, and Windows' own voices for text to speech.
// The page only names a job and its settings; the command line is always built here.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_TEXT = 100_000;

const AUDIO = {
  mp3: ['-c:a', 'libmp3lame'],
  m4a: ['-c:a', 'aac'],
  wav: ['-c:a', 'pcm_s16le'],
  ogg: ['-c:a', 'libvorbis'],
  flac: ['-c:a', 'flac'],
};
const KBPS = new Set(['96', '128', '192', '256', '320']);

/** The passes of a job, each a list of FFmpeg arguments, or an error message for bad settings. */
function ffmpegJob(params, input) {
  const job = params.get('job');
  if (job === 'stabilize') {
    return {
      outExt: 'mp4',
      passes: [
        // The transforms file is written next to the input: the process runs inside the job's folder.
        ['-i', input, '-vf', 'vidstabdetect=shakiness=6:accuracy=15:result=transforms.trf', '-f', 'null', '-'],
        [
          '-i', input,
          '-vf', 'vidstabtransform=smoothing=20:input=transforms.trf,unsharp=5:5:0.8:3:3:0.4,scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-movflags', '+faststart',
        ],
      ],
    };
  }
  if (job === 'pitch') {
    const semitones = Number(params.get('semitones'));
    const format = params.get('format');
    const kbps = params.get('kbps');
    if (!Number.isInteger(semitones) || !semitones || Math.abs(semitones) > 12) return 'El cambio de tono debe estar entre -12 y 12 semitonos.';
    if (!AUDIO[format] || !KBPS.has(kbps)) return 'Formato no válido.';
    const quality = format === 'wav' || format === 'flac' ? [] : ['-b:a', `${kbps}k`];
    return {
      outExt: format,
      passes: [['-i', input, '-vn', '-filter:a', `rubberband=pitch=${2 ** (semitones / 12)}:formant=preserved`, ...AUDIO[format], ...quality]],
    };
  }
  return 'Trabajo desconocido.';
}

/** Seconds in an FFmpeg time such as 01:02:03.45. */
const seconds = (text) => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/**
 * Runs a program inside `cwd`. Closing the request `res` belongs to cancels it. `onProgress` gets
 * values from 0 to 1 read from FFmpeg's own status lines.
 */
function run(command, args, cwd, res, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let duration = 0;
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr = (stderr + text).slice(-4000);
      if (!onProgress) return;
      duration ||= seconds(/Duration: (\d+:\d+:[\d.]+)/.exec(stderr)?.[1] || '0');
      const at = [...text.matchAll(/time=(\d+:\d+:[\d.]+)/g)].at(-1);
      if (at && duration) onProgress(Math.min(1, seconds(at[1]) / duration));
    });
    // Closing the tool page cancels the work.
    const cancel = () => child.kill();
    res.once('close', cancel);
    child.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? `No se encontró ${command}.` : error.message)));
    child.on('close', (code) => {
      res.off('close', cancel);
      if (code === 0) return resolve();
      const lines = stderr.trim().split('\n');
      reject(new Error(`No se pudo procesar el archivo: ${lines.at(-1) || `código ${code}`}`));
    });
  });
}

async function sendFile(res, path, type) {
  const { size } = await stat(path);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
  await pipeline(createReadStream(path), res);
}

const fail = (res, status, message) => {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
  else res.destroy();
};

/** Named jobs: POST /api/ffmpeg?job=…, the request body is the input file and the response the result. */
async function namedJob(ffmpeg, req, res, url) {
  const extension = url.searchParams.get('ext');
  if (!/^[a-z0-9]{1,5}$/i.test(extension || '')) return fail(res, 400, 'Archivo no válido.');
  const input = `input.${extension}`;
  const job = ffmpegJob(url.searchParams, input);
  if (typeof job === 'string') return fail(res, 400, job);
  const dir = await mkdtemp(join(tmpdir(), 'todoenuno-'));
  try {
    await pipeline(req, createWriteStream(join(dir, input)));
    const output = `output.${job.outExt}`;
    for (const [i, pass] of job.passes.entries()) {
      const last = i === job.passes.length - 1;
      await run(ffmpeg, ['-hide_banner', '-y', ...pass, ...(last ? [output] : [])], dir, res);
    }
    await sendFile(res, join(dir, output), 'application/octet-stream');
  } catch (error) {
    fail(res, 500, error.message);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/*
 * Any FFmpeg command of the tool pages, the same one the WebAssembly build would run: the page uploads
 * its input files, then asks for the command and gets the output back. Each command runs in a folder of
 * its own, and no argument may name a path or a URL, so FFmpeg only ever sees that folder's files.
 */
const NAME = /^[\w-][\w.-]{0,63}$/;
const ID = /^[\w-]{8,64}$/;
const UNSAFE = [
  /(^|[='":,])([\\/]|[a-z]:[\\/])/i, // absolute paths, also inside a filter's options
  /(^|[\\/])\.\.([\\/]|$)/, // parent folders
  /^[a-z][\w+.-]*:/i, // protocols: http:, concat:, subfile:…
];
const IDLE = 10 * 60_000;
const jobs = new Map();

function jobFor(id, create) {
  let job = jobs.get(id);
  if (!job && create) {
    job = { dir: mkdtemp(join(tmpdir(), 'todoenuno-')), progress: 0 };
    jobs.set(id, job);
  }
  if (!job) return null;
  // A page closed mid-upload leaves no request behind, so unused jobs clean themselves up.
  clearTimeout(job.timer);
  job.timer = setTimeout(() => dropJob(id), IDLE);
  return job;
}

async function dropJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  clearTimeout(job.timer);
  await rm(await job.dir, { recursive: true, force: true }).catch(() => {});
}

/*
 * Graphics card encoders, tried once in this order. Each replaces the x264 settings the pages use:
 * the quality number (CRF) becomes the encoder's own constant-quality setting.
 */
const GPU = [
  ['h264_nvenc', (q) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', q, '-b:v', '0']],
  ['h264_qsv', (q) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', q], 'nv12'],
  ['h264_amf', (q) => ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', q, '-qp_p', q]],
];
let gpu;

/** The first encoder that can encode a frame on this computer, or null. */
function findGpu(ffmpeg) {
  gpu ??= (async () => {
    for (const encoder of GPU) {
      const ok = await new Promise((resolve) => {
        const args = ['-hide_banner', '-f', 'lavfi', '-i', 'color=size=256x256:duration=0.1', '-frames:v', '1', '-c:v', encoder[0], '-f', 'null', '-'];
        spawn(ffmpeg, args, { stdio: 'ignore', windowsHide: true })
          .on('error', () => resolve(false))
          .on('close', (code) => resolve(code === 0));
      });
      if (ok) return encoder;
    }
    return null;
  })();
  return gpu;
}

/** The same command with x264 swapped for the graphics card encoder, or null when it has no x264 video. */
function withGpu(args, [, settings, pixelFormat]) {
  const at = args.findIndex((arg, i) => arg === 'libx264' && args[i - 1] === '-c:v');
  if (at < 0) return null;
  const crf = args[args.indexOf('-crf') + 1] || '23';
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (i === at - 1) {
      out.push(...settings(crf));
      i++;
    } else if (args[i] === '-preset' || args[i] === '-crf') i++;
    else if (pixelFormat && args[i] === '-pix_fmt' && args[i + 1] === 'yuv420p') {
      out.push('-pix_fmt', pixelFormat);
      i++;
    } else out.push(args[i]);
  }
  return out;
}

async function readBody(req, limit) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Petición demasiado grande.');
  }
  return body;
}

async function commandJob(ffmpeg, req, res, url) {
  const id = url.searchParams.get('id');
  if (!ID.test(id || '')) return fail(res, 400, 'Trabajo no válido.');
  const step = url.pathname.slice('/api/ffmpeg/'.length);
  try {
    if (step === 'input') {
      const name = url.searchParams.get('name');
      if (!NAME.test(name || '')) return fail(res, 400, 'Nombre de archivo no válido.');
      const job = jobFor(id, true);
      await pipeline(req, createWriteStream(join(await job.dir, name)));
      return res.writeHead(204).end();
    }
    if (step === 'progress') {
      const job = jobFor(id, false);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ progress: job?.progress || 0 }));
    }
    if (step !== 'run') return fail(res, 404, 'No encontrado.');
    const job = jobFor(id, false);
    if (!job) return fail(res, 400, 'Faltan los archivos.');
    const refuse = async (message) => {
      await dropJob(id);
      fail(res, 400, message);
    };
    const { args, output } = JSON.parse(await readBody(req, 100_000));
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string') || !NAME.test(output || '')) return refuse('Orden no válida.');
    if (args.some((arg) => UNSAFE.some((pattern) => pattern.test(arg)))) return refuse('Orden no válida.');
    const dir = await job.dir;
    const inputs = new Set(await readdir(dir));
    if (args.some((arg, i) => args[i - 1] === '-i' && !inputs.has(arg))) return refuse('Falta un archivo de entrada.');
    const onProgress = (p) => (job.progress = p);
    const encoder = await findGpu(ffmpeg);
    const fast = encoder && withGpu(args, encoder);
    const full = (a) => ['-hide_banner', '-y', ...a, output];
    try {
      await run(ffmpeg, full(fast || args), dir, res, onProgress);
    } catch (error) {
      // Some videos or drivers do not get along with the graphics card; the regular encoder always works.
      if (!fast || res.destroyed) throw error;
      job.progress = 0;
      await run(ffmpeg, full(args), dir, res, onProgress);
    }
    await sendFile(res, join(dir, output), 'application/octet-stream');
    await dropJob(id);
  } catch (error) {
    await dropJob(id);
    fail(res, 500, error.message);
  }
}

/** POST /api/ffmpeg?job=… for named jobs, /api/ffmpeg/{input,run,progress}?id=… for page commands. */
export function createFFmpegHandler(ffmpeg) {
  return (req, res, url) => (url.pathname === '/api/ffmpeg' ? namedJob(ffmpeg, req, res, url) : commandJob(ffmpeg, req, res, url));
}

/* Text to speech with System.Speech, which every Windows has. */

// Settings travel in environment variables, never inside the script, so no text can change what it runs.
const SPEAK = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:TTS_VOICE) { try { $s.SelectVoice($env:TTS_VOICE) } catch {} }
$s.Rate = [int]$env:TTS_RATE
$s.SetOutputToWaveFile($env:TTS_OUT)
$s.Speak([IO.File]::ReadAllText($env:TTS_TEXT, [Text.Encoding]::UTF8))
$s.Dispose()
`;
const VOICES = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }
`;

function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `PowerShell terminó con código ${code}`))));
  });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_TEXT * 4) throw new Error('El texto es demasiado largo.');
  }
  return JSON.parse(body || '{}');
}

/** POST /api/voices lists the installed voices; POST /api/tts { text, voice, rate } returns a WAV. */
export async function handleSpeech(req, res, url) {
  if (process.platform !== 'win32') return fail(res, 501, 'Solo está disponible en Windows.');
  try {
    if (url.pathname === '/api/voices') {
      const voices = (await powershell(VOICES))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name, lang] = line.split('|');
          return { name, lang };
        });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(voices));
    }
    const { text, voice, rate } = await readJson(req);
    if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'Escribe el texto.');
    if (text.length > MAX_TEXT) return fail(res, 400, 'El texto es demasiado largo.');
    const dir = await mkdtemp(join(tmpdir(), 'todoenuno-'));
    try {
      await writeFile(join(dir, 'text.txt'), text, 'utf8');
      await powershell(SPEAK, {
        TTS_VOICE: typeof voice === 'string' ? voice : '',
        TTS_RATE: String(Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)))),
        TTS_OUT: join(dir, 'voz.wav'),
        TTS_TEXT: join(dir, 'text.txt'),
      });
      await sendFile(res, join(dir, 'voz.wav'), 'audio/wav');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    fail(res, 500, `No se pudo generar la voz: ${error.message}`);
  }
}
