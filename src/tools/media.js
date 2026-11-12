import { DESKTOP } from '../env.js';
import { runFFmpeg, runNative } from '../lib/ffmpeg.js';
import { resultView } from '../tool-page.js';
import { ext, h } from '../ui.js';

const TIME = /^(\d+:){0,2}\d+(\.\d+)?$/;

/** Validates a time written as seconds (90) or [hh:]mm:ss (1:30). Returns null when empty. */
function time(value, label, required = false) {
  const text = String(value).trim();
  if (!text) {
    if (required) throw new Error(`Indica ${label}.`);
    return null;
  }
  if (!TIME.test(text)) throw new Error(`${label} no es válido: usa segundos (90) o mm:ss (1:30).`);
  return text;
}

const range = (start, end) => [...(start ? ['-ss', start] : []), ...(end ? ['-to', end] : [])];

// yuv420p needs even dimensions, so odd sizes are rounded down.
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
const x264 = (crf = 23, filter) => [
  '-vf',
  [filter, EVEN].filter(Boolean).join(','),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
];

const VIDEO_CODECS = {
  mp4: [...x264(), '-c:a', 'aac', '-movflags', '+faststart'],
  mkv: [...x264(), '-c:a', 'aac'],
  mov: [...x264(), '-c:a', 'aac'],
  webm: ['-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis'],
  avi: ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame'],
};

const AUDIO_CODECS = { mp3: 'libmp3lame', m4a: 'aac', wav: 'pcm_s16le', ogg: 'libvorbis', flac: 'flac' };
const audioCodec = (fmt, kbps) => ['-c:a', AUDIO_CODECS[fmt], ...(fmt === 'wav' || fmt === 'flac' ? [] : ['-b:a', `${kbps}k`])];

const audioFormat = {
  key: 'format',
  label: 'Formato',
  type: 'select',
  value: 'mp3',
  options: [
    ['mp3', 'MP3'],
    ['m4a', 'M4A (AAC)'],
    ['wav', 'WAV'],
    ['ogg', 'OGG'],
    ['flac', 'FLAC'],
  ],
};
const bitrate = { key: 'kbps', label: 'Bitrate (kbps)', type: 'select', value: '192', options: ['96', '128', '192', '256', '320'], hint: 'No aplica a WAV ni FLAC.' };
const startField = { key: 'start', label: 'Inicio', placeholder: '0:00', hint: 'Segundos o mm:ss. Vacío = desde el principio.' };
const endField = { key: 'end', label: 'Fin', placeholder: '1:30', hint: 'Vacío = hasta el final.' };

/** atempo accepts 0.5–2 per instance, so larger changes are chained. */
function atempo(factor) {
  const parts = [];
  while (factor > 2) {
    parts.push('atempo=2');
    factor /= 2;
  }
  while (factor < 0.5) {
    parts.push('atempo=0.5');
    factor /= 0.5;
  }
  parts.push(`atempo=${factor}`);
  return parts.join(',');
}

function speedFactor(v) {
  if (!(v.speed >= 0.25 && v.speed <= 4)) throw new Error('La velocidad debe estar entre 0.25 y 4.');
  return v.speed;
}

/** Re-encodes only the audio; the video stream is copied into a container that accepts it. */
function audioOnly(file) {
  const extension = ext(file.name);
  const mp4 = /^(mp4|m4v|mov)$/.test(extension);
  return { codec: ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', ...(mp4 ? ['-movflags', '+faststart'] : [])], outExt: mp4 ? extension : 'mkv' };
}

const SIZES = [
  ['1920x1080', 'Horizontal 1080p (1920×1080)'],
  ['1280x720', 'Horizontal 720p (1280×720)'],
  ['854x480', 'Horizontal 480p (854×480)'],
  ['1080x1920', 'Vertical 1080p (1080×1920)'],
  ['720x1280', 'Vertical 720p (720×1280)'],
  ['1080x1350', 'Vertical 4:5 (1080×1350)'],
  ['1080x1080', 'Cuadrado (1080×1080)'],
];

function resizeFilter(size, mode) {
  const [w, ht] = size.split('x');
  if (mode === 'stretch') return `scale=${w}:${ht},setsar=1`;
  if (mode === 'fill') return `scale=${w}:${ht}:force_original_aspect_ratio=increase,crop=${w}:${ht},setsar=1`;
  return `scale=${w}:${ht}:force_original_aspect_ratio=decrease,pad=${w}:${ht}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

function semitones(v) {
  if (!(Math.abs(v.semitones) <= 12)) throw new Error('El cambio de tono debe estar entre -12 y 12 semitonos.');
  if (!v.semitones) throw new Error('Elige un cambio de tono distinto de 0.');
  return v.semitones;
}

const FFMPEG_NOTE = 'La primera vez se carga FFmpeg (~7 MB). El proceso usa tu dispositivo: los archivos grandes tardan, sobre todo en el móvil.';

/** Declares an FFmpeg tool. `build(v, file)` returns { pre, args, outExt }. */
const ffmpegTool = ({ build, ...tool }) => ({
  files: { accept: tool.cat === 'audio' ? 'audio/*,video/*' : 'video/*' },
  note: FFMPEG_NOTE,
  ...tool,
  run: ({ file, v, progress }) => runFFmpeg({ file, progress, suffix: tool.id.split('-').pop(), ...build(v, file) }),
});

function renderRecorder(root) {
  let recorder = null;
  let stream = null;
  const out = resultView();
  const status = h('p', { class: 'status', role: 'status' });
  const source = h(
    'select',
    {},
    // Phones have no screen capture API.
    navigator.mediaDevices.getDisplayMedia ? h('option', { value: 'screen' }, 'Pantalla') : null,
    h('option', { value: 'camera' }, 'Cámara y micrófono'),
    h('option', { value: 'mic' }, 'Solo micrófono'),
  );

  function stop() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
  }

  async function start() {
    const kind = source.value;
    status.classList.remove('error');
    try {
      stream =
        kind === 'screen'
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          : await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'camera' });
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.name === 'NotAllowedError' ? 'Permiso denegado o captura cancelada.' : `No se pudo iniciar la captura: ${error.message}`;
      return;
    }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType.split(';')[0] || (kind === 'mic' ? 'audio/webm' : 'video/webm');
      const extension = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
      out.show({ blob: new Blob(chunks, { type }), name: `grabacion.${extension}` });
      button.textContent = 'Iniciar grabación';
      source.disabled = false;
      status.textContent = '';
    };
    // The browser's own "stop sharing" control ends the track without going through our button.
    stream.getTracks().forEach((track) => track.addEventListener('ended', stop));
    recorder.start();
    out.clear();
    button.textContent = 'Detener grabación';
    source.disabled = true;
    status.textContent = 'Grabando…';
  }

  const button = h(
    'button',
    { type: 'button', class: 'btn primary', onclick: () => (recorder?.state === 'recording' ? stop() : start()) },
    'Iniciar grabación',
  );
  root.append(h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', {}, 'Fuente'), source)), button, status, out.el);
  return () => {
    if (recorder) recorder.onstop = null;
    stop();
    out.clear();
  };
}

export default [
  ffmpegTool({
    id: 'video-recortar',
    name: 'Recortar video',
    desc: 'Corta un fragmento indicando inicio y fin.',
    cat: 'video',
    action: 'Recortar',
    fields: [
      startField,
      endField,
      { key: 'exact', label: 'Corte exacto (recodifica, más lento)', type: 'checkbox', hint: 'Sin marcar: instantáneo, pero el corte cae en el fotograma clave más cercano.' },
    ],
    build(v, file) {
      const pre = range(time(v.start, 'El inicio'), time(v.end, 'El fin'));
      if (!pre.length) throw new Error('Indica el inicio, el fin o ambos.');
      return v.exact
        ? { pre, args: VIDEO_CODECS.mp4, outExt: 'mp4' }
        : { pre, args: ['-c', 'copy', '-avoid_negative_ts', 'make_zero'], outExt: ext(file.name) || 'mp4' };
    },
  }),
  ffmpegTool({
    id: 'video-convertir',
    name: 'Convertir video',
    desc: 'Cambia entre MP4, WebM, MKV, MOV y AVI.',
    cat: 'video',
    action: 'Convertir',
    fields: [
      {
        key: 'format',
        label: 'Formato',
        type: 'select',
        value: 'mp4',
        options: [
          ['mp4', 'MP4 (H.264)'],
          ['webm', 'WebM (VP8, muy lento)'],
          ['mkv', 'MKV (H.264)'],
          ['mov', 'MOV (H.264)'],
          ['avi', 'AVI (MPEG-4)'],
        ],
      },
    ],
    build: (v) => ({ args: VIDEO_CODECS[v.format], outExt: v.format }),
  }),
  ffmpegTool({
    id: 'video-comprimir',
    name: 'Comprimir video',
    desc: 'Reduce el peso bajando calidad y resolución.',
    cat: 'video',
    action: 'Comprimir',
    fields: [
      { key: 'crf', label: 'Compresión (CRF)', type: 'range', min: 18, max: 40, value: 28, hint: 'Más alto = menos peso y menos calidad.' },
      {
        key: 'height',
        label: 'Resolución',
        type: 'select',
        value: '',
        options: [
          ['', 'Original'],
          ['1080', '1080p'],
          ['720', '720p'],
          ['480', '480p'],
          ['360', '360p'],
        ],
      },
    ],
    build: (v) => ({
      args: [...x264(v.crf, v.height && `scale=-2:${v.height}`), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
      outExt: 'mp4',
    }),
  }),
  ffmpegTool({
    id: 'video-audio',
    name: 'Extraer audio de video',
    desc: 'Guarda la pista de audio como MP3, M4A, WAV, OGG o FLAC.',
    cat: 'video',
    action: 'Extraer audio',
    fields: [audioFormat, bitrate],
    build: (v) => ({ args: ['-vn', ...audioCodec(v.format, v.kbps)], outExt: v.format }),
  }),
  ffmpegTool({
    id: 'video-silenciar',
    name: 'Quitar audio de video',
    desc: 'Deja el video sin sonido, sin recodificar.',
    cat: 'video',
    action: 'Quitar audio',
    build: (v, file) => ({ args: ['-an', '-c:v', 'copy'], outExt: ext(file.name) || 'mp4' }),
  }),
  ffmpegTool({
    id: 'video-gif',
    name: 'Video a GIF',
    desc: 'Convierte un fragmento de video en un GIF animado.',
    cat: 'video',
    action: 'Crear GIF',
    fields: [
      { ...startField, hint: 'Segundos o mm:ss.' },
      { key: 'duration', label: 'Duración (s)', type: 'number', min: 0.1, step: 0.1, value: 5 },
      { key: 'fps', label: 'Fotogramas por segundo', type: 'number', min: 1, max: 30, value: 12 },
      { key: 'width', label: 'Ancho (px)', type: 'number', min: 16, value: 480 },
    ],
    build(v) {
      if (!(v.duration > 0) || !(v.fps > 0) || !(v.width > 0)) throw new Error('Duración, fotogramas y ancho deben ser mayores que cero.');
      const start = time(v.start, 'El inicio');
      return {
        pre: [...(start ? ['-ss', start] : []), '-t', String(v.duration)],
        args: ['-vf', `fps=${v.fps},scale=${v.width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`],
        outExt: 'gif',
      };
    },
  }),
  ffmpegTool({
    id: 'video-velocidad',
    name: 'Cambiar velocidad de video',
    desc: 'Acelera o ralentiza video y audio.',
    cat: 'video',
    action: 'Aplicar',
    fields: [{ key: 'speed', label: 'Velocidad', type: 'number', min: 0.25, max: 4, step: 0.05, value: 2, hint: 'Entre 0.25 y 4. 2 = el doble de rápido.' }],
    build(v) {
      const speed = speedFactor(v);
      return { args: [...x264(23, `setpts=PTS/${speed}`), '-filter:a', atempo(speed), '-c:a', 'aac'], outExt: 'mp4' };
    },
  }),
  ffmpegTool({
    id: 'video-rotar',
    name: 'Rotar video',
    desc: 'Gira o voltea un video.',
    cat: 'video',
    action: 'Rotar',
    fields: [
      {
        key: 'filter',
        label: 'Transformación',
        type: 'select',
        value: 'transpose=1',
        options: [
          ['transpose=1', '90° a la derecha'],
          ['transpose=2', '90° a la izquierda'],
          ['hflip,vflip', '180°'],
          ['hflip', 'Espejo horizontal'],
          ['vflip', 'Espejo vertical'],
        ],
      },
    ],
    build: (v) => ({ args: [...x264(23, v.filter), '-c:a', 'copy'], outExt: 'mp4' }),
  }),
  ffmpegTool({
    id: 'video-fotograma',
    name: 'Capturar fotograma',
    desc: 'Guarda un instante del video como imagen PNG.',
    cat: 'video',
    action: 'Capturar',
    fields: [{ key: 'at', label: 'Instante', value: '0', hint: 'Segundos o mm:ss.' }],
    build: (v) => ({ pre: ['-ss', time(v.at, 'El instante', true)], args: ['-frames:v', '1'], outExt: 'png' }),
  }),
  ffmpegTool({
    id: 'video-bucle',
    name: 'Repetir video en bucle',
    desc: 'Repite un video varias veces seguidas, sin recomprimir.',
    cat: 'video',
    action: 'Repetir',
    fields: [{ key: 'times', label: 'Veces en total', type: 'number', min: 2, max: 50, value: 3 }],
    build(v, file) {
      if (!(v.times >= 2 && v.times <= 50)) throw new Error('Elige entre 2 y 50 repeticiones.');
      return { pre: ['-stream_loop', String(v.times - 1)], args: ['-c', 'copy'], outExt: ext(file.name) || 'mp4' };
    },
  }),
  ffmpegTool({
    id: 'video-volumen',
    name: 'Volumen de video',
    desc: 'Sube o baja el volumen de un video sin tocar la imagen.',
    cat: 'video',
    action: 'Aplicar',
    fields: [{ key: 'volume', label: 'Volumen (%)', type: 'range', min: 0, max: 400, step: 5, value: 150 }],
    build(v, file) {
      const { codec, outExt } = audioOnly(file);
      return { args: ['-map', '0:v', '-map', '0:a', '-filter:a', `volume=${v.volume / 100}`, ...codec], outExt };
    },
  }),
  ffmpegTool({
    id: 'video-redimensionar',
    name: 'Redimensionar video',
    desc: 'Cambia el tamaño a uno estándar: horizontal, vertical o cuadrado.',
    cat: 'video',
    action: 'Redimensionar',
    fields: [
      { key: 'size', label: 'Tamaño', type: 'select', value: '1280x720', options: SIZES },
      {
        key: 'mode',
        label: 'Si la forma no coincide',
        type: 'select',
        value: 'fit',
        options: [
          ['fit', 'Encajar con bandas negras'],
          ['fill', 'Llenar recortando los bordes'],
          ['stretch', 'Estirar'],
        ],
      },
    ],
    build: (v) => ({ args: [...x264(23, resizeFilter(v.size, v.mode)), '-c:a', 'aac', '-movflags', '+faststart'], outExt: 'mp4' }),
  }),
  {
    ...ffmpegTool({
      id: 'video-estabilizar',
      name: 'Estabilizar video',
      desc: 'Reduce el temblor de un video grabado a mano.',
      cat: 'video',
      action: 'Estabilizar',
      build: () => ({ args: [...x264(23, 'deshake'), '-c:a', 'aac', '-movflags', '+faststart'], outExt: 'mp4' }),
    }),
    ...(DESKTOP && {
      note: 'Analiza el video en dos pasadas para un resultado más suave. Puede tardar varios minutos.',
      run: ({ file }) => runNative({ file, job: 'stabilize', outExt: 'mp4', suffix: 'estabilizar' }),
    }),
    ...(!DESKTOP && {
      note: `${FFMPEG_NOTE} Es un proceso lento en el navegador; la versión para Windows usa un estabilizador mejor y más rápido.`,
    }),
  },
  {
    id: 'grabar',
    name: 'Grabar pantalla, cámara o micrófono',
    desc: 'Graba desde el navegador y descarga el resultado.',
    cat: 'video',
    blocked: () =>
      !(navigator.mediaDevices?.getUserMedia && window.MediaRecorder) && 'Este navegador no permite grabar desde la web.',
    render: renderRecorder,
  },
  ffmpegTool({
    id: 'audio-convertir',
    name: 'Convertir audio',
    desc: 'Cambia entre MP3, M4A, WAV, OGG y FLAC.',
    cat: 'audio',
    action: 'Convertir',
    fields: [audioFormat, bitrate],
    build: (v) => ({ args: ['-vn', ...audioCodec(v.format, v.kbps)], outExt: v.format }),
  }),
  ffmpegTool({
    id: 'audio-recortar',
    name: 'Recortar audio',
    desc: 'Corta un fragmento de un audio.',
    cat: 'audio',
    action: 'Recortar',
    fields: [startField, endField, audioFormat, bitrate],
    build(v) {
      const pre = range(time(v.start, 'El inicio'), time(v.end, 'El fin'));
      if (!pre.length) throw new Error('Indica el inicio, el fin o ambos.');
      return { pre, args: ['-vn', ...audioCodec(v.format, v.kbps)], outExt: v.format };
    },
  }),
  ffmpegTool({
    id: 'audio-ajustar',
    name: 'Volumen y velocidad de audio',
    desc: 'Sube o baja el volumen y cambia la velocidad.',
    cat: 'audio',
    action: 'Aplicar',
    fields: [
      { key: 'volume', label: 'Volumen (%)', type: 'range', min: 0, max: 400, step: 5, value: 150 },
      { key: 'speed', label: 'Velocidad', type: 'number', min: 0.25, max: 4, step: 0.05, value: 1, hint: 'Entre 0.25 y 4.' },
      audioFormat,
      bitrate,
    ],
    build: (v) => ({
      args: ['-vn', '-filter:a', `volume=${v.volume / 100},${atempo(speedFactor(v))}`, ...audioCodec(v.format, v.kbps)],
      outExt: v.format,
    }),
  }),
  ffmpegTool({
    id: 'audio-invertir',
    name: 'Invertir audio',
    desc: 'Reproduce un audio al revés.',
    cat: 'audio',
    action: 'Invertir',
    fields: [audioFormat, bitrate],
    build: (v) => ({ args: ['-vn', '-filter:a', 'areverse', ...audioCodec(v.format, v.kbps)], outExt: v.format }),
  }),
  {
    ...ffmpegTool({
      id: 'audio-tono',
      name: 'Cambiar tono de audio',
      desc: 'Hace la voz o la música más aguda o más grave sin cambiar la velocidad.',
      cat: 'audio',
      action: 'Cambiar tono',
      fields: [
        { key: 'semitones', label: 'Semitonos', type: 'range', min: -12, max: 12, step: 1, value: 3, hint: 'Positivo = más agudo. 12 = una octava.' },
        audioFormat,
        bitrate,
      ],
      build(v) {
        const factor = 2 ** (semitones(v) / 12);
        // Playing the samples faster raises the pitch; atempo then restores the original speed.
        return { args: ['-vn', '-filter:a', `aresample=48000,asetrate=${48000 * factor},aresample=48000,${atempo(1 / factor)}`, ...audioCodec(v.format, v.kbps)], outExt: v.format };
      },
    }),
    ...(DESKTOP && {
      note: 'Usa Rubber Band, que conserva el timbre natural de la voz.',
      run: ({ file, v }) =>
        runNative({ file, job: 'pitch', params: { semitones: semitones(v), format: v.format, kbps: v.kbps }, outExt: v.format, suffix: 'tono' }),
    }),
  },
  ffmpegTool({
    id: 'audio-ecualizador',
    name: 'Ecualizador',
    desc: 'Ajusta graves, medios y agudos de un audio.',
    cat: 'audio',
    action: 'Aplicar',
    fields: [
      { key: 'bass', label: 'Graves (dB)', type: 'range', min: -15, max: 15, step: 1, value: 4 },
      { key: 'mid', label: 'Medios (dB)', type: 'range', min: -15, max: 15, step: 1, value: 0 },
      { key: 'treble', label: 'Agudos (dB)', type: 'range', min: -15, max: 15, step: 1, value: 0 },
      audioFormat,
      bitrate,
    ],
    build: (v) => ({
      args: [
        '-vn',
        '-filter:a',
        `bass=g=${v.bass}:f=100,equalizer=f=1000:t=q:w=1:g=${v.mid},treble=g=${v.treble}:f=8000,alimiter=limit=0.98`,
        ...audioCodec(v.format, v.kbps),
      ],
      outExt: v.format,
    }),
  }),
];

export { ffmpegTool, FFMPEG_NOTE, time, range, x264, audioCodec, audioFormat, bitrate, startField, endField };
