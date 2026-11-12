import { writeDocx } from '../lib/docx.js';
import { encode } from '../lib/image.js';
import { eachPage, renderPage } from '../lib/pdf.js';
import { fileZone, resultView } from '../tool-page.js';
import { base, clamp, h } from '../ui.js';
import { csvRows } from './utilities.js';

const xlsx = () => import('xlsx/dist/xlsx.mini.min.js').then((m) => m.default ?? m);

/* Viewers for Word and PowerPoint */

const BLANK =
  '<!doctype html><html lang="es"><head><meta charset="utf-8"><style>html { background: #e5e7eb; } body { margin: 0; } @media print { html { background: none; } }</style><style id="fit"></style><style id="print"></style></head><body></body></html>';

/**
 * Tool page that shows one document and prints it (which is how it becomes a PDF).
 * `open(file, doc)` draws into `doc.body` and returns { width, print }: the content width in CSS pixels,
 * used to shrink it to the frame, and the CSS rules for printing.
 *
 * The document is drawn inside a sandboxed frame without `allow-scripts`: the file comes from anywhere,
 * and whatever markup it manages to produce, nothing in it can run.
 */
function viewer({ accept, title, open }) {
  return (root) => {
    const status = h('p', { class: 'status', role: 'status' });
    const frame = h('iframe', { class: 'doc tall', hidden: true, sandbox: 'allow-same-origin allow-modals', title });
    const print = h('button', { type: 'button', class: 'btn primary', onclick: () => frame.contentWindow.print() }, 'Guardar como PDF o imprimir');
    const actions = h(
      'div',
      { class: 'result', hidden: true },
      h('div', { class: 'result-row' }, print),
      h('p', { class: 'note' }, 'En la ventana de impresión elige «Guardar como PDF» como destino.'),
    );
    let token = 0;
    let width = 0;

    const setStatus = (message, isError) => {
      status.textContent = message || '';
      status.classList.toggle('error', !!isError);
    };
    const fit = () => {
      const doc = frame.contentDocument;
      // The root's width leaves out the scrollbar, which the frame's own width includes.
      const room = doc?.documentElement.clientWidth;
      if (room && width) doc.getElementById('fit').textContent = `@media screen { body { zoom: ${Math.min(1, room / width)}; } }`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(frame);

    const zone = fileZone({ accept, preview: false }, async ([file]) => {
      const mine = ++token;
      width = 0;
      actions.hidden = true;
      frame.hidden = !file;
      if (!file) return setStatus('');
      setStatus('Abriendo…');
      try {
        // A new document for every file, so nothing of the previous one is left behind.
        await new Promise((resolve) => {
          frame.addEventListener('load', resolve, { once: true });
          frame.srcdoc = BLANK;
        });
        if (mine !== token) return;
        const doc = frame.contentDocument;
        const opened = await open(file, doc);
        if (mine !== token) return;
        doc.getElementById('print').textContent = `@media print { ${opened.print} }`;
        width = opened.width;
        fit();
        actions.hidden = false;
        setStatus('');
      } catch (error) {
        if (mine !== token) return;
        console.error(error);
        frame.hidden = true;
        setStatus(error.message || String(error), true);
      }
    });

    root.append(zone.el, status, frame, actions);
    return () => {
      token++;
      observer.disconnect();
      zone.destroy();
    };
  };
}

async function openWord(file, doc) {
  const { renderAsync } = await import('docx-preview');
  const styles = doc.body.appendChild(doc.createElement('div'));
  const content = doc.body.appendChild(doc.createElement('div'));
  try {
    // Base64 images: blob URLs would belong to this page and outlive the frame.
    await renderAsync(await file.arrayBuffer(), content, styles, { useBase64URL: true });
  } catch (error) {
    console.error(error);
    throw new Error(`No se pudo abrir ${file.name}: no es un documento .docx válido.`);
  }
  const page = content.querySelector('section.docx');
  if (!page) throw new Error('El documento está vacío.');
  const { width, minHeight, paddingTop, paddingBottom } = page.style;
  return {
    // The wrapper adds 30px of padding on each side.
    width: page.offsetWidth + 60,
    // The page margins move from the section to @page, so they repeat on every printed page.
    print: `@page { size: ${width} ${minHeight}; margin: ${paddingTop || 0} 0 ${paddingBottom || 0}; }
      .docx-wrapper { display: block !important; padding: 0 !important; background: none !important; }
      .docx-wrapper > section.docx { min-height: 0 !important; margin: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; box-shadow: none !important; }`,
  };
}

const SLIDE_WIDTH = 960;

/**
 * Some generators list parts in [Content_Types].xml that are not in the file. PowerPoint ignores them;
 * the previewer gives up and shows nothing. This drops those entries.
 */
async function withoutMissingParts(buffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const types = zip.file('[Content_Types].xml');
  if (!types) throw new Error('missing [Content_Types].xml');
  const xml = await types.async('text');
  const fixed = xml.replace(/<Override\b[^>]*\bPartName="\/([^"]*)"[^>]*\/>/g, (entry, part) => (zip.file(decodeURI(part)) ? entry : ''));
  if (fixed === xml) return buffer;
  zip.file('[Content_Types].xml', fixed);
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function openSlides(file, doc) {
  const { init } = await import('pptx-preview');
  const holder = doc.body.appendChild(doc.createElement('div'));
  const previewer = init(holder, { width: SLIDE_WIDTH, mode: 'list' });
  try {
    await previewer.preview(await withoutMissingParts(await file.arrayBuffer()));
  } catch (error) {
    console.error(error);
    throw new Error(`No se pudo abrir ${file.name}: no es una presentación .pptx válida.`);
  }
  const slide = holder.querySelector('.pptx-preview-slide-wrapper');
  if (!slide) throw new Error(`No se pudieron leer las diapositivas de ${file.name}.`);
  // Charts without a title get the previewer's own placeholder, in Chinese. Charts are drawn later, so watch for it.
  new MutationObserver(() => {
    for (const text of holder.querySelectorAll('svg text')) if (text.textContent === '图表标题') text.remove();
  }).observe(holder, { childList: true, subtree: true });
  return {
    width: SLIDE_WIDTH,
    print: `@page { size: ${slide.offsetWidth}px ${slide.offsetHeight}px; margin: 0; }
      .pptx-preview-wrapper { height: auto !important; overflow: visible !important; background: none !important; }
      .pptx-preview-slide-wrapper { margin: 0 !important; break-after: page; }`,
  };
}

/* Excel */

const MAX_ROWS = 1000;

function renderExcel(root) {
  const status = h('p', { class: 'status', role: 'status' });
  const sheets = h('select', { 'aria-label': 'Hoja', onchange: () => draw() });
  const picker = h('label', { class: 'field', hidden: true }, h('span', {}, 'Hoja'), sheets);
  const table = h('div', { class: 'sheet', hidden: true });
  const note = h('p', { class: 'note', hidden: true });
  const out = resultView();
  let token = 0;
  let book = null;
  let XLSX = null;
  let name = '';

  function draw() {
    const sheet = book.Sheets[sheets.value];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const columns = Math.max(0, ...rows.map((r) => r.length));
    const shown = rows.slice(0, MAX_ROWS);
    table.replaceChildren(
      h(
        'table',
        {},
        shown.map((row, i) =>
          h(
            'tr',
            {},
            h('th', {}, String(i + 1)),
            Array.from({ length: columns }, (_, c) => h('td', {}, String(row[c] ?? ''))),
          ),
        ),
      ),
    );
    table.hidden = false;
    note.hidden = rows.length <= MAX_ROWS;
    note.textContent = `Se muestran las primeras ${MAX_ROWS} filas de ${rows.length}. El CSV las incluye todas.`;
    status.textContent = rows.length ? '' : 'Esta hoja está vacía.';
    // The byte order mark makes Excel read the accents right when the CSV is opened there.
    out.show({ blob: new Blob(['﻿', XLSX.utils.sheet_to_csv(sheet)], { type: 'text/csv' }), name: `${name}-${sheets.value}.csv` });
  }

  const zone = fileZone({ accept: '.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', preview: false }, async ([file]) => {
    const mine = ++token;
    status.classList.remove('error');
    picker.hidden = table.hidden = note.hidden = true;
    out.clear();
    if (!file) return (status.textContent = '');
    status.textContent = 'Abriendo…';
    try {
      XLSX = await xlsx();
      const opened = XLSX.read(await file.arrayBuffer());
      if (mine !== token) return;
      book = opened;
      name = base(file.name);
      sheets.replaceChildren(...book.SheetNames.map((s) => h('option', { value: s }, s)));
      picker.hidden = book.SheetNames.length < 2;
      draw();
    } catch (error) {
      if (mine !== token) return;
      console.error(error);
      status.classList.add('error');
      status.textContent = `No se pudo abrir ${file.name}: no es una hoja .xlsx válida.`;
    }
  });

  root.append(zone.el, picker, status, table, note, out.el);
  return () => {
    token++;
    out.clear();
    zone.destroy();
  };
}

/** Plain numbers become numeric cells; anything else (dates, codes with leading zeros) stays as written. */
const cellValue = (text) => (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && text.length < 16 ? Number(text) : text);

async function csvToExcel({ file }) {
  const rows = csvRows(await file.text());
  if (!rows.length) throw new Error('El CSV está vacío.');
  const XLSX = await xlsx();
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows.map((row) => row.map(cellValue))), 'Hoja1');
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true });
  return { blob: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: `${base(file.name)}.xlsx` };
}

/* PDF to Word */

/** Product of two PDF transforms ([a, b, c, d, e, f]). */
const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Text of a line: pieces far apart are separated by a tab, as in table columns. */
function lineText(items) {
  let text = '';
  let end = null;
  for (const item of items) {
    if (end !== null) {
      const gap = item.x - end;
      if (gap > item.size * 2) text += '\t';
      else if (gap > item.size * 0.2 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
    }
    text += item.str;
    end = item.x + item.width;
  }
  return text.replace(/ {2,}/g, ' ').replace(/ ?\t ?/g, '\t').trim();
}

/** Rebuilds the paragraphs of a PDF page from its loose pieces of text. Returns { paragraphs, margin }. */
function layout(content, viewport) {
  const items = content.items
    .filter((item) => item.str)
    .map((item) => {
      const t = multiply(viewport.transform, item.transform);
      return { str: item.str, x: t[4], y: t[5], size: Math.hypot(t[2], t[3]), width: item.width };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const rows = [];
  for (const item of items) {
    const row = rows.at(-1);
    if (row && Math.abs(item.y - row.y) < Math.max(item.size, row.size) * 0.4) row.items.push(item);
    else rows.push({ y: item.y, size: item.size, items: [item] });
  }
  const lines = rows
    .map((row) => {
      const sorted = row.items.sort((a, b) => a.x - b.x);
      const visible = sorted.filter((item) => item.str.trim());
      if (!visible.length) return null;
      return {
        y: row.y,
        size: Math.max(...visible.map((item) => item.size)),
        left: visible[0].x,
        right: Math.max(...visible.map((item) => item.x + item.width)),
        text: lineText(sorted),
      };
    })
    .filter((line) => line?.text);
  if (!lines.length) return { paragraphs: [] };

  const left = Math.min(...lines.map((line) => line.left));
  const right = Math.max(...lines.map((line) => line.right));
  const paragraphs = [];
  let previous = null;
  for (const line of lines) {
    const current = paragraphs.at(-1);
    // A line continues the paragraph when it looks like the one above and that one reached the right edge.
    const continues =
      previous &&
      Math.abs(line.size - previous.size) < 0.5 &&
      line.y - previous.y < previous.size * 1.6 &&
      previous.right > right - (right - left) * 0.12 &&
      !previous.text.includes('\t') &&
      !line.text.includes('\t');
    if (continues) {
      // A word split at the end of the line is put back together.
      const split = /\p{L}-$/u.test(current.text) && /^\p{Ll}/u.test(line.text);
      current.text = split ? current.text.slice(0, -1) + line.text : `${current.text} ${line.text}`;
      current.center = false;
    } else {
      const centered = Math.abs((line.left + line.right) / 2 - viewport.width / 2) < 4 && line.left - left > 20;
      paragraphs.push({ text: line.text, size: Math.round(line.size * 2) / 2 || 11, center: centered });
    }
    previous = line;
  }
  const side = (space) => clamp(space, 18, viewport.width / 3);
  return {
    paragraphs,
    margin: { left: side(left), right: side(viewport.width - right), top: clamp(lines[0].y - lines[0].size, 18, viewport.height / 3), bottom: 28 },
  };
}

async function pdfToWord({ file, v, progress }) {
  const pages = [];
  await eachPage(file, async (page, n, total) => {
    const viewport = page.getViewport({ scale: 1 });
    const size = { width: viewport.width, height: viewport.height };
    if (v.mode === 'image') pages.push({ ...size, jpeg: await encode(await renderPage(page, 2), 'image/jpeg', 0.85) });
    else pages.push({ ...size, ...layout(await page.getTextContent(), viewport) });
    progress(n / total);
  });
  if (v.mode === 'text' && !pages.some((page) => page.paragraphs.length)) {
    throw new Error('El PDF no contiene texto seleccionable (puede ser un escaneo). Prueba el modo «Idéntico».');
  }
  return { blob: await writeDocx(pages), name: `${base(file.name)}.docx` };
}

export default [
  {
    id: 'word-pdf',
    cat: 'documentos',
    name: 'Word a PDF',
    desc: 'Abre y mira un documento Word (.docx) y guárdalo como PDF.',
    render: viewer({ accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', title: 'Documento', open: openWord }),
  },
  {
    id: 'pdf-word',
    cat: 'documentos',
    name: 'PDF a Word',
    desc: 'Convierte un PDF en un documento Word (.docx).',
    files: { accept: 'application/pdf,.pdf' },
    fields: [
      {
        key: 'mode',
        label: 'Resultado',
        type: 'select',
        value: 'text',
        options: [
          ['text', 'Texto editable (se pierde el diseño)'],
          ['image', 'Idéntico al PDF (páginas como imagen, no editable)'],
        ],
      },
    ],
    note: 'El modo de texto recupera los párrafos, no las tablas, columnas ni imágenes. Un PDF escaneado solo se puede convertir en modo idéntico.',
    action: 'Convertir a Word',
    run: pdfToWord,
  },
  {
    id: 'diapositivas',
    cat: 'documentos',
    name: 'Ver diapositivas',
    desc: 'Abre una presentación PowerPoint (.pptx) y guárdala como PDF.',
    render: viewer({ accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', title: 'Presentación', open: openSlides }),
  },
  {
    id: 'excel-ver',
    cat: 'documentos',
    name: 'Ver Excel',
    desc: 'Abre una hoja de cálculo (.xlsx) y pásala a CSV.',
    render: renderExcel,
  },
  {
    id: 'csv-excel',
    cat: 'documentos',
    name: 'CSV a Excel',
    desc: 'Convierte un archivo CSV en una hoja de cálculo (.xlsx).',
    files: { accept: '.csv,.tsv,.txt,text/csv', preview: false },
    action: 'Convertir a Excel',
    run: csvToExcel,
  },
];
