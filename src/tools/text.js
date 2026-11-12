import { encode } from '../lib/image.js';
import { base } from '../ui.js';

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(
    ' ',
  );

/** Unbiased random integer in [0, max) from the crypto source. */
function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return buffer[0] % max;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  let binary;
  try {
    binary = atob(text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new Error('El texto no es Base64 válido.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    throw new Error('El contenido decodificado no es texto UTF-8.');
  }
}

async function hash(data, algorithm) {
  if (!crypto.subtle) throw new Error('El cálculo de hash requiere HTTPS o localhost.');
  const digest = await crypto.subtle.digest(algorithm, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const words = (text) => text.match(/[\p{L}\p{N}]+/gu) || [];
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
const plain = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '');

const CASES = {
  upper: (t) => t.toUpperCase(),
  lower: (t) => t.toLowerCase(),
  title: (t) => t.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase()),
  sentence: (t) => t.toLowerCase().replace(/(^\s*|[.!?¿¡]\s+)(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase()),
  camel: (t) => words(plain(t)).map((w, i) => (i ? capital(w) : w.toLowerCase())).join(''),
  snake: (t) => words(plain(t)).map((w) => w.toLowerCase()).join('_'),
  kebab: (t) => words(plain(t)).map((w) => w.toLowerCase()).join('-'),
};

function count(text) {
  const wordCount = words(text).length;
  return [
    `Caracteres: ${[...text].length}`,
    `Caracteres sin espacios: ${[...text.replace(/\s/g, '')].length}`,
    `Palabras: ${wordCount}`,
    `Líneas: ${text.split('\n').length}`,
    `Párrafos: ${text.split(/\n\s*\n/).filter((p) => p.trim()).length}`,
    `Lectura estimada: ${Math.max(1, Math.round(wordCount / 200))} min`,
  ].join('\n');
}

function lines(text, v) {
  let list = text.split('\n');
  if (v.trim) list = list.map((line) => line.trim());
  if (v.noEmpty) list = list.filter((line) => line.trim());
  if (v.unique) list = [...new Set(list)];
  if (v.order === 'az' || v.order === 'za') list.sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  if (v.order === 'za' || v.order === 'reverse') list.reverse();
  return list.join('\n');
}

function lorem(v) {
  if (!(v.paragraphs >= 1 && v.paragraphs <= 100)) throw new Error('Los párrafos deben estar entre 1 y 100.');
  const sentence = () => {
    const length = 6 + randomInt(10);
    const text = Array.from({ length }, () => LOREM[randomInt(LOREM.length)]).join(' ');
    return `${capital(text.charAt(0))}${text.slice(1)}.`;
  };
  return Array.from({ length: v.paragraphs }, (_, i) => {
    const body = Array.from({ length: 3 + randomInt(4) }, sentence).join(' ');
    return i === 0 ? `Lorem ipsum dolor sit amet. ${body}` : body;
  }).join('\n\n');
}

function password(v) {
  const sets = [
    v.lower && 'abcdefghijklmnopqrstuvwxyz',
    v.upper && 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    v.digits && '0123456789',
    v.symbols && '!@#$%^&*()-_=+[]{};:,.?',
  ].filter(Boolean);
  if (!sets.length) throw new Error('Marca al menos un tipo de carácter.');
  if (!(v.length >= sets.length && v.length <= 256)) throw new Error(`La longitud debe estar entre ${sets.length} y 256.`);
  if (!(v.count >= 1 && v.count <= 100)) throw new Error('La cantidad debe estar entre 1 y 100.');
  const all = sets.join('');
  const one = () => {
    // One character from every chosen set, the rest from all of them, then shuffled.
    const chars = sets.map((set) => set[randomInt(set.length)]);
    while (chars.length < v.length) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  };
  return Array.from({ length: v.count }, one).join('\n');
}

function color(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;
  const light = (max + min) / 2;
  const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0;
  let hue = 0;
  if (delta) {
    if (max === rf) hue = ((gf - bf) / delta) % 6;
    else if (max === gf) hue = (bf - rf) / delta + 2;
    else hue = (rf - gf) / delta + 4;
  }
  hue = Math.round(hue * 60 + 360) % 360;
  return `HEX: ${hex.toUpperCase()}\nRGB: rgb(${r}, ${g}, ${b})\nHSL: hsl(${hue}, ${Math.round(saturation * 100)}%, ${Math.round(light * 100)}%)`;
}

function timestamp(input) {
  const text = input.trim();
  let date;
  if (!text) date = new Date();
  // Values below 1e11 are seconds (until year 5138); larger ones are milliseconds.
  else if (/^-?\d+(\.\d+)?$/.test(text)) date = new Date(Math.abs(Number(text)) < 1e11 ? Number(text) * 1000 : Number(text));
  else date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error('No se reconoce la fecha. Usa un timestamp Unix o un formato como 2026-11-10 14:30.');
  return [
    `Unix (segundos): ${Math.floor(date.getTime() / 1000)}`,
    `Unix (milisegundos): ${date.getTime()}`,
    `ISO 8601 (UTC): ${date.toISOString()}`,
    `Hora local: ${date.toLocaleString('es', { dateStyle: 'full', timeStyle: 'long' })}`,
  ].join('\n');
}

async function qr({ text, v }) {
  const { default: QRCode } = await import('qrcode');
  let canvas;
  try {
    canvas = await QRCode.toCanvas(text, {
      width: v.size,
      margin: 2,
      errorCorrectionLevel: v.level,
      color: { dark: v.dark, light: v.light },
    });
  } catch (error) {
    throw new Error(/too big/i.test(error.message) ? 'El texto es demasiado largo para un código QR.' : error.message);
  }
  return { blob: await encode(canvas, 'image/png'), name: 'codigo-qr.png' };
}

async function zipCreate({ files, progress }) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const seen = new Map();
  for (const file of files) {
    const n = seen.get(file.name) || 0;
    seen.set(file.name, n + 1);
    zip.file(n ? file.name.replace(/(\.[^.]*)?$/, `-${n}$1`) : file.name, file);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, ({ percent }) => progress(percent / 100));
  return { blob, name: files.length === 1 ? `${base(files[0].name)}.zip` : 'archivos.zip' };
}

async function zipExtract({ file, progress }) {
  const { default: JSZip } = await import('jszip');
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('El archivo no es un ZIP válido o está protegido con contraseña.');
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (!entries.length) throw new Error('El ZIP no contiene archivos.');
  const results = [];
  for (const [i, entry] of entries.entries()) {
    // Entry names come from the archive: flatten the path so it is a plain file name.
    results.push({ blob: await entry.async('blob'), name: entry.name.replace(/[\\/]+/g, '_') });
    progress((i + 1) / entries.length);
  }
  return results;
}

const algorithm = { key: 'algorithm', label: 'Algoritmo', type: 'select', value: 'SHA-256', options: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] };
const text = (tool) => ({ cat: 'texto', text: true, live: true, ...tool });
const util = (tool) => ({ cat: 'utilidades', ...tool });

export default [
  text({ id: 'texto-contar', name: 'Contador de palabras', desc: 'Cuenta caracteres, palabras, líneas y párrafos.', run: ({ text: t }) => count(t) }),
  text({
    id: 'texto-mayusculas',
    name: 'Mayúsculas y minúsculas',
    desc: 'Cambia a MAYÚSCULAS, minúsculas, Título, camelCase y más.',
    fields: [
      {
        key: 'mode',
        label: 'Convertir a',
        type: 'select',
        value: 'upper',
        options: [
          ['upper', 'MAYÚSCULAS'],
          ['lower', 'minúsculas'],
          ['title', 'Tipo Título'],
          ['sentence', 'Tipo oración'],
          ['camel', 'camelCase'],
          ['snake', 'snake_case'],
          ['kebab', 'kebab-case (slug)'],
        ],
      },
    ],
    run: ({ text: t, v }) => CASES[v.mode](t),
  }),
  text({
    id: 'texto-lineas',
    name: 'Ordenar y limpiar líneas',
    desc: 'Ordena, quita duplicados y líneas vacías.',
    fields: [
      {
        key: 'order',
        label: 'Orden',
        type: 'select',
        value: 'az',
        options: [
          ['none', 'Sin ordenar'],
          ['az', 'A → Z'],
          ['za', 'Z → A'],
          ['reverse', 'Invertir'],
        ],
      },
      { key: 'unique', label: 'Quitar duplicados', type: 'checkbox', value: true },
      { key: 'noEmpty', label: 'Quitar líneas vacías', type: 'checkbox', value: true },
      { key: 'trim', label: 'Quitar espacios sobrantes', type: 'checkbox', value: true },
    ],
    run: ({ text: t, v }) => lines(t, v),
  }),
  text({
    id: 'texto-json',
    name: 'Formatear JSON',
    desc: 'Valida, ordena o minifica JSON.',
    fields: [
      {
        key: 'mode',
        label: 'Salida',
        type: 'select',
        value: '2',
        options: [
          ['2', 'Sangría de 2 espacios'],
          ['4', 'Sangría de 4 espacios'],
          ['0', 'Minificado'],
        ],
      },
    ],
    run({ text: t, v }) {
      let data;
      try {
        data = JSON.parse(t);
      } catch (error) {
        throw new Error(`JSON inválido: ${error.message}`);
      }
      return JSON.stringify(data, null, Number(v.mode));
    },
  }),
  text({
    id: 'texto-base64',
    name: 'Base64',
    desc: 'Codifica o decodifica texto en Base64.',
    fields: [
      {
        key: 'mode',
        label: 'Acción',
        type: 'select',
        value: 'encode',
        options: [
          ['encode', 'Codificar'],
          ['decode', 'Decodificar'],
        ],
      },
    ],
    run: ({ text: t, v }) => (v.mode === 'encode' ? toBase64(new TextEncoder().encode(t)) : fromBase64(t)),
  }),
  text({
    id: 'texto-url',
    name: 'Codificar URL',
    desc: 'Codifica o decodifica texto para URL.',
    fields: [
      {
        key: 'mode',
        label: 'Acción',
        type: 'select',
        value: 'encode',
        options: [
          ['encode', 'Codificar'],
          ['decode', 'Decodificar'],
        ],
      },
    ],
    run({ text: t, v }) {
      if (v.mode === 'encode') return encodeURIComponent(t);
      try {
        return decodeURIComponent(t);
      } catch {
        throw new Error('El texto contiene secuencias % inválidas.');
      }
    },
  }),
  text({
    id: 'texto-hash',
    name: 'Hash de texto',
    desc: 'Calcula SHA-1, SHA-256, SHA-384 o SHA-512.',
    fields: [algorithm],
    run: ({ text: t, v }) => hash(new TextEncoder().encode(t), v.algorithm),
  }),
  {
    id: 'texto-lorem',
    name: 'Lorem ipsum',
    desc: 'Genera texto de relleno.',
    cat: 'texto',
    action: 'Generar',
    fields: [{ key: 'paragraphs', label: 'Párrafos', type: 'number', min: 1, max: 100, value: 3 }],
    run: ({ v }) => lorem(v),
  },
  util({
    id: 'qr',
    name: 'Generar código QR',
    desc: 'Crea un QR de un enlace o texto.',
    text: { placeholder: 'https://ejemplo.com' },
    live: true,
    fields: [
      { key: 'size', label: 'Tamaño (px)', type: 'number', min: 64, max: 2048, value: 512 },
      {
        key: 'level',
        label: 'Corrección de errores',
        type: 'select',
        value: 'M',
        options: [
          ['L', 'Baja'],
          ['M', 'Media'],
          ['Q', 'Alta'],
          ['H', 'Máxima'],
        ],
      },
      { key: 'dark', label: 'Color', type: 'color', value: '#000000' },
      { key: 'light', label: 'Fondo', type: 'color', value: '#ffffff' },
    ],
    run: qr,
  }),
  util({
    id: 'contrasena',
    name: 'Generar contraseñas',
    desc: 'Contraseñas aleatorias seguras, creadas en tu equipo.',
    action: 'Generar',
    fields: [
      { key: 'length', label: 'Longitud', type: 'number', min: 4, max: 256, value: 20 },
      { key: 'count', label: 'Cantidad', type: 'number', min: 1, max: 100, value: 1 },
      { key: 'lower', label: 'Minúsculas', type: 'checkbox', value: true },
      { key: 'upper', label: 'Mayúsculas', type: 'checkbox', value: true },
      { key: 'digits', label: 'Números', type: 'checkbox', value: true },
      { key: 'symbols', label: 'Símbolos', type: 'checkbox', value: true },
    ],
    run: ({ v }) => password(v),
  }),
  util({
    id: 'uuid',
    name: 'Generar UUID',
    desc: 'Identificadores únicos UUID v4.',
    action: 'Generar',
    fields: [{ key: 'count', label: 'Cantidad', type: 'number', min: 1, max: 1000, value: 5 }],
    run({ v }) {
      if (!(v.count >= 1 && v.count <= 1000)) throw new Error('La cantidad debe estar entre 1 y 1000.');
      return Array.from({ length: v.count }, () => crypto.randomUUID()).join('\n');
    },
  }),
  util({
    id: 'color',
    name: 'Convertir color',
    desc: 'Elige un color y obtén HEX, RGB y HSL.',
    live: true,
    fields: [{ key: 'color', label: 'Color', type: 'color', value: '#2563eb' }],
    run: ({ v }) => color(v.color),
  }),
  util({
    id: 'fecha-unix',
    name: 'Convertir fecha y timestamp',
    desc: 'Pasa entre timestamp Unix y fecha legible.',
    live: true,
    fields: [{ key: 'input', label: 'Timestamp o fecha', placeholder: '1794268800 o 2026-11-10 14:30', hint: 'Vacío = ahora.' }],
    run: ({ v }) => timestamp(v.input),
  }),
  util({
    id: 'archivo-hash',
    name: 'Hash de archivo',
    desc: 'Verifica la integridad de un archivo con SHA.',
    files: { accept: '', preview: false },
    action: 'Calcular',
    fields: [algorithm],
    run: async ({ file, v }) => hash(await file.arrayBuffer(), v.algorithm),
  }),
  util({
    id: 'archivo-base64',
    name: 'Archivo a Base64',
    desc: 'Convierte un archivo en una URL de datos (data URI).',
    files: { accept: '' },
    action: 'Convertir',
    run: async ({ file }) => `data:${file.type || 'application/octet-stream'};base64,${toBase64(new Uint8Array(await file.arrayBuffer()))}`,
  }),
  util({
    id: 'zip-crear',
    name: 'Crear ZIP',
    desc: 'Comprime varios archivos en un ZIP.',
    files: { accept: '', multiple: true, preview: false },
    action: 'Comprimir',
    run: zipCreate,
  }),
  util({
    id: 'zip-extraer',
    name: 'Extraer ZIP',
    desc: 'Abre un ZIP y descarga su contenido.',
    files: { accept: '.zip,application/zip', preview: false },
    action: 'Extraer',
    run: zipExtract,
  }),
];
