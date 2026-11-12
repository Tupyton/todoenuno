import { drawn, encode, loadImage, makeCanvas, outputType, rename } from '../lib/image.js';
import { fileZone, resultView } from '../tool-page.js';
import { clamp, h } from '../ui.js';

const IMAGES = { accept: 'image/*', multiple: true };

const format = (value = 'same') => ({
  key: 'format',
  label: 'Formato de salida',
  type: 'select',
  value,
  options: [
    ['same', 'Igual que el original'],
    ['image/jpeg', 'JPG'],
    ['image/png', 'PNG'],
    ['image/webp', 'WebP'],
  ],
});

const quality = (value = 92) => ({
  key: 'quality',
  label: 'Calidad',
  type: 'range',
  min: 1,
  max: 100,
  value,
  hint: 'Solo afecta a JPG y WebP.',
});

/** Applies `toCanvas(img, file)` to every file and encodes the result. */
async function each(files, v, progress, suffix, toCanvas) {
  const results = [];
  for (const [i, file] of files.entries()) {
    const type = outputType(file, v.format);
    const canvas = await toCanvas(await loadImage(file), file);
    results.push({ blob: await encode(canvas, type, (v.quality ?? 92) / 100), name: rename(file, suffix, type) });
    progress((i + 1) / files.length);
  }
  return results;
}

function rotated(img, angle, flipH, flipV) {
  const { naturalWidth: w, naturalHeight: ht } = img;
  const swap = angle % 180 !== 0;
  const canvas = makeCanvas(swap ? ht : w, swap ? w : ht);
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(img, -w / 2, -ht / 2);
  return canvas;
}

function watermarked(img, v) {
  const canvas = drawn(img);
  const ctx = canvas.getContext('2d');
  const { width: w, height: ht } = canvas;
  const size = Math.max(10, (w * v.size) / 100);
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.fillStyle = v.color;
  ctx.globalAlpha = v.opacity / 100;
  ctx.textBaseline = 'middle';
  if (v.position === 'tile') {
    ctx.textAlign = 'center';
    ctx.translate(w / 2, ht / 2);
    ctx.rotate(-Math.PI / 6);
    const stepX = ctx.measureText(v.text).width + size * 2;
    const reach = Math.hypot(w, ht);
    for (let y = -reach; y < reach; y += size * 3) {
      for (let x = -reach; x < reach; x += stepX) ctx.fillText(v.text, x, y);
    }
    return canvas;
  }
  const pad = size;
  const [x, y, align] = {
    center: [w / 2, ht / 2, 'center'],
    tl: [pad, pad, 'left'],
    tr: [w - pad, pad, 'right'],
    bl: [pad, ht - pad, 'left'],
    br: [w - pad, ht - pad, 'right'],
  }[v.position];
  ctx.textAlign = align;
  ctx.fillText(v.text, x, y);
  return canvas;
}

async function joined(files, v) {
  if (files.length < 2) throw new Error('Selecciona al menos dos imágenes.');
  const images = await Promise.all(files.map(loadImage));
  const vertical = v.direction === 'vertical';
  // Scale every image to the largest cross-axis size so the edges line up.
  const cross = Math.max(...images.map((i) => (vertical ? i.naturalWidth : i.naturalHeight)));
  const sizes = images.map((i) => {
    const scale = cross / (vertical ? i.naturalWidth : i.naturalHeight);
    return [Math.round(i.naturalWidth * scale), Math.round(i.naturalHeight * scale)];
  });
  const main = sizes.reduce((sum, [w, ht]) => sum + (vertical ? ht : w), 0) + v.gap * (images.length - 1);
  const canvas = makeCanvas(vertical ? cross : main, vertical ? main : cross);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = v.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let offset = 0;
  images.forEach((img, i) => {
    const [w, ht] = sizes[i];
    ctx.drawImage(img, vertical ? 0 : offset, vertical ? offset : 0, w, ht);
    offset += (vertical ? ht : w) + v.gap;
  });
  return { blob: await encode(canvas, 'image/png'), name: 'imagenes-unidas.png' };
}

const FAVICONS = [
  [16, 'favicon-16x16.png'],
  [32, 'favicon-32x32.png'],
  [48, 'favicon-48x48.png'],
  [180, 'apple-touch-icon.png'],
  [192, 'android-chrome-192x192.png'],
  [512, 'android-chrome-512x512.png'],
];

async function favicons(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  return Promise.all(
    FAVICONS.map(async ([size, name]) => {
      const canvas = makeCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      return { blob: await encode(canvas, 'image/png'), name };
    }),
  );
}

function renderCrop(root) {
  let img = null;
  let file = null;
  let selection = null;
  let origin = null;
  const canvas = h('canvas', { class: 'crop', hidden: true });
  const ctx = canvas.getContext('2d');
  const status = h('p', { class: 'status', role: 'status' });
  const out = resultView();

  function paint() {
    ctx.drawImage(img, 0, 0);
    if (!selection) return;
    const { x, y, w, ht } = selection;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(x, y, w, ht);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, canvas.width / 400);
    ctx.strokeRect(x, y, w, ht);
    status.textContent = `Selección: ${w} × ${ht} px`;
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      clamp(((event.clientX - rect.left) * canvas.width) / rect.width, 0, canvas.width),
      clamp(((event.clientY - rect.top) * canvas.height) / rect.height, 0, canvas.height),
    ];
  }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    origin = point(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!origin) return;
    const [x, y] = point(event);
    selection = {
      x: Math.round(Math.min(x, origin[0])),
      y: Math.round(Math.min(y, origin[1])),
      w: Math.round(Math.abs(x - origin[0])),
      ht: Math.round(Math.abs(y - origin[1])),
    };
    paint();
  });
  canvas.addEventListener('pointerup', () => (origin = null));

  const zone = fileZone({ accept: 'image/*', preview: false }, async (files) => {
    file = files[0] || null;
    selection = null;
    out.clear();
    canvas.hidden = true;
    status.classList.remove('error');
    status.textContent = '';
    if (!file) return;
    try {
      img = await loadImage(file);
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
      return;
    }
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.hidden = false;
    paint();
    status.textContent = 'Arrastra sobre la imagen para marcar el área.';
  });

  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn primary',
      async onclick() {
        if (!selection || selection.w < 1 || selection.ht < 1) {
          status.textContent = 'Marca un área sobre la imagen primero.';
          return;
        }
        const { x, y, w, ht } = selection;
        const cropped = makeCanvas(w, ht);
        cropped.getContext('2d').drawImage(img, x, y, w, ht, 0, 0, w, ht);
        const type = outputType(file, 'same');
        out.show({ blob: await encode(cropped, type, 0.92), name: rename(file, 'recorte', type) });
      },
    },
    'Recortar',
  );

  root.append(zone.el, canvas, status, button, out.el);
  return () => {
    out.clear();
    zone.destroy();
  };
}

const image = (tool) => ({ cat: 'imagen', files: IMAGES, ...tool });

export default [
  image({
    id: 'imagen-convertir',
    name: 'Convertir imagen',
    desc: 'Pasa imágenes a JPG, PNG o WebP.',
    action: 'Convertir',
    fields: [format('image/jpeg'), quality()],
    run: ({ files, v, progress }) => each(files, v, progress, 'convertida', (img) => drawn(img)),
  }),
  image({
    id: 'imagen-comprimir',
    name: 'Comprimir imagen',
    desc: 'Reduce el peso bajando calidad y tamaño.',
    action: 'Comprimir',
    fields: [
      { ...format('image/jpeg'), hint: 'PNG no admite ajuste de calidad.' },
      quality(70),
      { key: 'maxSide', label: 'Lado máximo (px)', type: 'number', min: 0, value: 0, hint: '0 = sin cambio de tamaño.' },
    ],
    run: ({ files, v, progress }) =>
      each(files, v, progress, 'comprimida', (img) => {
        const scale = v.maxSide > 0 ? Math.min(1, v.maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
        return drawn(img, img.naturalWidth * scale, img.naturalHeight * scale);
      }),
  }),
  image({
    id: 'imagen-redimensionar',
    name: 'Redimensionar imagen',
    desc: 'Cambia el ancho y el alto en píxeles.',
    action: 'Redimensionar',
    fields: [
      { key: 'width', label: 'Ancho (px)', type: 'number', min: 0, value: 1280 },
      { key: 'height', label: 'Alto (px)', type: 'number', min: 0, value: 0, hint: '0 = proporcional al otro lado.' },
      format(),
    ],
    run: ({ files, v, progress }) => {
      if (!(v.width > 0) && !(v.height > 0)) throw new Error('Indica el ancho, el alto o ambos.');
      return each(files, v, progress, 'redimensionada', (img) => {
        const ratio = img.naturalWidth / img.naturalHeight;
        return drawn(img, v.width > 0 ? v.width : v.height * ratio, v.height > 0 ? v.height : v.width / ratio);
      });
    },
  }),
  { id: 'imagen-recortar', name: 'Recortar imagen', desc: 'Marca un área con el ratón y recórtala.', cat: 'imagen', render: renderCrop },
  image({
    id: 'imagen-rotar',
    name: 'Rotar y voltear imagen',
    desc: 'Gira 90°, 180° o 270° y aplica espejo.',
    action: 'Aplicar',
    fields: [
      {
        key: 'angle',
        label: 'Rotación',
        type: 'select',
        value: '90',
        options: [
          ['0', 'Sin rotar'],
          ['90', '90° a la derecha'],
          ['180', '180°'],
          ['270', '90° a la izquierda'],
        ],
      },
      { key: 'flipH', label: 'Espejo horizontal', type: 'checkbox' },
      { key: 'flipV', label: 'Espejo vertical', type: 'checkbox' },
      format(),
    ],
    run: ({ files, v, progress }) => each(files, v, progress, 'rotada', (img) => rotated(img, Number(v.angle), v.flipH, v.flipV)),
  }),
  image({
    id: 'imagen-filtros',
    name: 'Filtros de imagen',
    desc: 'Blanco y negro, sepia, desenfoque, brillo y más.',
    action: 'Aplicar filtros',
    fields: [
      { key: 'grayscale', label: 'Escala de grises (%)', type: 'range', min: 0, max: 100, value: 0 },
      { key: 'sepia', label: 'Sepia (%)', type: 'range', min: 0, max: 100, value: 0 },
      { key: 'invert', label: 'Invertir (%)', type: 'range', min: 0, max: 100, value: 0 },
      { key: 'blur', label: 'Desenfoque (px)', type: 'range', min: 0, max: 40, value: 0 },
      { key: 'brightness', label: 'Brillo (%)', type: 'range', min: 0, max: 200, value: 100 },
      { key: 'contrast', label: 'Contraste (%)', type: 'range', min: 0, max: 200, value: 100 },
      { key: 'saturate', label: 'Saturación (%)', type: 'range', min: 0, max: 300, value: 100 },
      { key: 'hue', label: 'Tono (°)', type: 'range', min: 0, max: 360, value: 0 },
      format(),
    ],
    run: ({ files, v, progress }) => {
      const filter =
        `grayscale(${v.grayscale}%) sepia(${v.sepia}%) invert(${v.invert}%) blur(${v.blur}px) ` +
        `brightness(${v.brightness}%) contrast(${v.contrast}%) saturate(${v.saturate}%) hue-rotate(${v.hue}deg)`;
      return each(files, v, progress, 'filtro', (img) => drawn(img, undefined, undefined, filter));
    },
  }),
  image({
    id: 'imagen-marca-agua',
    name: 'Marca de agua en imagen',
    desc: 'Añade un texto sobre tus imágenes.',
    action: 'Añadir marca',
    fields: [
      { key: 'text', label: 'Texto', value: '© Mi marca' },
      {
        key: 'position',
        label: 'Posición',
        type: 'select',
        value: 'br',
        options: [
          ['center', 'Centro'],
          ['tl', 'Arriba izquierda'],
          ['tr', 'Arriba derecha'],
          ['bl', 'Abajo izquierda'],
          ['br', 'Abajo derecha'],
          ['tile', 'Mosaico'],
        ],
      },
      { key: 'size', label: 'Tamaño (% del ancho)', type: 'range', min: 1, max: 20, value: 4 },
      { key: 'opacity', label: 'Opacidad (%)', type: 'range', min: 5, max: 100, value: 50 },
      { key: 'color', label: 'Color', type: 'color', value: '#ffffff' },
      format(),
    ],
    run: ({ files, v, progress }) => {
      if (!v.text.trim()) throw new Error('Escribe el texto de la marca de agua.');
      return each(files, v, progress, 'marca', (img) => watermarked(img, v));
    },
  }),
  image({
    id: 'imagen-esquinas',
    name: 'Redondear esquinas',
    desc: 'Esquinas redondeadas o recorte circular, en PNG.',
    action: 'Redondear',
    fields: [{ key: 'radius', label: 'Radio (% del lado menor)', type: 'range', min: 1, max: 50, value: 50, hint: '50 = círculo en imágenes cuadradas.' }],
    run: ({ files, v, progress }) =>
      each(files, { format: 'image/png' }, progress, 'redondeada', (img) => {
        const canvas = makeCanvas(img.naturalWidth, img.naturalHeight);
        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.roundRect(0, 0, canvas.width, canvas.height, (Math.min(canvas.width, canvas.height) * v.radius) / 100);
        ctx.clip();
        ctx.drawImage(img, 0, 0);
        return canvas;
      }),
  }),
  image({
    id: 'imagen-unir',
    name: 'Unir imágenes',
    desc: 'Combina varias imágenes en una, en vertical u horizontal.',
    action: 'Unir',
    fields: [
      {
        key: 'direction',
        label: 'Dirección',
        type: 'select',
        value: 'vertical',
        options: [
          ['vertical', 'Vertical'],
          ['horizontal', 'Horizontal'],
        ],
      },
      { key: 'gap', label: 'Separación (px)', type: 'number', min: 0, value: 0 },
      { key: 'background', label: 'Color de fondo', type: 'color', value: '#ffffff' },
    ],
    run: ({ files, v }) => joined(files, v),
  }),
  image({
    id: 'imagen-metadatos',
    name: 'Quitar metadatos (EXIF)',
    desc: 'Elimina ubicación, cámara y fecha de tus fotos.',
    action: 'Limpiar',
    note: 'La imagen se vuelve a codificar; los JPG pierden una mínima calidad.',
    run: ({ files, progress }) => each(files, { format: 'same', quality: 95 }, progress, 'limpia', (img) => drawn(img)),
  }),
  image({
    id: 'imagen-favicons',
    name: 'Generar favicons',
    desc: 'Crea los iconos PNG de un sitio web desde una imagen.',
    files: { accept: 'image/*' },
    action: 'Generar',
    note: 'Si la imagen no es cuadrada, se recorta al centro.',
    run: ({ file }) => favicons(file),
  }),
];
