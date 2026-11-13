import { DESKTOP } from '../env.js';
import { componentJob, ensureComponents, renamed } from '../lib/components.js';
import { drawn, encode, loadImage, makeCanvas } from '../lib/image.js';
import { base } from '../ui.js';

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

async function model() {
  // Served by the app from the downloaded component, so the address is only known at run time.
  const folder = new URL('/components/ort/', location.href).href;
  const ort = await import(/* @vite-ignore */ `${folder}ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = folder;
  // One thread needs no cross-origin isolation, which this local page does not have.
  ort.env.wasm.numThreads = 1;
  session ??= await ort.InferenceSession.create('/components/silueta.onnx');
  return { ort, session };
}

async function removeBackground({ file, progress }) {
  const [downloading, working] = halves(progress);
  await ensureComponents(['ort', 'silueta'], downloading);
  const { ort, session: s } = await model();
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
  desktopTool({
    id: 'imagen-quitar-fondo',
    name: 'Quitar fondo',
    desc: 'Deja solo a la persona u objeto principal, con fondo transparente.',
    cat: 'imagen',
    files: { accept: 'image/*' },
    note: 'Funciona sin conexión. La primera vez descarga 48 MB. El resultado es un PNG transparente.',
    action: 'Quitar fondo',
    run: removeBackground,
  }),
];
