import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { makeCanvas } from './image.js';

export const pdfLib = () => import('pdf-lib');

let pdfjsPromise;
function pdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
  return pdfjsPromise;
}

/** Opens a PDF for editing with pdf-lib. */
export async function open(file) {
  const { PDFDocument } = await pdfLib();
  try {
    return await PDFDocument.load(await file.arrayBuffer());
  } catch (error) {
    const reason = /encrypt/i.test(error.message) ? 'está protegido con contraseña' : error.message;
    throw new Error(`No se pudo abrir ${file.name}: ${reason}`);
  }
}

export async function save(doc, name) {
  return { blob: new Blob([await doc.save()], { type: 'application/pdf' }), name };
}

/** New document with the given zero-based pages of `src`, in that order. */
export async function subset(src, indices) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  (await doc.copyPages(src, indices)).forEach((page) => doc.addPage(page));
  return doc;
}

/** Parses "1-3, 5, 9-7" into zero-based page indices, keeping the written order. */
export function parseRanges(text, total) {
  const pages = [];
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error(`Rango inválido: "${part}". Usa el formato 1-3, 5, 8-10.`);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (from < 1 || to < 1 || from > total || to > total) {
      throw new Error(`"${part}" está fuera de rango: el PDF tiene ${total} páginas.`);
    }
    const step = from <= to ? 1 : -1;
    for (let p = from; p !== to + step; p += step) pages.push(p - 1);
  }
  if (!pages.length) throw new Error('Indica al menos una página.');
  return pages;
}

/** Opens a PDF for reading with pdf.js and calls `each(page, number, total)` for every page. */
export async function eachPage(file, each) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: await file.arrayBuffer() });
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) await each(await doc.getPage(n), n, doc.numPages);
  } finally {
    await task.destroy();
  }
}

export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(viewport.width, viewport.height);
  // The default 'display' intent paints with requestAnimationFrame, which stalls in a background tab.
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise;
  return canvas;
}
