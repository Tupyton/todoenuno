import { base } from '../ui.js';

/*
 * TTF/OTF ↔ WOFF. A WOFF file holds the same tables as the TTF/OTF, each one compressed with zlib,
 * so converting is only a matter of rewriting the table directory. WOFF2 uses a different
 * compression (Brotli plus table transforms) and is not handled here.
 */

const tag = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
const pad4 = (n) => (n + 3) & ~3;

async function zlib(bytes, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readSfnt(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint16(4);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > buffer.byteLength) throw new Error('La fuente está dañada.');
    tables.push({ tag: tag(view, at), checksum: view.getUint32(at + 4), data: new Uint8Array(buffer, offset, length) });
  }
  return { flavor: view.getUint32(0), tables };
}

async function sfntToWoff(buffer) {
  const { flavor, tables } = readSfnt(buffer);
  const stored = [];
  for (const table of tables) {
    const packed = await zlib(table.data, 'compress');
    // A table is stored compressed only when that makes it smaller.
    stored.push({ ...table, body: packed.length < table.data.length ? packed : table.data });
  }
  const headerSize = 44 + tables.length * 20;
  const length = stored.reduce((total, t) => total + pad4(t.body.length), headerSize);
  const sfntSize = tables.reduce((total, t) => total + pad4(t.data.length), 12 + tables.length * 16);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x774f4646); // wOFF
  view.setUint32(4, flavor);
  view.setUint32(8, length);
  view.setUint16(12, tables.length);
  view.setUint32(16, sfntSize);
  view.setUint16(20, 1);
  let offset = headerSize;
  stored.forEach((table, i) => {
    const at = 44 + i * 20;
    for (let c = 0; c < 4; c++) view.setUint8(at + c, table.tag.charCodeAt(c));
    view.setUint32(at + 4, offset);
    view.setUint32(at + 8, table.body.length);
    view.setUint32(at + 12, table.data.length);
    view.setUint32(at + 16, table.checksum);
    out.set(table.body, offset);
    offset += pad4(table.body.length);
  });
  return { bytes: out, flavor };
}

async function woffToSfnt(buffer) {
  const view = new DataView(buffer);
  const flavor = view.getUint32(4);
  const count = view.getUint16(12);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    if (offset + compLength > buffer.byteLength) throw new Error('La fuente está dañada.');
    const body = new Uint8Array(buffer, offset, compLength);
    const data = compLength < origLength ? await zlib(body, 'decompress') : body;
    if (data.length !== origLength) throw new Error('La fuente está dañada.');
    tables.push({ tag: tag(view, at), checksum: view.getUint32(at + 16), data });
  }
  // The table directory must be sorted by tag, with the binary search values the format defines.
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const power = 2 ** Math.floor(Math.log2(count));
  const headerSize = 12 + count * 16;
  const out = new Uint8Array(tables.reduce((total, t) => total + pad4(t.data.length), headerSize));
  const tableDir = new DataView(out.buffer);
  tableDir.setUint32(0, flavor);
  tableDir.setUint16(4, count);
  tableDir.setUint16(6, power * 16);
  tableDir.setUint16(8, Math.log2(power));
  tableDir.setUint16(10, count * 16 - power * 16);
  let offset = headerSize;
  tables.forEach((table, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) tableDir.setUint8(at + c, table.tag.charCodeAt(c));
    tableDir.setUint32(at + 4, table.checksum);
    tableDir.setUint32(at + 8, offset);
    tableDir.setUint32(at + 12, table.data.length);
    out.set(table.data, offset);
    offset += pad4(table.data.length);
  });
  return { bytes: out, flavor };
}

const OTTO = 0x4f54544f;

async function convertFont({ file }) {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength < 12) throw new Error('El archivo no es una fuente.');
  const signature = new DataView(buffer).getUint32(0);
  if (signature === 0x774f4632) throw new Error('Las fuentes WOFF2 no se pueden convertir aquí. Usa un TTF, OTF o WOFF.');
  if (signature === 0x774f4646) {
    const { bytes, flavor } = await woffToSfnt(buffer);
    const extension = flavor === OTTO ? 'otf' : 'ttf';
    return { blob: new Blob([bytes], { type: `font/${extension}` }), name: `${base(file.name)}.${extension}` };
  }
  if (signature === 0x00010000 || signature === OTTO || signature === 0x74727565) {
    const { bytes } = await sfntToWoff(buffer);
    return { blob: new Blob([bytes], { type: 'font/woff' }), name: `${base(file.name)}.woff` };
  }
  throw new Error('El archivo no es una fuente TTF, OTF ni WOFF.');
}

export default [
  {
    id: 'fuente-convertir',
    name: 'Convertir fuente',
    desc: 'Pasa una fuente TTF u OTF a WOFF para la web, o un WOFF de vuelta a TTF/OTF.',
    cat: 'utilidades',
    files: { accept: '.ttf,.otf,.woff,font/ttf,font/otf,font/woff', preview: false },
    note: 'El formato de salida se elige solo: TTF y OTF pasan a WOFF, y WOFF vuelve a su formato original.',
    action: 'Convertir',
    run: convertFont,
  },
];
