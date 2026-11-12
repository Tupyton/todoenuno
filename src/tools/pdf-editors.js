import { encode, makeCanvas } from '../lib/image.js';
import { eachPage, open, pdfLib, renderPage, save, subset } from '../lib/pdf.js';
import { qpdf } from '../lib/qpdf.js';
import { fileZone, resultView } from '../tool-page.js';
import { base, clamp, h } from '../ui.js';

const PDF = { accept: 'application/pdf,.pdf' };
const pdfBlob = (bytes, name) => ({ blob: new Blob([bytes], { type: 'application/pdf' }), name });

/** Common shell of the custom PDF tools: file picker, status line and result. */
function shell(onFile) {
  const status = h('p', { class: 'status', role: 'status' });
  const out = resultView();
  let token = 0;
  const setStatus = (message, isError = false) => {
    status.textContent = message || '';
    status.classList.toggle('error', isError);
  };
  const zone = fileZone({ ...PDF, preview: false }, async ([file]) => {
    const mine = ++token;
    out.clear();
    setStatus(file ? 'Leyendo el PDF…' : '');
    try {
      // `current()` lets a slow load notice that another file replaced it.
      await onFile(file || null, () => mine === token);
      if (mine === token && file) setStatus('');
    } catch (error) {
      if (mine === token) setStatus(error.message, true);
    }
  });
  /** Runs a save action, reporting errors in the status line. */
  const act = (fn) => async () => {
    try {
      setStatus('Procesando…');
      out.show(await fn());
      setStatus('');
    } catch (error) {
      console.error(error);
      setStatus(error.message, true);
    }
  };
  return {
    zone,
    status,
    out,
    setStatus,
    act,
    destroy() {
      token++;
      out.clear();
      zone.destroy();
    },
  };
}

function renderOrder(root) {
  let file = null;
  /** Pages in their new order: { index (original, zero-based), canvas }. */
  let pages = [];
  const grid = h('div', { class: 'thumbs' });
  const button = h('button', { type: 'button', class: 'btn primary', hidden: true }, 'Guardar PDF');
  const ui = shell(async (loaded, current) => {
    file = loaded;
    pages = [];
    draw();
    if (!file) return;
    await eachPage(file, async (page, n) => {
      if (!current()) return;
      // Small thumbnails: about 160 px wide whatever the page size.
      const canvas = await renderPage(page, 160 / page.getViewport({ scale: 1 }).width);
      if (!current()) return;
      pages.push({ index: n - 1, canvas });
      draw();
    });
  });

  const iconBtn = (label, title, onclick, disabled) => h('button', { type: 'button', class: 'icon', title, 'aria-label': title, onclick, disabled }, label);

  function move(i, delta) {
    [pages[i], pages[i + delta]] = [pages[i + delta], pages[i]];
    draw();
  }

  function draw() {
    button.hidden = !pages.length;
    grid.replaceChildren(
      ...pages.map((page, i) =>
        h(
          'figure',
          { class: 'thumb' },
          page.canvas,
          h(
            'figcaption',
            {},
            iconBtn('←', 'Mover antes', () => move(i, -1), i === 0),
            h('span', {}, `Pág. ${page.index + 1}`),
            iconBtn('→', 'Mover después', () => move(i, 1), i === pages.length - 1),
            iconBtn('✕', 'Quitar página', () => {
              pages.splice(i, 1);
              draw();
            }),
          ),
        ),
      ),
    );
  }

  button.addEventListener(
    'click',
    ui.act(async () => {
      if (!pages.length) throw new Error('No queda ninguna página.');
      const doc = await subset(await open(file), pages.map((p) => p.index));
      return save(doc, `${base(file.name)}-ordenado.pdf`);
    }),
  );
  root.append(ui.zone.el, grid, button, ui.status, ui.out.el);
  return ui.destroy;
}

/** Signature pad. Returns { el, clear, isEmpty, toPng }. */
function signaturePad() {
  const canvas = h('canvas', { class: 'signature', width: 900, height: 300, 'aria-label': 'Dibuja tu firma' });
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let empty = true;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [((event.clientX - rect.left) * canvas.width) / rect.width, ((event.clientY - rect.top) * canvas.height) / rect.height];
  };
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    empty = false;
    ctx.beginPath();
    ctx.moveTo(...point(event));
    // A dot when the pointer does not move.
    ctx.lineTo(...point(event));
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    ctx.lineTo(...point(event));
    ctx.stroke();
  });
  canvas.addEventListener('pointerup', () => (drawing = false));
  return {
    el: canvas,
    isEmpty: () => empty,
    setColour: (colour) => (ctx.strokeStyle = colour),
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      empty = true;
    },
    /** The drawing cropped to its ink, as PNG bytes plus its width/height ratio. */
    async toPng() {
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let [x0, y0, x1, y1] = [width, height, 0, 0];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!data[(y * width + x) * 4 + 3]) continue;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
      const cropped = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
      cropped.getContext('2d').drawImage(canvas, x0, y0, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
      return { bytes: await (await encode(cropped, 'image/png')).arrayBuffer(), ratio: cropped.width / cropped.height };
    },
  };
}

function renderSign(root) {
  let file = null;
  let total = 0;
  /** Where the signature's centre goes, as fractions of the page shown. */
  let spot = { x: 0.7, y: 0.85 };
  let preview = null;
  const pad = signaturePad();
  const colour = h('input', { type: 'color', value: '#0a2a8a', oninput: () => pad.setColour(colour.value) });
  pad.setColour(colour.value);
  const pageInput = h('input', { type: 'number', min: 1, value: 1, onchange: () => showPage() });
  const width = h('input', { type: 'range', min: 5, max: 80, value: 30, oninput: () => paint() });
  const view = h('canvas', { class: 'crop', hidden: true });
  const controls = h('div', { hidden: true });
  const ui = shell(async (loaded) => {
    file = loaded;
    controls.hidden = true;
    view.hidden = true;
    if (!file) return;
    await showPage();
    controls.hidden = false;
  });

  async function showPage() {
    await eachPage(file, async (page, n, count) => {
      total = count;
      pageInput.max = count;
      if (n !== clamp(Number(pageInput.value) || 1, 1, count)) return;
      preview = await renderPage(page, 1.5);
    });
    view.width = preview.width;
    view.height = preview.height;
    view.hidden = false;
    paint();
  }

  /** Draws the page with a box where the signature will go. */
  function paint() {
    if (!preview) return;
    const ctx = view.getContext('2d');
    ctx.drawImage(preview, 0, 0);
    const w = (view.width * width.value) / 100;
    const ht = w / 3;
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(spot.x * view.width - w / 2, spot.y * view.height - ht / 2, w, ht);
  }

  view.addEventListener('pointerdown', (event) => {
    const rect = view.getBoundingClientRect();
    spot = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    paint();
  });

  const sign = ui.act(async () => {
    if (pad.isEmpty()) throw new Error('Dibuja tu firma primero.');
    const doc = await open(file);
    const page = doc.getPage(clamp(Number(pageInput.value) || 1, 1, total) - 1);
    if (page.getRotation().angle % 360 !== 0) throw new Error('Esta página está girada. Enderézala antes con "Rotar PDF".');
    const { bytes, ratio } = await pad.toPng();
    const image = await doc.embedPng(bytes);
    // The preview shows the crop box, which is what PDF viewers display.
    const box = page.getCropBox();
    const w = (box.width * width.value) / 100;
    const ht = w / ratio;
    page.drawImage(image, { x: box.x + spot.x * box.width - w / 2, y: box.y + (1 - spot.y) * box.height - ht / 2, width: w, height: ht });
    return save(doc, `${base(file.name)}-firmado.pdf`);
  });

  controls.append(
    h('p', { class: 'note' }, 'Toca la página para elegir dónde va la firma.'),
    view,
    h(
      'div',
      { class: 'fields' },
      h('label', { class: 'field' }, h('span', {}, 'Página'), pageInput),
      h('label', { class: 'field' }, h('span', {}, 'Tamaño de la firma'), width),
    ),
    h('button', { type: 'button', class: 'btn primary', onclick: sign }, 'Firmar PDF'),
  );
  root.append(
    ui.zone.el,
    h('label', { class: 'field' }, h('span', {}, 'Tu firma (dibuja con el dedo o el ratón)'), pad.el),
    h(
      'div',
      { class: 'result-row' },
      h('button', { type: 'button', class: 'btn', onclick: pad.clear }, 'Borrar firma'),
      h('label', { class: 'field check' }, h('span', {}, 'Color'), colour),
    ),
    controls,
    ui.status,
    ui.out.el,
  );
  return ui.destroy;
}

function renderForm(root) {
  let file = null;
  /** One entry per supported field: { name, read() }. */
  let entries = [];
  const list = h('div', { class: 'fields' });
  const flatten = h('input', { type: 'checkbox' });
  const controls = h(
    'div',
    { class: 'tool', hidden: true },
    list,
    h('label', { class: 'field check' }, h('span', {}, 'Aplanar: el resultado ya no se puede editar'), flatten),
  );
  const ui = shell(async (loaded) => {
    file = loaded;
    entries = [];
    list.replaceChildren();
    controls.hidden = true;
    if (!file) return;
    const { PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = await pdfLib();
    const form = (await open(file)).getForm();
    for (const field of form.getFields()) {
      const name = field.getName();
      let input;
      if (field instanceof PDFTextField) {
        input = h(field.isMultiline() ? 'textarea' : 'input', { value: field.getText() || '' });
        entries.push({ name, apply: (f) => f.setText(input.value) });
      } else if (field instanceof PDFCheckBox) {
        input = h('input', { type: 'checkbox', checked: field.isChecked() });
        entries.push({ name, apply: (f) => (input.checked ? f.check() : f.uncheck()) });
      } else if (field instanceof PDFDropdown || field instanceof PDFRadioGroup || field instanceof PDFOptionList) {
        const selected = [field.getSelected()].flat()[0];
        input = h('select', {}, h('option', { value: '' }, '—'), field.getOptions().map((o) => h('option', { value: o, selected: o === selected }, o)));
        entries.push({ name, apply: (f) => input.value && f.select(input.value) });
      } else continue;
      list.append(h('label', { class: input.type === 'checkbox' ? 'field check' : 'field' }, h('span', {}, name), input));
    }
    if (!entries.length) throw new Error('Este PDF no tiene campos de formulario rellenables.');
    controls.hidden = false;
  });
  const fill = ui.act(async () => {
    const doc = await open(file);
    const form = doc.getForm();
    for (const { name, apply } of entries) apply(form.getField(name));
    if (flatten.checked) form.flatten();
    return save(doc, `${base(file.name)}-rellenado.pdf`);
  });
  controls.append(h('button', { type: 'button', class: 'btn primary', onclick: fill }, 'Guardar PDF'));
  root.append(ui.zone.el, controls, ui.status, ui.out.el);
  return ui.destroy;
}

export default [
  { id: 'pdf-ordenar', name: 'Ordenar páginas de PDF', desc: 'Reordena o quita páginas viendo sus miniaturas.', cat: 'pdf', render: renderOrder },
  { id: 'pdf-firmar', name: 'Firmar PDF', desc: 'Dibuja tu firma y colócala en la página.', cat: 'pdf', render: renderSign },
  { id: 'pdf-formulario', name: 'Rellenar formulario PDF', desc: 'Completa los campos de un PDF rellenable.', cat: 'pdf', render: renderForm },
  {
    id: 'pdf-proteger',
    name: 'Proteger PDF con contraseña',
    desc: 'Cifra el PDF (AES-256) para que pida contraseña al abrirlo.',
    cat: 'pdf',
    action: 'Proteger',
    files: { ...PDF, preview: false },
    fields: [{ key: 'password', label: 'Contraseña', type: 'password', autocomplete: 'new-password' }],
    note: 'Si olvidas la contraseña no hay forma de recuperar el PDF.',
    async run({ file, v }) {
      if (!v.password) throw new Error('Escribe una contraseña.');
      return pdfBlob(await qpdf(file, ['--encrypt', v.password, v.password, '256', '--'], 'No se pudo proteger el PDF. Si ya tiene contraseña, quítasela primero.'), `${base(file.name)}-protegido.pdf`);
    },
  },
  {
    id: 'pdf-desbloquear',
    name: 'Quitar contraseña de PDF',
    desc: 'Guarda una copia sin contraseña de un PDF que puedes abrir.',
    cat: 'pdf',
    action: 'Quitar contraseña',
    files: { ...PDF, preview: false },
    fields: [{ key: 'password', label: 'Contraseña actual', type: 'password', autocomplete: 'off' }],
    note: 'Necesitas conocer la contraseña: esto no la averigua.',
    run: async ({ file, v }) => pdfBlob(await qpdf(file, [`--password=${v.password}`, '--decrypt'], 'No se pudo abrir el PDF: revisa la contraseña.'), `${base(file.name)}-sin-clave.pdf`),
  },
];
