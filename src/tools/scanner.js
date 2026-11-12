import { encode, loadImage, makeCanvas } from '../lib/image.js';
import { pdfLib } from '../lib/pdf.js';
import { fieldEl, resultView } from '../tool-page.js';
import { clamp, h } from '../ui.js';

/*
 * Document scanner: photos of a document (both sides of an ID card, a letter…) are straightened,
 * cleaned up and laid out on printable pages, as a PDF or as JPG images.
 */

const PAPER = { a4: [210, 297], carta: [215.9, 279.4], oficio: [215.9, 330.2] };
const MARGIN = 15; // mm around the page
const GAP = 10; // mm between documents on the same page
const CARD = 85.6; // mm, long side of an ID card or driving licence (ISO/IEC 7810 ID-1)
const PX_PER_MM = 200 / 25.4; // JPG pages are drawn at 200 dpi
const PT_PER_MM = 72 / 25.4;
const MAX_SIDE = 2400; // px, longest side of a straightened photo
const THUMB = 360; // px, longest side of the previews

const dist = ([x1, y1], [x2, y2]) => Math.hypot(x2 - x1, y2 - y1);
const fullQuad = (img) => [
  [0, 0],
  [img.naturalWidth, 0],
  [img.naturalWidth, img.naturalHeight],
  [0, img.naturalHeight],
];

/** The projective transform (8 coefficients of a 3×3 matrix) that takes each point of `from` to the same point of `to`. */
function homography(from, to) {
  const rows = [];
  from.forEach(([x, y], i) => {
    const [u, v] = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  // Gauss-Jordan elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    if (Math.abs(rows[c][c]) < 1e-9) throw new Error('Las esquinas marcadas no forman un documento.');
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = rows[r][c] / rows[c][c];
      for (let k = c; k < 9; k++) rows[r][k] -= f * rows[c][k];
    }
  }
  return rows.map((row, i) => row[8] / row[i]);
}

/** Cuts the area inside `quad` (top-left, top-right, bottom-right, bottom-left) out of the photo as a flat rectangle. */
function straighten(img, quad) {
  const width = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const height = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const ht = Math.max(1, Math.round(height * k));
  const full = fullQuad(img);
  const out = makeCanvas(w, ht);
  const ctx = out.getContext('2d');
  // The whole photo needs no transform, only scaling.
  if (quad.every((p, i) => dist(p, full[i]) < 1)) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, ht);
    return out;
  }
  const src = makeCanvas(img.naturalWidth, img.naturalHeight);
  const sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0);
  const s = sctx.getImageData(0, 0, src.width, src.height).data;
  const result = ctx.createImageData(w, ht);
  const o = result.data;
  const [a, b, c, d, e, f, g, hh] = homography(
    [
      [0, 0],
      [w, 0],
      [w, ht],
      [0, ht],
    ],
    quad,
  );
  const sw = src.width;
  const maxX = src.width - 1;
  const maxY = src.height - 1;
  for (let y = 0; y < ht; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const z = g * px + hh * py + 1;
      const u = clamp((a * px + b * py + c) / z - 0.5, 0, maxX);
      const v = clamp((d * px + e * py + f) / z - 0.5, 0, maxY);
      // Bilinear sampling between the four nearest pixels.
      const x0 = Math.max(0, Math.min(Math.floor(u), maxX - 1));
      const y0 = Math.max(0, Math.min(Math.floor(v), maxY - 1));
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const at = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = s[i00 + ch] + (s[i10 + ch] - s[i00 + ch]) * fx;
        const bottom = s[i01 + ch] + (s[i11 + ch] - s[i01 + ch]) * fx;
        o[at + ch] = top + (bottom - top) * fy;
      }
      o[at + 3] = 255;
    }
  }
  ctx.putImageData(result, 0, 0);
  return out;
}

/** The canvas turned `turns` quarter turns clockwise. */
function rotate(canvas, turns) {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return canvas;
  const out = t % 2 ? makeCanvas(canvas.height, canvas.width) : makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((t * Math.PI) / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Levels that stretch the darkest 0.5 % to black and the lightest 0.5 % to white, like a scanner's auto exposure. */
function autoLevels(d) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(luma(d, i))]++;
  const total = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let n = 0; lo < 255 && (n += hist[lo]) < total * 0.005; ) lo++;
  for (let n = 0; hi > 0 && (n += hist[hi]) < total * 0.005; ) hi--;
  if (hi - lo < 10) [lo, hi] = [0, 255];
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  return lut;
}

/** Applies the colour mode: 'color' (as taken), 'mejorado', 'gris' or 'bn' (black and white). */
function applyMode(canvas, mode) {
  if (mode === 'color') return canvas;
  const out = makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const d = image.data;
  const lut = autoLevels(d);
  if (mode === 'mejorado') {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  } else {
    const { width: w, height: ht } = out;
    const gray = new Uint8ClampedArray(w * ht);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) gray[p] = lut[Math.round(luma(d, i))];
    if (mode === 'bn') {
      // Each pixel is compared with the average of its neighbourhood, so shadows and uneven light from
      // a phone photo do not turn whole areas black (Bradley's adaptive threshold).
      const sum = new Float64Array((w + 1) * (ht + 1));
      for (let y = 0; y < ht; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
          row += gray[y * w + x];
          sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
        }
      }
      const half = Math.max(4, Math.round(Math.max(w, ht) / 32));
      for (let y = 0; y < ht; y++) {
        const y1 = Math.max(0, y - half);
        const y2 = Math.min(ht, y + half + 1);
        for (let x = 0; x < w; x++) {
          const x1 = Math.max(0, x - half);
          const x2 = Math.min(w, x + half + 1);
          const area = (x2 - x1) * (y2 - y1);
          const total = sum[y2 * (w + 1) + x2] - sum[y1 * (w + 1) + x2] - sum[y2 * (w + 1) + x1] + sum[y1 * (w + 1) + x1];
          gray[y * w + x] = gray[y * w + x] * area < total * 0.85 ? 0 : 255;
        }
      }
    }
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) d[i] = d[i + 1] = d[i + 2] = gray[p];
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Size on paper (mm) of a document whose picture is `canvas`. */
function paperSize(canvas, v) {
  const [pw, ph] = PAPER[v.paper];
  const aw = pw - 2 * MARGIN;
  const ah = ph - 2 * MARGIN;
  const ratio = canvas.height / canvas.width;
  let w;
  if (v.size === 'tarjeta') w = ratio <= 1 ? CARD : CARD / ratio;
  else w = Math.min(aw, (v.size === 'media' ? (ah - GAP) / 2 : ah) / ratio);
  w = Math.min((w * v.scale) / 100, aw, ah / ratio);
  return [w, w * ratio];
}

/** Groups the documents into pages and places them, centred, in mm from the top-left corner. */
function layout(sizes, v) {
  const [pw, ph] = PAPER[v.paper];
  const ah = ph - 2 * MARGIN;
  const pages = [];
  let page = null;
  sizes.forEach(([w, ht], i) => {
    if (!page || v.layout === 'separadas' || page.height + GAP + ht > ah) {
      page = { items: [], height: -GAP };
      pages.push(page);
    }
    page.items.push({ i, w, ht });
    page.height += GAP + ht;
  });
  for (const p of pages) {
    let y = MARGIN + (ah - p.height) / 2;
    for (const item of p.items) {
      item.x = (pw - item.w) / 2;
      item.y = y;
      y += item.ht + GAP;
    }
  }
  return pages;
}

async function buildPdf(pictures, pages, v) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  const [pw, ph] = PAPER[v.paper];
  // Black and white compresses far better (and without blur) as PNG.
  const embedded = await Promise.all(
    pictures.map(async (canvas) =>
      v.mode === 'bn'
        ? doc.embedPng(await (await encode(canvas, 'image/png')).arrayBuffer())
        : doc.embedJpg(await (await encode(canvas, 'image/jpeg', 0.9)).arrayBuffer()),
    ),
  );
  for (const { items } of pages) {
    const page = doc.addPage([pw * PT_PER_MM, ph * PT_PER_MM]);
    for (const { i, x, y, w, ht } of items) {
      // PDF coordinates start at the bottom of the page.
      page.drawImage(embedded[i], { x: x * PT_PER_MM, y: (ph - y - ht) * PT_PER_MM, width: w * PT_PER_MM, height: ht * PT_PER_MM });
    }
  }
  return { blob: new Blob([await doc.save()], { type: 'application/pdf' }), name: 'escaneo.pdf' };
}

async function buildJpgs(pictures, pages, v) {
  const [pw, ph] = PAPER[v.paper];
  return Promise.all(
    pages.map(async ({ items }, n) => {
      const sheet = makeCanvas(pw * PX_PER_MM, ph * PX_PER_MM);
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      ctx.imageSmoothingQuality = 'high';
      for (const { i, x, y, w, ht } of items) ctx.drawImage(pictures[i], x * PX_PER_MM, y * PX_PER_MM, w * PX_PER_MM, ht * PX_PER_MM);
      const name = pages.length > 1 ? `escaneo-${n + 1}.jpg` : 'escaneo.jpg';
      return { blob: await encode(sheet, 'image/jpeg', 0.92), name };
    }),
  );
}

/** Editor to mark the four corners of the document on the photo. */
function cornerEditor(onDone) {
  let page = null;
  let quad = null;
  let k = 1;
  let dragging = -1;
  const canvas = h('canvas', { class: 'crop', 'aria-label': 'Foto del documento con sus cuatro esquinas' });
  const ctx = canvas.getContext('2d');
  const radius = () => Math.max(8, canvas.width / 40);

  function paint() {
    ctx.drawImage(page.img, 0, 0, canvas.width, canvas.height);
    const pts = quad.map(([x, y]) => [x * k, y * k]);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.lineWidth = Math.max(2, canvas.width / 300);
    ctx.strokeStyle = '#4f8cff';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, radius(), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79, 140, 255, 0.35)';
      ctx.fill();
      ctx.stroke();
    }
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      clamp(((event.clientX - rect.left) * canvas.width) / rect.width, 0, canvas.width),
      clamp(((event.clientY - rect.top) * canvas.height) / rect.height, 0, canvas.height),
    ];
  }

  canvas.addEventListener('pointerdown', (event) => {
    const [x, y] = point(event);
    let best = -1;
    let bestDistance = Infinity;
    quad.forEach(([qx, qy], i) => {
      const distance = dist([qx * k, qy * k], [x, y]);
      if (distance < bestDistance) [best, bestDistance] = [i, distance];
    });
    // Fingers are less precise than a mouse, so the grab area is generous.
    if (bestDistance > radius() * 4) return;
    dragging = best;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (dragging < 0) return;
    const [x, y] = point(event);
    quad[dragging] = [x / k, y / k];
    paint();
  });
  const stop = () => (dragging = -1);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  const button = (label, onclick, primary) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', onclick }, label);
  const el = h(
    'div',
    { class: 'scan-editor', hidden: true },
    h('p', { class: 'note' }, 'Arrastra los cuatro círculos hasta las esquinas del documento. Se enderezará aunque la foto esté inclinada.'),
    canvas,
    h(
      'div',
      { class: 'result-row' },
      button('Aplicar', () => close(true), true),
      button('Toda la foto', () => {
        quad = fullQuad(page.img);
        paint();
      }),
      button('Cancelar', () => close(false)),
    ),
  );

  function close(apply) {
    el.hidden = true;
    onDone(page, apply ? quad : null);
    page = null;
  }

  return {
    el,
    open(target) {
      page = target;
      quad = page.quad.map((p) => [...p]);
      k = Math.min(1, 1400 / Math.max(page.img.naturalWidth, page.img.naturalHeight));
      canvas.width = Math.round(page.img.naturalWidth * k);
      canvas.height = Math.round(page.img.naturalHeight * k);
      el.hidden = false;
      paint();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };
}

function renderScanner(root) {
  /** { name, img, quad, turns, straight (cached canvas) } in output order. */
  let pages = [];
  const values = {};
  const status = h('p', { class: 'status', role: 'status' });
  const out = resultView();
  const grid = h('div', { class: 'thumbs' });
  const setStatus = (message, isError) => {
    status.textContent = message || '';
    status.classList.toggle('error', !!isError);
  };

  const straight = (page) => (page.straight ||= straighten(page.img, page.quad));
  const picture = (page) => applyMode(rotate(straight(page), page.turns), values.mode);

  const editor = cornerEditor((page, quad) => {
    if (page && quad) {
      page.quad = quad;
      page.straight = null;
    }
    draw();
  });

  async function add(fileList) {
    out.clear();
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length) return setStatus('Elige fotos o imágenes del documento.', true);
    setStatus('Cargando…');
    try {
      for (let file of files) {
        if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
          const { default: heic2any } = await import('heic2any');
          file = new File([await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })], file.name, { type: 'image/jpeg' });
        }
        const img = await loadImage(file);
        pages.push({ name: file.name, img, quad: fullQuad(img), turns: 0, straight: null });
      }
      setStatus('');
    } catch (error) {
      setStatus(error.message, true);
    }
    draw();
    // A new photo usually needs its corners marked, so the editor opens on the first one added.
    if (files.length === 1 && pages.length) editor.open(pages.at(-1));
  }

  const picker = (attrs) => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true, ...attrs });
    input.addEventListener('change', () => {
      add(input.files);
      input.value = '';
    });
    return input;
  };
  const camera = picker({ capture: 'environment' });
  const gallery = picker({ multiple: true });

  const iconBtn = (label, title, onclick, disabled) => h('button', { type: 'button', class: 'icon', title, 'aria-label': title, onclick, disabled }, label);

  function move(i, delta) {
    [pages[i], pages[i + delta]] = [pages[i + delta], pages[i]];
    out.clear();
    draw();
  }

  function thumbnail(page) {
    // Previews come from a small copy, so changing the mode or turning a page is instant.
    const source = straight(page);
    const k = Math.min(1, THUMB / Math.max(source.width, source.height));
    const small = makeCanvas(source.width * k, source.height * k);
    small.getContext('2d').drawImage(source, 0, 0, small.width, small.height);
    return applyMode(rotate(small, page.turns), values.mode);
  }

  function draw() {
    create.hidden = !pages.length;
    grid.replaceChildren(
      ...pages.map((page, i) =>
        h(
          'figure',
          { class: 'thumb' },
          thumbnail(page),
          h(
            'figcaption',
            {},
            iconBtn('←', 'Mover antes', () => move(i, -1), i === 0),
            h('span', {}, pages.length === 2 ? (i ? 'Atrás' : 'Frente') : `Pág. ${i + 1}`),
            iconBtn('→', 'Mover después', () => move(i, 1), i === pages.length - 1),
          ),
          h(
            'figcaption',
            {},
            iconBtn('⤢', 'Ajustar bordes', () => editor.open(page)),
            iconBtn('↺', 'Girar a la izquierda', () => {
              page.turns--;
              out.clear();
              draw();
            }),
            iconBtn('↻', 'Girar a la derecha', () => {
              page.turns++;
              out.clear();
              draw();
            }),
            iconBtn('✕', 'Quitar', () => {
              pages.splice(i, 1);
              out.clear();
              draw();
            }),
          ),
        ),
      ),
    );
  }

  const onInput = () => {
    out.clear();
    draw();
  };
  const fields = [
    {
      key: 'mode',
      label: 'Color',
      type: 'select',
      value: 'mejorado',
      options: [
        ['mejorado', 'Color mejorado'],
        ['color', 'Color original'],
        ['gris', 'Escala de grises'],
        ['bn', 'Blanco y negro'],
      ],
    },
    {
      key: 'size',
      label: 'Tamaño',
      type: 'select',
      value: 'tarjeta',
      options: [
        ['tarjeta', 'Tarjeta (cédula, licencia: 85,6 mm)'],
        ['media', 'Media hoja'],
        ['completa', 'Hoja completa'],
      ],
    },
    { key: 'scale', label: 'Escala %', type: 'range', min: 25, max: 200, step: 5, value: 100 },
    {
      key: 'paper',
      label: 'Papel',
      type: 'select',
      value: 'carta',
      options: [
        ['carta', 'Carta'],
        ['a4', 'A4'],
        ['oficio', 'Oficio'],
      ],
    },
    {
      key: 'layout',
      label: 'Páginas',
      type: 'select',
      value: 'juntas',
      options: [
        ['juntas', 'Todo en la misma hoja si cabe'],
        ['separadas', 'Una hoja por foto'],
      ],
    },
    {
      key: 'format',
      label: 'Formato',
      type: 'select',
      value: 'pdf',
      options: [
        ['pdf', 'PDF'],
        ['jpg', 'JPG'],
      ],
    },
  ].map((f) => fieldEl(f, values, onInput));

  const create = h(
    'button',
    {
      type: 'button',
      class: 'btn primary',
      hidden: true,
      async onclick() {
        create.disabled = true;
        setStatus('Creando el escaneo…');
        try {
          // Let the status paint before the heavy work blocks the page.
          await new Promise((resolve) => setTimeout(resolve, 30));
          const v = { ...values };
          const pictures = pages.map(picture);
          const sheets = layout(
            pictures.map((c) => paperSize(c, v)),
            v,
          );
          out.show(v.format === 'pdf' ? await buildPdf(pictures, sheets, v) : await buildJpgs(pictures, sheets, v));
          setStatus('');
        } catch (error) {
          console.error(error);
          setStatus(error.message, true);
        } finally {
          create.disabled = false;
        }
      },
    },
    'Crear escaneo',
  );

  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    add(e.dataTransfer.files);
  });

  root.append(
    h(
      'div',
      { class: 'result-row' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => camera.click() }, 'Tomar foto'),
      h('button', { type: 'button', class: 'btn', onclick: () => gallery.click() }, 'Elegir imágenes'),
      camera,
      gallery,
    ),
    h('p', { class: 'note' }, 'Fotografía cada cara sobre una superficie oscura y con buena luz. Las fotos se procesan en tu dispositivo y no se suben a ningún servidor.'),
    editor.el,
    grid,
    h('div', { class: 'fields' }, fields),
    create,
    status,
    out.el,
  );
  return () => {
    pages = [];
    out.clear();
  };
}

export default [
  {
    id: 'documento-escanear',
    name: 'Escanear documento',
    desc: 'Fotografía una cédula, licencia o documento por delante y por detrás y crea un escaneo en PDF o JPG.',
    cat: 'documentos',
    render: renderScanner,
  },
];
