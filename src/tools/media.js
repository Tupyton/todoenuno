import { runFFmpeg } from '../lib/ffmpeg.js';
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
];

export { ffmpegTool, FFMPEG_NOTE, time, range, x264, audioCodec, audioFormat, bitrate, startField, endField };
