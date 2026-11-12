import { encode, loadImage, makeCanvas } from '../lib/image.js';
import { fileZone, resultView } from '../tool-page.js';
import { base, clamp, h } from '../ui.js';

const IMAGES = { accept: 'image/*', multiple: true };

/** Draws `img` filling the box, cropping what overflows (like CSS object-fit: cover). */
function cover(ctx, img, x, y, w, ht) {
  const scale = Math.max(w / img.naturalWidth, ht / img.naturalHeight);
  const sw = w / scale;
  const sh = ht / scale;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, ht);
}

async function collage({ files, v }) {
  if (files.length < 2) throw new Error('Elige al menos dos imágenes.');
  const cols = clamp(Math.round(v.cols) || 2, 1, files.length);
  const rows = Math.ceil(files.length / cols);
  const [rw, rh] = v.ratio.split(':').map(Number);
  const cw = clamp(Math.round(v.cell) || 600, 50, 2000);
  const ch = Math.round((cw * rh) / rw);
  const gap = clamp(Math.round(v.gap) || 0, 0, 200);
  const canvas = makeCanvas(cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = v.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  for (const [i, file] of files.entries()) {
    cover(ctx, await loadImage(file), gap + (i % cols) * (cw + gap), gap + Math.floor(i / cols) * (ch + gap), cw, ch);
  }
  return { blob: await encode(canvas, 'image/jpeg', 0.92), name: 'collage.jpg' };
}

/** Splits text into lines no wider than `width` with the context's current font. */
function wrap(ctx, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/* Meme editor */

const MEME_FONT = "Impact, 'Arial Black', 'Helvetica Neue', sans-serif";
// Sizes are percentages of the picture's width: [min, max, initial].
const TEXT_SIZE = [3, 25, 9];
const STICKER_SIZE = [5, 100, 35];

/** Black for light colours and white for dark ones, so the outline always shows. */
function outlineFor(colour) {
  const n = parseInt(colour.slice(1), 16);
  const light = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  return light > 110 ? '#000' : '#fff';
}

function renderMeme(root) {
  let file = null;
  let picture = null;
  // Drawn in order: the last one is on top. Text: { text, x, y, anchor, size, colour }. Sticker: { img, name, x, y, size }.
  let layers = [];
  let selected = null;
  let drag = null;
  const out = resultView();
  const status = h('p', { class: 'status', role: 'status' });
  const canvas = h('canvas', { class: 'crop move', hidden: true });
  const ctx = canvas.getContext('2d');
  const list = h('ul', { class: 'files layers' });

  const size = h('input', {
    type: 'range',
    oninput() {
      selected.size = Number(size.value);
      changed();
    },
  });
  const colour = h('input', {
    type: 'color',
    oninput() {
      selected.colour = colour.value;
      changed();
    },
  });
  const sizeField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Tamaño'), size);
  const colourField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Color del texto'), colour);

  function draw(outline = true) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture, 0, 0);
    for (const layer of layers) {
      // The box is what the pointer can grab; a text with nothing written has none.
      layer.box = null;
      if (layer.img) {
        const width = (canvas.width * layer.size) / 100;
        const height = (width * layer.img.naturalHeight) / layer.img.naturalWidth;
        layer.box = [layer.x - width / 2, layer.y - height / 2, width, height];
        ctx.drawImage(layer.img, ...layer.box);
      } else if (layer.text.trim()) {
        const px = (canvas.width * layer.size) / 100;
        ctx.font = `900 ${px}px ${MEME_FONT}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = layer.colour;
        ctx.strokeStyle = outlineFor(layer.colour);
        ctx.lineWidth = px / 8;
        ctx.lineJoin = 'round';
        const lines = wrap(ctx, layer.text.toUpperCase(), canvas.width * 0.94);
        const height = lines.length * px;
        // The anchor keeps the top text growing downwards and the bottom one upwards as lines are added.
        const top = layer.anchor === 'top' ? layer.y : layer.anchor === 'bottom' ? layer.y - height : layer.y - height / 2;
        lines.forEach((line, i) => {
          const y = top + px * (i + 0.85);
          ctx.strokeText(line, layer.x, y);
          ctx.fillText(line, layer.x, y);
        });
        const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
        layer.box = [layer.x - width / 2, top, width, height];
      }
    }
    if (outline && selected?.box) {
      const dash = Math.max(4, canvas.width / 80);
      ctx.save();
      ctx.lineWidth = Math.max(2, canvas.width / 300);
      ctx.setLineDash([dash, dash]);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(...selected.box);
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = '#000';
      ctx.strokeRect(...selected.box);
      ctx.restore();
    }
  }

  function changed() {
    out.clear();
    draw();
  }

  function select(layer) {
    selected = layer;
    layers.forEach((l) => l.row.classList.toggle('selected', l === layer));
    sizeField.hidden = !layer;
    colourField.hidden = !layer || !!layer.img;
    if (layer) {
      const [min, max] = layer.img ? STICKER_SIZE : TEXT_SIZE;
      // Limits first: a range input clamps its value to the limits it already has.
      size.min = min;
      size.max = max;
      size.value = layer.size;
      if (!layer.img) colour.value = layer.colour;
    }
    draw();
  }

  function add(layer) {
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'icon',
        title: 'Quitar',
        'aria-label': 'Quitar',
        onclick(event) {
          event.stopPropagation();
          layers = layers.filter((l) => l !== layer);
          layer.row.remove();
          select(selected === layer ? null : selected);
          out.clear();
        },
      },
      '✕',
    );
    const body = layer.img
      ? h('span', { class: 'fname' }, `Imagen: ${layer.name}`)
      : h('input', {
          type: 'text',
          placeholder: layer.placeholder || 'Texto',
          'aria-label': layer.placeholder || 'Texto',
          onfocus: () => select(layer),
          oninput(event) {
            layer.text = event.target.value;
            changed();
          },
        });
    layer.row = h('li', { onclick: () => select(layer) }, body, remove);
    layers.push(layer);
    list.append(layer.row);
    return layer;
  }

  const text = (extra) => ({ text: '', x: canvas.width / 2, y: canvas.height / 2, anchor: 'middle', size: TEXT_SIZE[2], colour: '#ffffff', ...extra });

  const stickerInput = h('input', {
    type: 'file',
    accept: 'image/*',
    hidden: true,
    async onchange() {
      const [chosen] = stickerInput.files;
      stickerInput.value = '';
      if (!chosen) return;
      try {
        const img = await loadImage(chosen);
        select(add({ img, name: chosen.name, x: canvas.width / 2, y: canvas.height / 2, size: STICKER_SIZE[2] }));
        out.clear();
      } catch (error) {
        status.classList.add('error');
        status.textContent = error.message;
      }
    },
  });

  const editor = h(
    'div',
    { class: 'editor', hidden: true },
    list,
    h(
      'div',
      { class: 'result-row' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick() {
            const layer = add(text());
            select(layer);
            layer.row.querySelector('input').focus();
          },
        },
        'Añadir texto',
      ),
      h('button', { type: 'button', class: 'btn', onclick: () => stickerInput.click() }, 'Añadir imagen'),
      stickerInput,
    ),
    h('div', { class: 'fields' }, sizeField, colourField),
    canvas,
  );
  const save = h(
    'button',
    {
      type: 'button',
      class: 'btn primary',
      hidden: true,
      async onclick() {
        // The selection outline is not part of the picture.
        draw(false);
        const blob = await encode(canvas, 'image/jpeg', 0.92);
        draw();
        out.show({ blob, name: `${base(file.name)}-meme.jpg` });
      },
    },
    'Guardar meme',
  );

  /** Pointer position in image pixels. */
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [((event.clientX - rect.left) * canvas.width) / rect.width, ((event.clientY - rect.top) * canvas.height) / rect.height];
  };
  canvas.addEventListener('pointerdown', (event) => {
    const [x, y] = point(event);
    const hit = [...layers].reverse().find((l) => l.box && x >= l.box[0] && x <= l.box[0] + l.box[2] && y >= l.box[1] && y <= l.box[1] + l.box[3]);
    select(hit || null);
    if (!hit) return;
    canvas.setPointerCapture(event.pointerId);
    drag = { layer: hit, dx: x - hit.x, dy: y - hit.y };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const [x, y] = point(event);
    drag.layer.x = x - drag.dx;
    drag.layer.y = y - drag.dy;
    changed();
  });
  const drop = () => (drag = null);
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);

  const zone = fileZone({ accept: 'image/*', preview: false }, async ([chosen]) => {
    editor.hidden = save.hidden = canvas.hidden = true;
    status.classList.remove('error');
    status.textContent = '';
    out.clear();
    if (!chosen) return;
    try {
      picture = await loadImage(chosen);
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
      return;
    }
    file = chosen;
    canvas.width = picture.naturalWidth;
    canvas.height = picture.naturalHeight;
    layers = [];
    list.replaceChildren();
    const margin = canvas.width * 0.03;
    const first = add(text({ anchor: 'top', y: margin, placeholder: 'Texto de arriba' }));
    add(text({ anchor: 'bottom', y: canvas.height - margin, placeholder: 'Texto de abajo' }));
    editor.hidden = save.hidden = canvas.hidden = false;
    status.textContent = 'Arrastra un texto o una imagen sobre la foto para moverlo.';
    select(first);
  });

  root.append(zone.el, editor, status, save, out.el);
  return () => {
    out.clear();
    zone.destroy();
  };
}

async function heic({ files, v, progress }) {
  const { default: heic2any } = await import('heic2any');
  const results = [];
  for (const [i, file] of files.entries()) {
    let converted;
    try {
      converted = await heic2any({ blob: file, toType: v.format, quality: v.quality / 100 });
    } catch (error) {
      throw new Error(`No se pudo convertir ${file.name}: ${error.message || 'no parece un archivo HEIC válido'}`);
    }
    // A HEIC can hold several pictures (bursts, live photos).
    const blobs = [converted].flat();
    blobs.forEach((blob, n) =>
      results.push({ blob, name: `${base(file.name)}${blobs.length > 1 ? `-${n + 1}` : ''}.${v.format === 'image/png' ? 'png' : 'jpg'}` }),
    );
    progress((i + 1) / files.length);
  }
  return results;
}

/**
 * Shared base for tools that work on one image through a canvas shown at full resolution.
 * `onLoad(canvas, file)` runs when a new image is ready. Returns { el, canvas, point, status, zone }.
 */
function imageStage(onLoad, hint) {
  const canvas = h('canvas', { class: 'crop', hidden: true });
  const status = h('p', { class: 'status', role: 'status' });
  const zone = fileZone({ accept: 'image/*', preview: false }, async (files) => {
    canvas.hidden = true;
    status.classList.remove('error');
    status.textContent = '';
    if (!files[0]) return onLoad(null);
    try {
      const img = await loadImage(files[0]);
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      canvas.hidden = false;
      status.textContent = hint;
      onLoad(files[0]);
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
    }
  });
  /** Pointer position in image pixels. */
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [
      clamp(Math.round(((event.clientX - rect.left) * canvas.width) / rect.width), 0, canvas.width - 1),
      clamp(Math.round(((event.clientY - rect.top) * canvas.height) / rect.height), 0, canvas.height - 1),
    ];
  };
  return { canvas, status, zone, point };
}

function renderCensor(root) {
  let file = null;
  let origin = null;
  let before = null;
  const undo = [];
  const out = resultView();
  const mode = h(
    'select',
    {},
    h('option', { value: 'pixel' }, 'Pixelar'),
    h('option', { value: 'blur' }, 'Difuminar'),
    h('option', { value: 'black' }, 'Tapar en negro'),
  );
  const stage = imageStage((loaded) => {
    file = loaded;
    undo.length = 0;
    out.clear();
    actions.hidden = !loaded;
  }, 'Arrastra sobre cada zona que quieras ocultar.');
  const { canvas } = stage;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function censor(x, y, w, ht) {
    if (mode.value === 'black') {
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, ht);
      return;
    }
    // Both effects come from shrinking the area and stretching it back.
    const blocks = mode.value === 'pixel' ? 12 : 6;
    const small = makeCanvas(Math.max(1, (w / Math.max(w, ht)) * blocks), Math.max(1, (ht / Math.max(w, ht)) * blocks));
    const sctx = small.getContext('2d');
    sctx.drawImage(canvas, x, y, w, ht, 0, 0, small.width, small.height);
    ctx.save();
    ctx.imageSmoothingEnabled = mode.value === 'blur';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, ht);
    ctx.restore();
  }

  const rectFrom = ([x, y]) => [Math.min(x, origin[0]), Math.min(y, origin[1]), Math.abs(x - origin[0]), Math.abs(y - origin[1])];

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    origin = stage.point(event);
    before = ctx.getImageData(0, 0, canvas.width, canvas.height);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!origin) return;
    ctx.putImageData(before, 0, 0);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, canvas.width / 400);
    ctx.strokeRect(...rectFrom(stage.point(event)));
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!origin) return;
    ctx.putImageData(before, 0, 0);
    const [x, y, w, ht] = rectFrom(stage.point(event));
    origin = null;
    if (w < 2 || ht < 2) return;
    undo.push(before);
    // Full-size snapshots are heavy; a few steps are enough.
    if (undo.length > 5) undo.shift();
    censor(x, y, w, ht);
    out.clear();
  });

  const actions = h(
    'div',
    { class: 'result-row', hidden: true },
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        onclick() {
          const last = undo.pop();
          if (last) ctx.putImageData(last, 0, 0);
        },
      },
      'Deshacer',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn primary',
        onclick: async () => out.show({ blob: await encode(canvas, 'image/png'), name: `${base(file.name)}-censurada.png` }),
      },
      'Guardar imagen',
    ),
  );

  root.append(
    stage.zone.el,
    h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', {}, 'Efecto'), mode)),
    canvas,
    stage.status,
    actions,
    out.el,
  );
  return () => {
    out.clear();
    stage.zone.destroy();
  };
}

const hex = (r, g, b) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** Most common colours, grouping similar ones: channels are bucketed to 4 bits and near duplicates skipped. */
function palette(ctx, width, height, count = 6) {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  const buckets = new Map();
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const bucket = buckets.get(key) || buckets.set(key, [0, 0, 0, 0]).get(key);
      bucket[0] += data[i];
      bucket[1] += data[i + 1];
      bucket[2] += data[i + 2];
      bucket[3]++;
    }
  }
  const colours = [];
  for (const [r, g, b, n] of [...buckets.values()].sort((a, b) => b[3] - a[3])) {
    const c = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    if (colours.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) > 48)) colours.push(c);
    if (colours.length === count) break;
  }
  return colours;
}

function renderColours(root) {
  const picked = h('div', { class: 'swatches' });
  const common = h('div', { class: 'swatches' });
  const swatch = ([r, g, b]) => {
    const code = hex(r, g, b);
    const button = h(
      'button',
      {
        type: 'button',
        class: 'swatch',
        title: 'Copiar',
        async onclick() {
          await navigator.clipboard.writeText(code);
          label.textContent = 'Copiado';
          setTimeout(() => (label.textContent = code), 1200);
        },
      },
      h('span', { class: 'swatch-colour', style: `background:${code}` }),
    );
    const label = h('span', {}, code);
    button.append(label, h('small', {}, `rgb(${r}, ${g}, ${b})`));
    return button;
  };
  const stage = imageStage((file) => {
    picked.replaceChildren();
    common.replaceChildren();
    if (!file) return;
    const { canvas } = stage;
    common.append(h('strong', {}, 'Colores principales'), ...palette(canvas.getContext('2d'), canvas.width, canvas.height).map(swatch));
  }, 'Toca la imagen para tomar un color. Toca un color para copiarlo.');
  stage.canvas.addEventListener('pointerdown', (event) => {
    const [x, y] = stage.point(event);
    const [r, g, b] = stage.canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    picked.replaceChildren(h('strong', {}, 'Color elegido'), swatch([r, g, b]));
  });
  root.append(stage.zone.el, stage.canvas, stage.status, picked, common);
  return () => stage.zone.destroy();
}

export default [
  {
    id: 'imagen-heic',
    name: 'HEIC a JPG',
    desc: 'Convierte fotos de iPhone (HEIC/HEIF) a JPG o PNG.',
    cat: 'imagen',
    action: 'Convertir',
    files: { accept: '.heic,.heif,image/heic,image/heif', multiple: true, preview: false },
    fields: [
      {
        key: 'format',
        label: 'Formato de salida',
        type: 'select',
        value: 'image/jpeg',
        options: [
          ['image/jpeg', 'JPG'],
          ['image/png', 'PNG'],
        ],
      },
      { key: 'quality', label: 'Calidad JPG', type: 'range', min: 40, max: 100, value: 90 },
    ],
    run: heic,
  },
  {
    id: 'imagen-collage',
    name: 'Collage',
    desc: 'Une varias fotos en una cuadrícula.',
    cat: 'imagen',
    action: 'Crear collage',
    files: IMAGES,
    fields: [
      { key: 'cols', label: 'Columnas', type: 'number', min: 1, max: 10, value: 2 },
      {
        key: 'ratio',
        label: 'Forma de cada foto',
        type: 'select',
        value: '1:1',
        options: [
          ['1:1', 'Cuadrada'],
          ['4:3', 'Horizontal 4:3'],
          ['16:9', 'Horizontal 16:9'],
          ['3:4', 'Vertical 3:4'],
          ['9:16', 'Vertical 9:16'],
        ],
      },
      { key: 'cell', label: 'Ancho de cada foto (px)', type: 'number', min: 50, max: 2000, value: 600 },
      { key: 'gap', label: 'Separación (px)', type: 'number', min: 0, max: 200, value: 12 },
      { key: 'bg', label: 'Color de fondo', type: 'color', value: '#ffffff' },
    ],
    run: collage,
  },
  {
    id: 'imagen-meme',
    name: 'Crear meme',
    desc: 'Añade textos e imágenes a una foto y colócalos donde quieras.',
    cat: 'imagen',
    render: renderMeme,
  },
  {
    id: 'imagen-censurar',
    name: 'Pixelar o difuminar zonas',
    desc: 'Oculta caras, matrículas o datos personales.',
    cat: 'imagen',
    render: renderCensor,
  },
  {
    id: 'imagen-colores',
    name: 'Colores de una imagen',
    desc: 'Toma un color con un toque y saca la paleta principal.',
    cat: 'imagen',
    render: renderColours,
  },
];
