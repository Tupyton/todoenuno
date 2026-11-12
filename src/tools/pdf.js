import { encode, loadImage, drawn } from '../lib/image.js';
import { eachPage, open, parseRanges, pdfLib, renderPage, save, subset } from '../lib/pdf.js';
import { base } from '../ui.js';

const ONE = { accept: 'application/pdf,.pdf' };
const MANY = { ...ONE, multiple: true };

const pagesField = (label, hint) => ({ key: 'pages', label, placeholder: '1-3, 5, 8-10', hint });

function hexToRgb(hex, rgb) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function merge({ files, progress }) {
  if (files.length < 2) throw new Error('Selecciona al menos dos PDF.');
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    const src = await open(file);
    (await doc.copyPages(src, src.getPageIndices())).forEach((page) => doc.addPage(page));
    progress((i + 1) / files.length);
  }
  return save(doc, 'unido.pdf');
}

async function split({ file, v, progress }) {
  const src = await open(file);
  const total = src.getPageCount();
  const groups = v.pages.trim()
    ? v.pages.split(',').filter((part) => part.trim()).map((part) => parseRanges(part, total))
    : src.getPageIndices().map((i) => [i]);
  const results = [];
  for (const [i, group] of groups.entries()) {
    const label = group.length > 1 ? `${group[0] + 1}-${group.at(-1) + 1}` : `${group[0] + 1}`;
    results.push(await save(await subset(src, group), `${base(file.name)}-${label}.pdf`));
    progress((i + 1) / groups.length);
  }
  return results;
}

async function extract({ file, v }) {
  const src = await open(file);
  return save(await subset(src, parseRanges(v.pages, src.getPageCount())), `${base(file.name)}-extraido.pdf`);
}

async function remove({ file, v }) {
  const src = await open(file);
  const drop = new Set(parseRanges(v.pages, src.getPageCount()));
  const keep = src.getPageIndices().filter((i) => !drop.has(i));
  if (!keep.length) throw new Error('No puedes eliminar todas las páginas.');
  return save(await subset(src, keep), `${base(file.name)}-sin-paginas.pdf`);
}

async function rotate({ file, v }) {
  const { degrees } = await pdfLib();
  const doc = await open(file);
  const pages = doc.getPages();
  const targets = v.pages.trim() ? parseRanges(v.pages, pages.length) : pages.map((_, i) => i);
  for (const i of new Set(targets)) {
    pages[i].setRotation(degrees((pages[i].getRotation().angle + Number(v.angle)) % 360));
  }
  return save(doc, `${base(file.name)}-rotado.pdf`);
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

async function imagesToPdf({ files, v, progress }) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    // pdf-lib embeds JPG and PNG only; anything else goes through a canvas to PNG.
    const embedded =
      file.type === 'image/jpeg'
        ? await doc.embedJpg(await file.arrayBuffer())
        : await doc.embedPng(await (await encode(drawn(await loadImage(file)), 'image/png')).arrayBuffer());
    if (v.size === 'fit') {
      doc.addPage([embedded.width + v.margin * 2, embedded.height + v.margin * 2]).drawImage(embedded, { x: v.margin, y: v.margin });
    } else {
      let [pw, ph] = PAGE_SIZES[v.size];
      if (embedded.width > embedded.height) [pw, ph] = [ph, pw];
      const scale = Math.min((pw - v.margin * 2) / embedded.width, (ph - v.margin * 2) / embedded.height);
      if (!(scale > 0)) throw new Error('El margen es demasiado grande para la página.');
      const w = embedded.width * scale;
      const ht = embedded.height * scale;
      doc.addPage([pw, ph]).drawImage(embedded, { x: (pw - w) / 2, y: (ph - ht) / 2, width: w, height: ht });
    }
    progress((i + 1) / files.length);
  }
  return save(doc, 'imagenes.pdf');
}

async function pdfToImages({ file, v, progress }) {
  const type = v.format;
  const results = [];
  await eachPage(file, async (page, n, total) => {
    const canvas = await renderPage(page, Number(v.scale));
    results.push({
      blob: await encode(canvas, type, 0.92),
      name: `${base(file.name)}-${String(n).padStart(String(total).length, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`,
    });
    progress(n / total);
  });
  return results;
}

async function numberPages({ file, v }) {
  const { StandardFonts, rgb } = await pdfLib();
  const doc = await open(file);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const text = v.template.replaceAll('{n}', i + v.start).replaceAll('{total}', pages.length + v.start - 1);
    const textWidth = font.widthOfTextAtSize(text, v.size);
    const { width } = page.getSize();
    const x = v.position === 'center' ? (width - textWidth) / 2 : v.position === 'right' ? width - textWidth - 36 : 36;
    page.drawText(text, { x, y: 24, size: v.size, font, color: rgb(0.2, 0.2, 0.2) });
  });
  return save(doc, `${base(file.name)}-numerado.pdf`);
}

async function watermark({ file, v }) {
  if (!v.text.trim()) throw new Error('Escribe el texto de la marca de agua.');
  const { StandardFonts, degrees, rgb } = await pdfLib();
  const doc = await open(file);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const angle = (v.angle * Math.PI) / 180;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(v.text, v.size);
    // Offset the origin so the rotated text is centered on the page.
    const x = width / 2 - (textWidth / 2) * Math.cos(angle) + (v.size / 3) * Math.sin(angle);
    const y = height / 2 - (textWidth / 2) * Math.sin(angle) - (v.size / 3) * Math.cos(angle);
    page.drawText(v.text, { x, y, size: v.size, font, color: hexToRgb(v.color, rgb), opacity: v.opacity / 100, rotate: degrees(v.angle) });
  }
  return save(doc, `${base(file.name)}-marca.pdf`);
}

async function extractText({ file, progress }) {
  const parts = [];
  await eachPage(file, async (page, n, total) => {
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(''));
    progress(n / total);
  });
  const text = parts.join('\n\n').trim();
  if (!text) throw new Error('El PDF no contiene texto seleccionable (puede ser un escaneo).');
  return text;
}

async function compress({ file, v, progress }) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  await eachPage(file, async (page, n, total) => {
    const { width, height } = page.getViewport({ scale: 1 });
    const jpeg = await encode(await renderPage(page, Number(v.scale)), 'image/jpeg', v.quality / 100);
    doc.addPage([width, height]).drawImage(await doc.embedJpg(await jpeg.arrayBuffer()), { x: 0, y: 0, width, height });
    progress(n / total);
  });
  const result = await save(doc, `${base(file.name)}-comprimido.pdf`);
  if (result.blob.size >= file.size) {
    throw new Error('El resultado no es más pequeño que el original. Prueba con menos calidad o resolución.');
  }
  return result;
}

const pdf = (tool) => ({ cat: 'pdf', files: ONE, ...tool });

export default [
  pdf({ id: 'pdf-unir', name: 'Unir PDF', desc: 'Junta varios PDF en uno, en el orden que elijas.', files: MANY, action: 'Unir', run: merge }),
  pdf({
    id: 'pdf-dividir',
    name: 'Dividir PDF',
    desc: 'Separa un PDF en varios archivos.',
    action: 'Dividir',
    fields: [pagesField('Rangos (un archivo por cada uno)', 'Vacío = un archivo por página.')],
    run: split,
  }),
  pdf({
    id: 'pdf-extraer',
    name: 'Extraer y ordenar páginas',
    desc: 'Crea un PDF con las páginas que indiques, en ese orden.',
    action: 'Extraer',
    fields: [pagesField('Páginas', 'El orden escrito es el orden final: 3, 1, 2 reordena.')],
    run: extract,
  }),
  pdf({ id: 'pdf-eliminar', name: 'Eliminar páginas', desc: 'Quita páginas de un PDF.', action: 'Eliminar', fields: [pagesField('Páginas a eliminar')], run: remove }),
  pdf({
    id: 'pdf-rotar',
    name: 'Rotar PDF',
    desc: 'Gira todas las páginas o solo algunas.',
    action: 'Rotar',
    fields: [
      {
        key: 'angle',
        label: 'Rotación',
        type: 'select',
        value: '90',
        options: [
          ['90', '90° a la derecha'],
          ['180', '180°'],
          ['270', '90° a la izquierda'],
        ],
      },
      pagesField('Páginas', 'Vacío = todas.'),
    ],
    run: rotate,
  }),
  pdf({
    id: 'pdf-desde-imagenes',
    name: 'Imágenes a PDF',
    desc: 'Convierte JPG, PNG o WebP en un PDF.',
    files: { accept: 'image/*', multiple: true },
    action: 'Crear PDF',
    fields: [
      {
        key: 'size',
        label: 'Tamaño de página',
        type: 'select',
        value: 'a4',
        options: [
          ['a4', 'A4'],
          ['letter', 'Carta'],
          ['fit', 'Ajustada a la imagen'],
        ],
      },
      { key: 'margin', label: 'Margen (pt)', type: 'number', min: 0, value: 20 },
    ],
    run: imagesToPdf,
  }),
  pdf({
    id: 'pdf-a-imagenes',
    name: 'PDF a imágenes',
    desc: 'Exporta cada página como PNG o JPG.',
    action: 'Convertir',
    fields: [
      {
        key: 'format',
        label: 'Formato',
        type: 'select',
        value: 'image/png',
        options: [
          ['image/png', 'PNG'],
          ['image/jpeg', 'JPG'],
        ],
      },
      {
        key: 'scale',
        label: 'Resolución',
        type: 'select',
        value: '2',
        options: [
          ['1', 'Normal (72 ppp)'],
          ['2', 'Alta (144 ppp)'],
          ['3', 'Muy alta (216 ppp)'],
        ],
      },
    ],
    run: pdfToImages,
  }),
  pdf({
    id: 'pdf-comprimir',
    name: 'Comprimir PDF',
    desc: 'Reduce el peso convirtiendo las páginas en imágenes.',
    action: 'Comprimir',
    note: 'Las páginas pasan a ser imágenes: el texto deja de ser seleccionable. Funciona mejor con escaneos.',
    fields: [
      { key: 'quality', label: 'Calidad', type: 'range', min: 10, max: 95, value: 60 },
      {
        key: 'scale',
        label: 'Resolución',
        type: 'select',
        value: '1.5',
        options: [
          ['1', 'Baja (72 ppp)'],
          ['1.5', 'Media (108 ppp)'],
          ['2', 'Alta (144 ppp)'],
        ],
      },
    ],
    run: compress,
  }),
  pdf({
    id: 'pdf-numerar',
    name: 'Numerar páginas',
    desc: 'Añade el número de página al pie.',
    action: 'Numerar',
    fields: [
      { key: 'template', label: 'Texto', value: '{n} / {total}', hint: '{n} = página, {total} = última.' },
      {
        key: 'position',
        label: 'Posición',
        type: 'select',
        value: 'center',
        options: [
          ['left', 'Izquierda'],
          ['center', 'Centro'],
          ['right', 'Derecha'],
        ],
      },
      { key: 'start', label: 'Empezar en', type: 'number', value: 1 },
      { key: 'size', label: 'Tamaño de letra', type: 'number', min: 4, value: 10 },
    ],
    run: numberPages,
  }),
  pdf({
    id: 'pdf-marca-agua',
    name: 'Marca de agua en PDF',
    desc: 'Estampa un texto en todas las páginas.',
    action: 'Añadir marca',
    fields: [
      { key: 'text', label: 'Texto', value: 'CONFIDENCIAL' },
      { key: 'size', label: 'Tamaño de letra', type: 'number', min: 4, value: 60 },
      { key: 'angle', label: 'Ángulo (°)', type: 'number', value: 45 },
      { key: 'opacity', label: 'Opacidad (%)', type: 'range', min: 5, max: 100, value: 25 },
      { key: 'color', label: 'Color', type: 'color', value: '#ff0000' },
    ],
    run: watermark,
  }),
  pdf({ id: 'pdf-texto', name: 'Extraer texto de PDF', desc: 'Obtén el texto de un PDF para copiarlo.', action: 'Extraer texto', run: extractText }),
];
