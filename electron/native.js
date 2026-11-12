// Jobs the desktop app runs with programs on this computer instead of WebAssembly: FFmpeg filters
// the browser build lacks, and Windows' own voices for text to speech.
// The page only names a job and its settings; the command line is always built here.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

function run(command, args, cwd, res) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
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

/** POST /api/ffmpeg?job=…: the request body is the input file, the response is the result. */
export function createFFmpegHandler(ffmpeg) {
  return async (req, res, url) => {
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
  };
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
