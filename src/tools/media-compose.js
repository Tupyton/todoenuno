import { execFFmpeg } from '../lib/ffmpeg.js';
import { encode, makeCanvas } from '../lib/image.js';
import { base, ext, h } from '../ui.js';
import { FFMPEG_NOTE, audioCodec, audioFormat, bitrate, ffmpegTool, time, x264 } from './media.js';

const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
// The concat filter needs every audio stream in the same format.
const SAME_AUDIO = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';

const named = (files) => files.map((file, i) => ({ name: `in${i}.${ext(file.name) || 'bin'}`, data: file }));
const asInputs = (inputs) => inputs.flatMap((i) => ['-i', i.name]);

function joinVideos({ files, v, progress }) {
  if (files.length < 2) throw new Error('Elige al menos dos videos.');
  const [w, ht] = v.size.split('x');
  const inputs = named(files);
  // Every clip is fitted into the same frame, with black bars when its shape differs.
  const fit = `scale=${w}:${ht}:force_original_aspect_ratio=decrease,pad=${w}:${ht}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
  const chains = files.flatMap((_, i) => [`[${i}:v]${fit}[v${i}]`, ...(v.audio ? [`[${i}:a]${SAME_AUDIO}[a${i}]`] : [])]);
  const pads = files.map((_, i) => `[v${i}]${v.audio ? `[a${i}]` : ''}`).join('');
  const filter = `${chains.join(';')};${pads}concat=n=${files.length}:v=1:a=${v.audio ? 1 : 0}[v]${v.audio ? '[a]' : ''}`;
  return execFFmpeg({
    inputs,
    args: [...asInputs(inputs), '-filter_complex', filter, '-map', '[v]', ...(v.audio ? ['-map', '[a]', '-c:a', 'aac'] : []), ...H264, '-movflags', '+faststart'],
    outExt: 'mp4',
    name: 'videos-unidos.mp4',
    progress,
  });
}

function joinAudios({ files, v, progress }) {
  if (files.length < 2) throw new Error('Elige al menos dos audios.');
  const inputs = named(files);
  const filter = `${files.map((_, i) => `[${i}:a]${SAME_AUDIO}[a${i}]`).join(';')};${files.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1[a]`;
  return execFFmpeg({
    inputs,
    args: [...asInputs(inputs), '-filter_complex', filter, '-map', '[a]', ...audioCodec(v.format, v.kbps)],
    outExt: v.format,
    name: `audios-unidos.${v.format}`,
    progress,
  });
}

/** Frame size as the browser reports it (already accounts for rotation). */
function videoSize(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = h('video', { preload: 'metadata', muted: true });
    const done = (fn, value) => {
      URL.revokeObjectURL(url);
      fn(value);
    };
    video.onloadedmetadata = () => done(resolve, [video.videoWidth, video.videoHeight]);
    video.onerror = () => done(reject, new Error('Este navegador no puede leer ese video. Conviértelo antes a MP4.'));
    video.src = url;
  });
}

const toSeconds = (text) => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/**
 * The text is painted on a transparent PNG with the device's own fonts and laid over the video,
 * so no font file has to be shipped to FFmpeg.
 */
async function textOverVideo({ file, v, progress }) {
  if (!v.text.trim()) throw new Error('Escribe el texto.');
  const start = time(v.start, 'El inicio');
  const end = time(v.end, 'El fin');
  const [width, height] = await videoSize(file);
  if (!width) throw new Error('No se pudo leer el tamaño del video.');
  const size = Math.max(12, (Math.min(width, height) * v.size) / 100);
  const font = `700 ${size}px system-ui, 'Segoe UI', Roboto, sans-serif`;
  const probe = makeCanvas(1, 1).getContext('2d');
  probe.font = font;
  const lines = [];
  for (const paragraph of v.text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && probe.measureText(next).width > width * 0.9) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const canvas = makeCanvas(width, size * 1.25 * lines.length + size * 0.4);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 6;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = v.colour;
  lines.forEach((line, i) => {
    const y = size * 1.25 * i + size * 1.1;
    ctx.strokeText(line, width / 2, y);
    ctx.fillText(line, width / 2, y);
  });
  const y = { top: 'H*0.05', middle: '(H-h)/2', bottom: 'H-h-H*0.05' }[v.position];
  const enable = start || end ? `:enable='between(t,${start ? toSeconds(start) : 0},${end ? toSeconds(end) : 1e9})'` : '';
  const input = `input.${ext(file.name) || 'bin'}`;
  return execFFmpeg({
    inputs: [
      { name: input, data: file },
      { name: 'text.png', data: await encode(canvas, 'image/png') },
    ],
    args: [
      '-i', input, '-i', 'text.png',
      '-filter_complex', `[0:v][1:v]overlay=0:${y}${enable},scale=trunc(iw/2)*2:trunc(ih/2)*2[v]`,
      '-map', '[v]', '-map', '0:a?', ...H264, '-c:a', 'aac', '-movflags', '+faststart',
    ],
    outExt: 'mp4',
    name: `${base(file.name)}-texto.mp4`,
    progress,
  });
}

const isAudio = (f) => f.type.startsWith('audio/') || /^(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/.test(ext(f.name));
const isImage = (f) => f.type.startsWith('image/');

function addAudio({ files, v, progress }) {
  const audio = files.find(isAudio);
  const video = files.find((f) => f !== audio && !isAudio(f));
  if (!audio || !video) throw new Error('Elige dos archivos: el video y el audio.');
  const input = `input.${ext(video.name) || 'bin'}`;
  const track = `track.${ext(audio.name) || 'bin'}`;
  const volume = `volume=${v.volume / 100}`;
  // Mixing keeps the video's own sound under the new one; otherwise the new audio replaces it.
  const audioArgs =
    v.mode === 'mix'
      ? ['-filter_complex', `[1:a]${volume}[new];[0:a][new]amix=inputs=2:duration=first:dropout_transition=0[a]`, '-map', '0:v', '-map', '[a]']
      : // apad fills with silence when the audio is shorter, so -shortest always stops with the video.
        ['-map', '0:v', '-map', '1:a', '-filter:a', `${volume},apad`];
  return execFFmpeg({
    inputs: [
      { name: input, data: video },
      { name: track, data: audio },
    ],
    args: [
      '-i', input, ...(v.loop ? ['-stream_loop', '-1'] : []), '-i', track,
      ...audioArgs, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
    ],
    outExt: 'mp4',
    name: `${base(video.name)}-con-audio.mp4`,
    progress,
  });
}

const CORNER = {
  'top-left': ['M', 'M'],
  'top-right': ['W-w-M', 'M'],
  'bottom-left': ['M', 'H-h-M'],
  'bottom-right': ['W-w-M', 'H-h-M'],
  center: ['(W-w)/2', '(H-h)/2'],
};

async function imageOverVideo({ files, v, progress }) {
  const image = files.find(isImage);
  const video = files.find((f) => f !== image && !isImage(f));
  if (!image || !video) throw new Error('Elige dos archivos: el video y la imagen.');
  const start = time(v.start, 'El inicio');
  const end = time(v.end, 'El fin');
  const [width] = await videoSize(video);
  const size = Math.max(2, Math.round((width * v.size) / 100 / 2) * 2);
  const margin = Math.round(width * 0.03);
  const [x, y] = CORNER[v.position].map((e) => e.replaceAll('M', margin));
  const enable = start || end ? `:enable='between(t,${start ? toSeconds(start) : 0},${end ? toSeconds(end) : 1e9})'` : '';
  const input = `input.${ext(video.name) || 'bin'}`;
  const picture = `picture.${ext(image.name) || 'png'}`;
  return execFFmpeg({
    inputs: [
      { name: input, data: video },
      { name: picture, data: image },
    ],
    args: [
      '-i', input, '-i', picture,
      '-filter_complex',
      `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=${v.opacity / 100}[logo];[0:v][logo]overlay=${x}:${y}${enable},scale=trunc(iw/2)*2:trunc(ih/2)*2[v]`,
      '-map', '[v]', '-map', '0:a?', ...H264, '-c:a', 'aac', '-movflags', '+faststart',
    ],
    outExt: 'mp4',
    name: `${base(video.name)}-imagen.mp4`,
    progress,
  });
}

/** delogo needs the area in pixels and fully inside the frame (at least 1px from each edge). */
async function removeLogo({ file, v, progress }) {
  const [width, height] = await videoSize(file);
  if (!width) throw new Error('No se pudo leer el tamaño del video.');
  const w = Math.max(4, Math.round((width * v.width) / 100));
  const ht = Math.max(4, Math.round((height * v.height) / 100));
  const margin = Math.round(Math.min(width, height) * 0.02);
  const right = v.position.endsWith('right');
  const bottom = v.position.startsWith('bottom');
  const x = Math.min(width - w - 1, Math.max(1, right ? width - w - margin : margin));
  const y = Math.min(height - ht - 1, Math.max(1, bottom ? height - ht - margin : margin));
  const input = `input.${ext(file.name) || 'bin'}`;
  return execFFmpeg({
    inputs: [{ name: input, data: file }],
    args: ['-i', input, ...x264(23, `delogo=x=${x}:y=${y}:w=${w}:h=${ht}`), '-c:a', 'copy', '-movflags', '+faststart'],
    outExt: 'mp4',
    name: `${base(file.name)}-sin-logo.mp4`,
    progress,
  });
}

function addSubtitles({ files, progress }) {
  const isSubs = (f) => /^(srt|vtt)$/.test(ext(f.name));
  const subs = files.find(isSubs);
  const video = files.find((f) => !isSubs(f));
  if (!subs || !video) throw new Error('Elige dos archivos: el video y los subtítulos (.srt o .vtt).');
  // MP4 keeps its streams untouched; anything else goes to MKV, which accepts every codec.
  const mp4 = /^(mp4|m4v|mov)$/.test(ext(video.name));
  const input = `input.${ext(video.name) || 'bin'}`;
  const subsName = `subs.${ext(subs.name)}`;
  return execFFmpeg({
    inputs: [
      { name: input, data: video },
      { name: subsName, data: subs },
    ],
    args: ['-i', input, '-i', subsName, '-map', '0:v', '-map', '0:a?', '-map', '1', '-c:v', 'copy', '-c:a', 'copy', '-c:s', mp4 ? 'mov_text' : 'srt'],
    outExt: mp4 ? 'mp4' : 'mkv',
    name: `${base(video.name)}-subtitulos.${mp4 ? 'mp4' : 'mkv'}`,
    progress,
  });
}

export default [
  {
    id: 'video-unir',
    name: 'Unir videos',
    desc: 'Junta varios videos en uno, en el orden de la lista.',
    cat: 'video',
    action: 'Unir',
    files: { accept: 'video/*', multiple: true },
    fields: [
      {
        key: 'size',
        label: 'Tamaño del resultado',
        type: 'select',
        value: '1280x720',
        options: [
          ['1280x720', 'Horizontal 720p'],
          ['1920x1080', 'Horizontal 1080p'],
          ['720x1280', 'Vertical 720p'],
          ['1080x1920', 'Vertical 1080p'],
          ['1080x1080', 'Cuadrado 1080'],
        ],
      },
      { key: 'audio', label: 'Conservar el audio', type: 'checkbox', value: true, hint: 'Desmárcalo si algún video no tiene sonido.' },
    ],
    note: FFMPEG_NOTE,
    run: joinVideos,
  },
  {
    id: 'video-texto',
    name: 'Texto sobre video',
    desc: 'Escribe un título o rótulo encima del video.',
    cat: 'video',
    action: 'Añadir texto',
    files: { accept: 'video/*' },
    fields: [
      { key: 'text', label: 'Texto', type: 'textarea' },
      {
        key: 'position',
        label: 'Posición',
        type: 'select',
        value: 'bottom',
        options: [
          ['top', 'Arriba'],
          ['middle', 'Centro'],
          ['bottom', 'Abajo'],
        ],
      },
      { key: 'size', label: 'Tamaño', type: 'range', min: 3, max: 20, value: 7 },
      { key: 'colour', label: 'Color', type: 'color', value: '#ffffff' },
      { key: 'start', label: 'Mostrar desde', placeholder: '0:00', hint: 'Vacío = todo el video.' },
      { key: 'end', label: 'Mostrar hasta', placeholder: '0:10' },
    ],
    note: FFMPEG_NOTE,
    run: textOverVideo,
  },
  {
    id: 'video-subtitulos',
    name: 'Añadir subtítulos a video',
    desc: 'Incorpora un archivo .srt o .vtt como pista de subtítulos.',
    cat: 'video',
    action: 'Añadir subtítulos',
    files: { accept: 'video/*,.srt,.vtt', multiple: true, preview: false },
    note: 'Elige el video y el archivo de subtítulos. Quedan como pista que se activa en el reproductor, sin recomprimir el video.',
    run: addSubtitles,
  },
  {
    id: 'video-anadir-audio',
    name: 'Añadir audio a video',
    desc: 'Pon música o una voz a un video, en lugar de su sonido o mezclada con él.',
    cat: 'video',
    action: 'Añadir audio',
    files: { accept: 'video/*,audio/*', multiple: true, preview: false },
    fields: [
      {
        key: 'mode',
        label: 'Sonido original',
        type: 'select',
        value: 'replace',
        options: [
          ['replace', 'Reemplazarlo por el nuevo audio'],
          ['mix', 'Mezclarlo con el nuevo audio'],
        ],
      },
      { key: 'volume', label: 'Volumen del audio nuevo (%)', type: 'range', min: 0, max: 200, step: 5, value: 100 },
      { key: 'loop', label: 'Repetir el audio si es más corto que el video', type: 'checkbox', value: true },
    ],
    note: `Elige el video y el archivo de audio. El resultado dura lo mismo que el video. Para mezclar, el video debe tener sonido. ${FFMPEG_NOTE}`,
    run: addAudio,
  },
  {
    id: 'video-imagen',
    name: 'Imagen sobre video',
    desc: 'Pon un logo, una marca de agua o una foto encima del video.',
    cat: 'video',
    action: 'Añadir imagen',
    files: { accept: 'video/*,image/*', multiple: true, preview: false },
    fields: [
      {
        key: 'position',
        label: 'Posición',
        type: 'select',
        value: 'top-right',
        options: [
          ['top-left', 'Arriba a la izquierda'],
          ['top-right', 'Arriba a la derecha'],
          ['bottom-left', 'Abajo a la izquierda'],
          ['bottom-right', 'Abajo a la derecha'],
          ['center', 'Centro'],
        ],
      },
      { key: 'size', label: 'Ancho (% del video)', type: 'range', min: 5, max: 100, value: 20 },
      { key: 'opacity', label: 'Opacidad (%)', type: 'range', min: 10, max: 100, step: 5, value: 100 },
      { key: 'start', label: 'Mostrar desde', placeholder: '0:00', hint: 'Vacío = todo el video.' },
      { key: 'end', label: 'Mostrar hasta', placeholder: '0:10' },
    ],
    note: `Elige el video y la imagen (un PNG con fondo transparente queda mejor para logos). ${FFMPEG_NOTE}`,
    run: imageOverVideo,
  },
  {
    id: 'video-quitar-logo',
    name: 'Quitar logo de video',
    desc: 'Disimula una marca de agua o logo en una esquina del video.',
    cat: 'video',
    action: 'Quitar logo',
    files: { accept: 'video/*' },
    fields: [
      {
        key: 'position',
        label: 'Esquina del logo',
        type: 'select',
        value: 'bottom-right',
        options: [
          ['top-left', 'Arriba a la izquierda'],
          ['top-right', 'Arriba a la derecha'],
          ['bottom-left', 'Abajo a la izquierda'],
          ['bottom-right', 'Abajo a la derecha'],
        ],
      },
      { key: 'width', label: 'Ancho de la zona (% del video)', type: 'range', min: 3, max: 50, value: 15 },
      { key: 'height', label: 'Alto de la zona (% del video)', type: 'range', min: 3, max: 50, value: 10 },
    ],
    note: `Rellena la zona con los colores de su alrededor: el logo deja de leerse, pero se nota una mancha suave. ${FFMPEG_NOTE}`,
    run: removeLogo,
  },
  ffmpegTool({
    id: 'video-encuadre',
    name: 'Cambiar encuadre de video',
    desc: 'Recorta a vertical, cuadrado u horizontal para redes.',
    cat: 'video',
    action: 'Recortar',
    fields: [
      {
        key: 'ratio',
        label: 'Formato',
        type: 'select',
        value: '9/16',
        options: [
          ['9/16', 'Vertical 9:16 (TikTok, Reels)'],
          ['4/5', 'Vertical 4:5 (Instagram)'],
          ['1/1', 'Cuadrado 1:1'],
          ['16/9', 'Horizontal 16:9'],
        ],
      },
    ],
    // Largest centred area with that shape.
    build: (v) => ({ args: [...x264(23, `crop='min(iw,ih*${v.ratio})':'min(ih,iw/(${v.ratio}))'`), '-c:a', 'aac', '-movflags', '+faststart'], outExt: 'mp4' }),
  }),
  {
    id: 'audio-unir',
    name: 'Unir audios',
    desc: 'Junta varios audios en uno, en el orden de la lista.',
    cat: 'audio',
    action: 'Unir',
    files: { accept: 'audio/*,video/*', multiple: true },
    fields: [audioFormat, bitrate],
    note: FFMPEG_NOTE,
    run: joinAudios,
  },
];
