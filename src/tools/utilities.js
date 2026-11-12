import { loadImage, makeCanvas } from '../lib/image.js';
import { fileZone } from '../tool-page.js';
import { h } from '../ui.js';

/* Compare texts */

const MAX_DIFF_CELLS = 4_000_000;

/** Line diff by longest common subsequence. Returns [{ type: ' ' | '+' | '-', line }]. */
function diffLines(a, b) {
  if (a.length * b.length > MAX_DIFF_CELLS) throw new Error('Los textos son demasiado largos para compararlos aquí.');
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', line: a[i++] });
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) out.push({ type: '-', line: a[i++] });
    else out.push({ type: '+', line: b[j++] });
  }
  while (i < a.length) out.push({ type: '-', line: a[i++] });
  while (j < b.length) out.push({ type: '+', line: b[j++] });
  return out;
}

function renderDiff(root) {
  const status = h('p', { class: 'status', role: 'status' });
  const out = h('pre', { class: 'diff' });
  const area = (label) => h('textarea', { rows: 8, 'aria-label': label, placeholder: label, oninput: compare });
  const left = area('Texto original');
  const right = area('Texto modificado');
  function compare() {
    status.classList.remove('error');
    out.replaceChildren();
    if (!left.value && !right.value) return (status.textContent = '');
    try {
      const rows = diffLines(left.value.split('\n'), right.value.split('\n'));
      const added = rows.filter((r) => r.type === '+').length;
      const removed = rows.filter((r) => r.type === '-').length;
      status.textContent = added || removed ? `${added} líneas añadidas, ${removed} quitadas.` : 'Los textos son idénticos.';
      out.append(...rows.map((r) => h('span', { class: r.type === '+' ? 'add' : r.type === '-' ? 'del' : '' }, `${r.type} ${r.line}\n`)));
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
    }
  }
  root.append(h('div', { class: 'two' }, left, right), status, out);
}

/* Markdown */

async function markdown({ text }) {
  const { marked } = await import('marked');
  const page = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documento</title>
<style>
body { max-width: 760px; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #1a1a1a; }
pre, code { background: #f2f3f5; border-radius: 4px; }
code { padding: 0.1em 0.3em; }
pre { padding: 1em; overflow: auto; }
pre code { padding: 0; }
blockquote { margin: 0; padding-left: 1em; border-left: 4px solid #ccc; color: #555; }
table { border-collapse: collapse; }
td, th { border: 1px solid #ccc; padding: 0.3em 0.6em; }
img { max-width: 100%; }
</style>
</head>
<body>
${marked.parse(text)}
</body>
</html>`;
  // No allow-scripts: whatever the Markdown contains, nothing in the preview can run.
  const frame = h('iframe', { class: 'doc', sandbox: 'allow-same-origin allow-modals', srcdoc: page, title: 'Vista previa' });
  const print = h('button', { type: 'button', class: 'btn', onclick: () => frame.contentWindow.print() }, 'Imprimir o guardar como PDF');
  return [h('div', { class: 'result' }, frame, h('div', { class: 'result-row' }, print)), { blob: new Blob([page], { type: 'text/html' }), name: 'documento.html' }];
}

/* CSV and JSON */

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** Rows of a CSV text, guessing its delimiter. */
export function csvRows(text) {
  const firstLine = text.split('\n', 1)[0];
  // The delimiter that splits the header into most columns.
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best));
  return parseCsv(text.trim(), delimiter);
}

function csvJson({ text, v }) {
  if (v.direction === 'csv') {
    const [header, ...rows] = csvRows(text);
    if (!header) throw new Error('El CSV está vacío.');
    return JSON.stringify(rows.map((r) => Object.fromEntries(header.map((key, i) => [key, r[i] ?? '']))), null, 2);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON no válido: ${error.message}`);
  }
  const list = Array.isArray(data) ? data : [data];
  if (!list.every((item) => item && typeof item === 'object' && !Array.isArray(item))) throw new Error('Se espera una lista de objetos, por ejemplo [{"a": 1}].');
  const header = [...new Set(list.flatMap(Object.keys))];
  const cell = (value) => {
    const s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...list.map((item) => header.map((key) => item[key]))].map((r) => r.map(cell).join(',')).join('\n');
}

/* CSS */

function minifyCss({ text }) {
  // Strings and url() are set aside so the whitespace rules cannot touch them.
  const kept = [];
  const out = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\([^)]*\)/g, (m) => `\u0000${kept.push(m) - 1}\u0000`)
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};,]) ?/g, '$1')
    .replace(/: /g, ':')
    .replace(/;}/g, '}')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]);
  const saved = text.length ? Math.round((1 - out.length / text.length) * 100) : 0;
  return [out, h('p', { class: 'muted' }, `${text.length} → ${out.length} caracteres (${saved}% menos).`)];
}

/* Regular expressions */

const MAX_MATCHES = 500;

function regex({ text, v }) {
  if (!v.pattern) throw new Error('Escribe una expresión regular.');
  let re;
  try {
    re = new RegExp(v.pattern, [...new Set(`${v.flags}g`)].join(''));
  } catch (error) {
    throw new Error(`Expresión no válida: ${error.message}`);
  }
  const matches = [];
  for (const m of text.matchAll(re)) {
    if (matches.length === MAX_MATCHES) break;
    const groups = m.length > 1 ? `  grupos: ${m.slice(1).map((g) => JSON.stringify(g ?? null)).join(', ')}` : '';
    matches.push(`[${m.index}] ${JSON.stringify(m[0])}${groups}`);
  }
  if (!matches.length) return 'Sin coincidencias.';
  return `${matches.length}${matches.length === MAX_MATCHES ? '+' : ''} coincidencias\n\n${matches.join('\n')}`;
}

/* Units */

// Each unit is its size in the category's base unit.
const UNITS = {
  Longitud: { mm: 0.001, cm: 0.01, m: 1, km: 1000, pulgada: 0.0254, pie: 0.3048, yarda: 0.9144, milla: 1609.344 },
  Peso: { mg: 1e-6, g: 0.001, kg: 1, tonelada: 1000, onza: 0.028349523125, libra: 0.45359237 },
  Volumen: { ml: 0.001, l: 1, 'm³': 1000, cucharadita: 0.00492892, cucharada: 0.0147868, taza: 0.24, 'galón (EE. UU.)': 3.785411784 },
  Área: { 'cm²': 1e-4, 'm²': 1, hectárea: 1e4, 'km²': 1e6, 'pie²': 0.09290304, acre: 4046.8564224 },
  Velocidad: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, nudo: 0.514444 },
  Tiempo: { segundo: 1, minuto: 60, hora: 3600, día: 86400, semana: 604800, 'año': 31557600 },
  Datos: { byte: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 },
  Temperatura: null,
};
const TEMPERATURE = {
  '°C': [(c) => c, (c) => c],
  '°F': [(f) => ((f - 32) * 5) / 9, (c) => (c * 9) / 5 + 32],
  K: [(k) => k - 273.15, (c) => c + 273.15],
};

const formatNumber = (n) => (Number.isFinite(n) ? Number(n.toPrecision(10)).toLocaleString('es', { maximumFractionDigits: 10 }) : '—');

function renderUnits(root) {
  const option = (name) => h('option', { value: name }, name);
  const category = h('select', { onchange: fill }, Object.keys(UNITS).map(option));
  const from = h('select', { onchange: convert });
  const to = h('select', { onchange: convert });
  const amount = h('input', { type: 'number', value: 1, step: 'any', oninput: convert });
  const result = h('output', { class: 'big' });
  const names = () => Object.keys(UNITS[category.value] || TEMPERATURE);

  function fill() {
    from.replaceChildren(...names().map(option));
    to.replaceChildren(...names().map(option));
    to.selectedIndex = 1;
    convert();
  }

  function convert() {
    const value = Number(amount.value);
    const table = UNITS[category.value];
    const converted = table ? (value * table[from.value]) / table[to.value] : TEMPERATURE[to.value][1](TEMPERATURE[from.value][0](value));
    result.textContent = amount.value === '' ? '' : `${formatNumber(value)} ${from.value} = ${formatNumber(converted)} ${to.value}`;
  }

  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  root.append(h('div', { class: 'fields' }, field('Magnitud', category), field('Cantidad', amount), field('De', from), field('A', to)), result);
  fill();
}

/* Percentages */

function percentages({ v }) {
  const { a, b } = v;
  const lines = [
    `${formatNumber(a)}% de ${formatNumber(b)} = ${formatNumber((a / 100) * b)}`,
    `${formatNumber(b)} + ${formatNumber(a)}% = ${formatNumber(b * (1 + a / 100))}`,
    `${formatNumber(b)} − ${formatNumber(a)}% = ${formatNumber(b * (1 - a / 100))}`,
  ];
  if (b !== 0) lines.push(`${formatNumber(a)} es el ${formatNumber((a / b) * 100)}% de ${formatNumber(b)}`);
  if (a !== 0) lines.push(`De ${formatNumber(a)} a ${formatNumber(b)}: cambio del ${formatNumber(((b - a) / Math.abs(a)) * 100)}%`);
  return lines.join('\n');
}

/* Stopwatch and timer */

const two = (n) => String(Math.floor(n)).padStart(2, '0');
const clock = (ms, tenths) => {
  const s = ms / 1000;
  return `${s >= 3600 ? `${two(s / 3600)}:` : ''}${two((s / 60) % 60)}:${two(s % 60)}${tenths ? `.${Math.floor((ms % 1000) / 100)}` : ''}`;
};

function beep() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.2;
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.4);
    osc.stop(ctx.currentTime + i * 0.4 + 0.25);
  }
  setTimeout(() => ctx.close(), 2000);
}

function renderClock(root) {
  // Elapsed time comes from timestamps, so it stays right when the tab sleeps in the background.
  let startedAt = null;
  let accumulated = 0;
  let timerEnd = null;
  let remaining = 0;
  let laps = 0;
  const mode = h('select', { onchange: reset }, h('option', { value: 'stopwatch' }, 'Cronómetro'), h('option', { value: 'timer' }, 'Temporizador'));
  const minutes = h('input', { type: 'number', min: 0, max: 600, value: 5 });
  const seconds = h('input', { type: 'number', min: 0, max: 59, value: 0 });
  const duration = h(
    'div',
    { class: 'fields', hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Minutos'), minutes),
    h('label', { class: 'field' }, h('span', {}, 'Segundos'), seconds),
  );
  const display = h('output', { class: 'big clock' });
  const lapList = h('ol', { class: 'laps' });
  const toggle = h('button', { type: 'button', class: 'btn primary', onclick: startStop }, 'Iniciar');
  const lap = h('button', { type: 'button', class: 'btn', onclick: () => lapList.prepend(h('li', {}, `Vuelta ${++laps}: ${clock(elapsed(), true)}`)) }, 'Vuelta');
  const isTimer = () => mode.value === 'timer';
  const running = () => startedAt !== null || timerEnd !== null;
  const elapsed = () => accumulated + (startedAt === null ? 0 : Date.now() - startedAt);

  function paint() {
    if (!isTimer()) return (display.textContent = clock(elapsed(), true));
    const left = timerEnd === null ? remaining : Math.max(0, timerEnd - Date.now());
    display.textContent = clock(Math.ceil(left / 1000) * 1000);
    if (timerEnd !== null && left === 0) {
      timerEnd = null;
      remaining = 0;
      toggle.textContent = 'Iniciar';
      display.textContent = '¡Tiempo!';
      beep();
    }
  }

  function startStop() {
    if (isTimer()) {
      if (timerEnd !== null) {
        remaining = timerEnd - Date.now();
        timerEnd = null;
      } else {
        if (remaining <= 0) remaining = (Number(minutes.value) * 60 + Number(seconds.value)) * 1000;
        if (remaining <= 0) return;
        timerEnd = Date.now() + remaining;
      }
    } else if (startedAt !== null) {
      accumulated = elapsed();
      startedAt = null;
    } else startedAt = Date.now();
    toggle.textContent = running() ? 'Pausar' : 'Continuar';
    paint();
  }

  function reset() {
    startedAt = timerEnd = null;
    accumulated = remaining = laps = 0;
    lapList.replaceChildren();
    toggle.textContent = 'Iniciar';
    duration.hidden = !isTimer();
    lap.hidden = isTimer();
    if (isTimer()) remaining = (Number(minutes.value) * 60 + Number(seconds.value)) * 1000;
    paint();
  }

  minutes.addEventListener('input', () => !running() && reset());
  seconds.addEventListener('input', () => !running() && reset());
  root.append(
    h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', {}, 'Modo'), mode)),
    duration,
    display,
    h('div', { class: 'result-row' }, toggle, lap, h('button', { type: 'button', class: 'btn', onclick: reset }, 'Reiniciar')),
    lapList,
  );
  reset();
  const interval = setInterval(() => running() && paint(), 100);
  return () => clearInterval(interval);
}

/* QR scanner */

/** Reads a code from a canvas: the browser's detector where it exists (also reads barcodes), jsQR otherwise. */
async function decode(canvas) {
  if ('BarcodeDetector' in window) {
    try {
      const [code] = await new window.BarcodeDetector().detect(canvas);
      if (code) return code.rawValue;
    } catch {
      // Some platforms expose the class without a working backend; fall through to jsQR.
    }
  }
  const { default: jsQR } = await import('jsqr');
  const { data, width, height } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data, width, height)?.data || null;
}

/** Draws the source scaled down to a size that decodes fast. */
function frame(source, width, height) {
  const scale = Math.min(1, 1000 / Math.max(width, height));
  const canvas = makeCanvas(width * scale, height * scale);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function renderScanner(root) {
  let stream = null;
  let scanning = false;
  const video = h('video', { class: 'camera', playsInline: true, muted: true, hidden: true });
  const status = h('p', { class: 'status', role: 'status' });
  const result = h('div', { class: 'results' });
  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle('error', isError);
  };

  function show(text) {
    const isLink = /^https?:\/\/\S+$/i.test(text);
    const copy = h(
      'button',
      {
        type: 'button',
        class: 'btn',
        async onclick() {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Copiado';
        },
      },
      'Copiar',
    );
    result.replaceChildren(
      h(
        'div',
        { class: 'result' },
        h('textarea', { readOnly: true, rows: 3, value: text, 'aria-label': 'Contenido del código' }),
        h('div', { class: 'result-row' }, copy, isLink && h('a', { class: 'btn primary', href: text, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir enlace')),
      ),
    );
  }

  function stop() {
    scanning = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.hidden = true;
    camera.textContent = 'Usar la cámara';
  }

  async function scan() {
    while (scanning) {
      if (video.readyState >= 2) {
        const text = await decode(frame(video, video.videoWidth, video.videoHeight));
        if (text && scanning) {
          stop();
          setStatus('');
          return show(text);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function start() {
    result.replaceChildren();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (error) {
      return setStatus(error.name === 'NotAllowedError' ? 'Permiso de cámara denegado.' : 'No se pudo abrir la cámara.', true);
    }
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    camera.textContent = 'Detener cámara';
    setStatus('Apunta al código…');
    scanning = true;
    scan();
  }

  const camera = h('button', { type: 'button', class: 'btn primary', onclick: () => (stream ? stop() : start()) }, 'Usar la cámara');
  const zone = fileZone({ accept: 'image/*', preview: false }, async ([file]) => {
    result.replaceChildren();
    if (!file) return setStatus('');
    try {
      const img = await loadImage(file);
      const text = await decode(frame(img, img.naturalWidth, img.naturalHeight));
      if (!text) return setStatus('No se encontró ningún código en la imagen.', true);
      setStatus('');
      show(text);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  root.append(navigator.mediaDevices?.getUserMedia ? camera : '', video, h('p', { class: 'muted' }, 'O elige una foto del código:'), zone.el, status, result);
  return () => {
    stop();
    zone.destroy();
  };
}

export default [
  { id: 'texto-comparar', name: 'Comparar textos', desc: 'Muestra las líneas añadidas y quitadas entre dos textos.', cat: 'texto', render: renderDiff },
  {
    id: 'texto-markdown',
    name: 'Markdown a HTML o PDF',
    desc: 'Convierte Markdown en una página lista para descargar o imprimir.',
    cat: 'texto',
    action: 'Convertir',
    text: { placeholder: '# Título\n\nEscribe aquí en **Markdown**…' },
    run: markdown,
  },
  {
    id: 'texto-csv',
    name: 'CSV ↔ JSON',
    desc: 'Convierte tablas CSV en JSON y al revés.',
    cat: 'texto',
    live: true,
    text: { placeholder: 'nombre,edad\nAna,30' },
    fields: [
      {
        key: 'direction',
        label: 'Conversión',
        type: 'select',
        value: 'csv',
        options: [
          ['csv', 'CSV a JSON'],
          ['json', 'JSON a CSV'],
        ],
      },
    ],
    run: csvJson,
  },
  { id: 'texto-css', name: 'Minificar CSS', desc: 'Quita comentarios y espacios de una hoja de estilos.', cat: 'texto', live: true, text: { placeholder: 'a {\n  color: red;\n}' }, run: minifyCss },
  {
    id: 'texto-regex',
    name: 'Probar expresión regular',
    desc: 'Comprueba qué partes de un texto coinciden.',
    cat: 'texto',
    live: true,
    text: true,
    fields: [
      { key: 'pattern', label: 'Expresión', placeholder: '\\d+', value: '' },
      { key: 'flags', label: 'Modificadores', value: 'i', hint: 'i: sin distinguir mayúsculas, m: multilínea, s: el punto incluye saltos.' },
    ],
    run: regex,
  },
  { id: 'unidades', name: 'Conversor de unidades', desc: 'Longitud, peso, temperatura, volumen, datos y más.', cat: 'utilidades', render: renderUnits },
  {
    id: 'porcentajes',
    name: 'Calculadora de porcentajes',
    desc: 'Porcentaje de una cantidad, aumentos, descuentos y cambios.',
    cat: 'utilidades',
    live: true,
    fields: [
      { key: 'a', label: 'A', type: 'number', step: 'any', value: 15 },
      { key: 'b', label: 'B', type: 'number', step: 'any', value: 200 },
    ],
    run: percentages,
  },
  { id: 'cronometro', name: 'Cronómetro y temporizador', desc: 'Mide tiempos con vueltas o haz una cuenta atrás con aviso.', cat: 'utilidades', render: renderClock },
  { id: 'qr-escanear', name: 'Escanear QR', desc: 'Lee códigos QR con la cámara o desde una foto.', cat: 'utilidades', render: renderScanner },
];
