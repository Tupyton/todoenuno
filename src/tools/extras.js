import { ANDROID, DESKTOP } from '../env.js';
import { componentJob, ensureComponents, renamed } from '../lib/components.js';
import { drawn, encode, loadImage, makeCanvas } from '../lib/image.js';
import { base64 } from '../lib/platform.js';
import { fieldEl } from '../tool-page.js';
import { base, h } from '../ui.js';

/*
 * Tools of the desktop app that need an optional component, downloaded the first time they are used
 * (see electron/components.js). In the browser they only point to the Windows version.
 */

const desktopTool = (tool) => ({
  ...tool,
  desktopOnly: true,
  blocked: () => !DESKTOP && 'Esta herramienta solo está en la versión para Windows: necesita programas que un navegador no puede ejecutar.',
});

/** Both stages, download and work, share the progress bar: the download takes its first half. */
const halves = (progress) => [(p) => progress(p / 2), (p) => progress(0.5 + p / 2)];

async function transcribe({ file, v, progress }) {
  const [downloading, working] = halves(progress);
  await ensureComponents(['whisper', `whisper-${v.model}`], downloading);
  const blob = await componentJob('/api/transcribe', { model: v.model, lang: v.lang, format: v.format }, file, working);
  const text = await blob.text();
  return [{ blob, name: `${base(file.name)}.${v.format}` }, text];
}

async function upscale({ file, v, progress }) {
  const [downloading, working] = halves(progress);
  await ensureComponents(['realesrgan'], downloading);
  const blob = await componentJob('/api/upscale', { scale: v.scale, model: v.model }, file, working);
  return { blob: new Blob([blob], { type: 'image/png' }), name: renamed(file, `x${v.scale}`, 'png') };
}

/* Background removal: the silueta model (a compact U²-Net) run with ONNX Runtime inside the page. */

const SIDE = 320; // the model's input size
let session;

// The Android app downloads the model through its own plugin (android/…/ComponentsPlugin.java), since
// GitHub does not let the page fetch it; ONNX Runtime itself comes inside the APK.
const SILUETA = { file: 'silueta.onnx', sha256: '75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb' };
let componentsPlugin;

async function androidModel(progress) {
  const { registerPlugin, Capacitor } = await import('@capacitor/core');
  componentsPlugin ??= registerPlugin('Components');
  const listener = await componentsPlugin.addListener('progress', (event) => progress(event.progress));
  try {
    const { path } = await componentsPlugin.get(SILUETA);
    return Capacitor.convertFileSrc(`file://${path}`);
  } finally {
    listener.remove();
  }
}

/** Where the model is, after downloading it if needed. */
async function modelUrl(progress) {
  if (ANDROID) return androidModel(progress);
  await ensureComponents(['ort', 'silueta'], progress);
  return '/components/silueta.onnx';
}

async function model(url) {
  // Served by the app from the downloaded component, so the address is only known at run time.
  const folder = new URL('/components/ort/', location.href).href;
  const ort = await import(/* @vite-ignore */ `${folder}ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = folder;
  // One thread needs no cross-origin isolation, which this local page does not have.
  ort.env.wasm.numThreads = 1;
  session ??= await ort.InferenceSession.create(url);
  return { ort, session };
}

async function removeBackground({ file, progress }) {
  const [downloading, working] = halves(progress);
  const { ort, session: s } = await model(await modelUrl(downloading));
  working(0.2);
  const img = await loadImage(file);
  const pixels = drawn(img, SIDE, SIDE).getContext('2d').getImageData(0, 0, SIDE, SIDE).data;
  // Same input as the model was trained with: scaled by the brightest value, then normalised with
  // ImageNet's mean and standard deviation, one plane per colour.
  let max = 1;
  for (let i = 0; i < pixels.length; i += 4) max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
  const area = SIDE * SIDE;
  const input = new Float32Array(3 * area);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let p = 0; p < area; p++) {
    for (let c = 0; c < 3; c++) input[c * area + p] = (pixels[p * 4 + c] / max - mean[c]) / std[c];
  }
  const output = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]) });
  working(0.8);
  const prediction = output[s.outputNames[0]].data;
  let lo = Infinity;
  let hi = -Infinity;
  for (let p = 0; p < area; p++) {
    lo = Math.min(lo, prediction[p]);
    hi = Math.max(hi, prediction[p]);
  }
  const mask = makeCanvas(SIDE, SIDE);
  const maskCtx = mask.getContext('2d');
  const maskData = maskCtx.createImageData(SIDE, SIDE);
  for (let p = 0; p < area; p++) maskData.data[p * 4 + 3] = ((prediction[p] - lo) / (hi - lo || 1)) * 255;
  maskCtx.putImageData(maskData, 0, 0);
  // The mask is scaled up to the picture and keeps only the subject.
  const result = drawn(img);
  const ctx = result.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mask, 0, 0, result.width, result.height);
  return { blob: await encode(result, 'image/png'), name: renamed(file, 'sin-fondo', 'png') };
}

/*
 * WhatsApp stickers: a WebP of exactly 512×512 up to 100 KB, transparent around the picture. The
 * Android app can also add them to WhatsApp as a pack, which WhatsApp only takes with 3 to 30
 * stickers (android/…/StickersPlugin.java).
 */
const STICKER = 512;
const STICKER_MAX = 100 * 1024;
const TRAY = 96;

/** The picture fitted inside the square, with an optional white outline and a caption at the bottom. */
function stickerCanvas(img, { border, text }) {
  const canvas = makeCanvas(STICKER, STICKER);
  const ctx = canvas.getContext('2d');
  const outline = border ? 10 : 0;
  const room = STICKER - 2 * (16 + outline); // WhatsApp asks for a 16 px margin
  const scale = Math.min(room / img.naturalWidth, room / img.naturalHeight);
  const [width, height] = [img.naturalWidth * scale, img.naturalHeight * scale];
  const [x, y] = [(STICKER - width) / 2, (STICKER - height) / 2];
  if (outline) {
    // The outline is the picture's shape in white, stamped around it in a circle.
    const shape = makeCanvas(STICKER, STICKER);
    const shapeCtx = shape.getContext('2d');
    shapeCtx.drawImage(img, x, y, width, height);
    shapeCtx.globalCompositeOperation = 'source-in';
    shapeCtx.fillStyle = '#fff';
    shapeCtx.fillRect(0, 0, STICKER, STICKER);
    for (let a = 0; a < 24; a++) {
      const angle = (a / 24) * 2 * Math.PI;
      ctx.drawImage(shape, Math.cos(angle) * outline, Math.sin(angle) * outline);
    }
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, width, height);
  const caption = text.trim();
  if (caption) {
    let size = 72;
    const font = () => `800 ${size}px system-ui, sans-serif`;
    ctx.font = font();
    while (size > 12 && ctx.measureText(caption).width > STICKER - 32) {
      size -= 2;
      ctx.font = font();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size / 5;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.strokeText(caption, STICKER / 2, STICKER - 16);
    ctx.fillText(caption, STICKER / 2, STICKER - 16);
  }
  return canvas;
}

/** WebP at the highest quality that stays under WhatsApp's limit. */
async function encodeSticker(canvas) {
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const blob = await encode(canvas, 'image/webp', quality);
    // Browsers that cannot write WebP hand back a PNG instead of failing.
    if (blob.type !== 'image/webp') throw new Error('Este navegador no puede crear imágenes WebP. Prueba con Chrome, Edge o Firefox.');
    if (blob.size <= STICKER_MAX) return blob;
  }
  throw new Error('La imagen tiene demasiado detalle para caber en los 100 KB de un sticker.');
}

/** Android: name and emoji of the pack, and the button that hands it to WhatsApp. */
function whatsappPanel(stickers) {
  const note = h('p', { class: 'status', role: 'status' });
  if (stickers.length < 3 || stickers.length > 30) {
    note.textContent = 'Para añadirlos a WhatsApp como paquete elige entre 3 y 30 imágenes: WhatsApp no acepta otros tamaños de paquete.';
    return h('div', { class: 'result' }, note);
  }
  const values = {};
  const fields = [
    fieldEl({ key: 'name', label: 'Nombre del paquete', value: 'Mis stickers', maxlength: 128 }, values, () => {}),
    fieldEl({ key: 'emoji', label: 'Emoji de los stickers', value: '😀', maxlength: 8, hint: 'WhatsApp lo usa para sugerirlos al escribir.' }, values, () => {}),
  ];
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn primary',
      async onclick() {
        button.disabled = true;
        note.classList.remove('error');
        note.textContent = 'Preparando el paquete…';
        try {
          const first = await loadImage(new File([stickers[0].blob], stickers[0].name));
          const tray = await encode(drawn(first, TRAY, TRAY), 'image/png');
          const { registerPlugin } = await import('@capacitor/core');
          const { added } = await registerPlugin('Stickers').addToWhatsApp({
            name: values.name,
            emoji: values.emoji,
            tray: await base64(tray),
            stickers: await Promise.all(stickers.map((s) => base64(s.blob))),
          });
          note.textContent = added ? 'Paquete añadido a WhatsApp.' : 'No se añadió el paquete.';
        } catch (error) {
          note.textContent = error.message || String(error);
          note.classList.add('error');
        } finally {
          button.disabled = false;
        }
      },
    },
    'Añadir a WhatsApp',
  );
  return h('div', { class: 'result' }, h('div', { class: 'fields' }, fields), h('div', { class: 'result-row' }, button), note);
}

async function makeStickers({ files, v, progress }) {
  const stickers = [];
  for (const [i, file] of files.entries()) {
    const step = (p) => progress((i + (Number.isFinite(p) ? p : 0)) / files.length);
    const source = v.background ? new File([(await removeBackground({ file, progress: step })).blob], file.name) : file;
    const img = await loadImage(source);
    stickers.push({ blob: await encodeSticker(stickerCanvas(img, v)), name: renamed(file, 'sticker', 'webp') });
    step(1);
  }
  return ANDROID ? [whatsappPanel(stickers), ...stickers] : stickers;
}

export default [
  desktopTool({
    id: 'audio-transcribir',
    name: 'Transcribir audio o video',
    desc: 'Convierte lo que se dice en un audio o video en texto o subtítulos.',
    cat: 'audio',
    files: { accept: 'audio/*,video/*' },
    fields: [
      {
        key: 'model',
        label: 'Modelo',
        type: 'select',
        value: 'base',
        options: [
          ['base', 'Rápido (descarga 64 MB)'],
          ['small', 'Preciso (descarga 194 MB)'],
        ],
      },
      {
        key: 'lang',
        label: 'Idioma',
        type: 'select',
        value: 'es',
        options: [
          ['es', 'Español'],
          ['en', 'Inglés'],
          ['pt', 'Portugués'],
          ['fr', 'Francés'],
          ['de', 'Alemán'],
          ['it', 'Italiano'],
          ['auto', 'Detectar'],
        ],
      },
      {
        key: 'format',
        label: 'Resultado',
        type: 'select',
        value: 'srt',
        options: [
          ['srt', 'Subtítulos SRT'],
          ['vtt', 'Subtítulos VTT'],
          ['txt', 'Solo texto'],
        ],
      },
    ],
    note: 'Funciona sin conexión con whisper.cpp. La primera vez descarga el modelo elegido. Un minuto de audio tarda entre unos segundos y un minuto, según el equipo.',
    action: 'Transcribir',
    run: transcribe,
  }),
  desktopTool({
    id: 'imagen-ampliar',
    name: 'Aumentar resolución',
    desc: 'Agranda una imagen 2 o 4 veces recuperando el detalle.',
    cat: 'imagen',
    files: { accept: 'image/*' },
    fields: [
      {
        key: 'scale',
        label: 'Aumento',
        type: 'select',
        value: '2',
        options: [
          ['2', '2 veces'],
          ['4', '4 veces'],
        ],
      },
      {
        key: 'model',
        label: 'Tipo de imagen',
        type: 'select',
        value: 'foto',
        options: [
          ['foto', 'Foto'],
          ['dibujo', 'Dibujo o anime'],
        ],
      },
    ],
    note: 'Usa Real-ESRGAN con la tarjeta gráfica (Vulkan). La primera vez descarga 41 MB.',
    action: 'Aumentar',
    run: upscale,
  }),
  {
    // Also in the Android app, where it runs on the phone's processor.
    desktopOnly: true,
    alsoAndroid: true,
    blocked: () => !DESKTOP && !ANDROID && 'Esta herramienta solo está en las versiones para Windows y Android: necesita un modelo que se descarga aparte.',
    id: 'imagen-quitar-fondo',
    name: 'Quitar fondo',
    desc: 'Deja solo a la persona u objeto principal, con fondo transparente.',
    cat: 'imagen',
    files: { accept: 'image/*' },
    note: ANDROID
      ? 'Usa bastante batería y procesador durante unos segundos por imagen; mejor con el teléfono cargado. La primera vez descarga 44 MB; después funciona sin conexión. El resultado es un PNG transparente.'
      : 'Funciona sin conexión. La primera vez descarga 48 MB. El resultado es un PNG transparente.',
    action: 'Quitar fondo',
    run: removeBackground,
  },
  {
    id: 'imagen-sticker',
    name: 'Sticker de WhatsApp',
    desc: ANDROID ? 'Convierte fotos en stickers y añádelos a WhatsApp.' : 'Convierte una foto en un sticker para WhatsApp.',
    cat: 'imagen',
    files: { accept: 'image/*', multiple: true },
    fields: [
      { key: 'background', label: 'Quitar fondo', type: 'checkbox', value: true },
      { key: 'border', label: 'Borde blanco', type: 'checkbox', value: true },
      { key: 'text', label: 'Texto (opcional)', placeholder: 'Escribe algo…', maxlength: 40 },
    ],
    note: ANDROID
      ? 'Quitar el fondo descarga 44 MB la primera vez. Para añadirlos a WhatsApp elige entre 3 y 30 fotos; WhatsApp no acepta paquetes más pequeños.'
      : 'Quitar el fondo descarga 48 MB la primera vez. La app de Android de TodoEnUno también los añade a WhatsApp como paquete.',
    action: 'Crear stickers',
    folder: false,
    run: makeStickers,
  },
];
