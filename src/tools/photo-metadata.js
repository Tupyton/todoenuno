import { isRaw, PHOTO_ACCEPT, readTags, writeTags } from '../lib/exiftool.js';
import { fieldEl, fileZone, resultView } from '../tool-page.js';
import { base, ext, h } from '../ui.js';

const ENGINE_NOTE = 'La primera vez descarga el motor de metadatos (unos 5 MB); después funciona sin conexión.';

/** [name, value] of the first tag named one of `names` ("Tag" in any group, or "Group:Tag"), in that order. */
function entry(tags, ...names) {
  for (const name of names) {
    const key = name.includes(':') ? name : Object.keys(tags).find((k) => k.slice(k.indexOf(':') + 1) === name);
    if (key && tags[key] !== undefined && tags[key] !== '') return [key.slice(key.indexOf(':') + 1), tags[key]];
  }
  return [];
}

const pick = (tags, ...names) => entry(tags, ...names)[1];

const SHUTTER = ['ShutterCount', 'MechanicalShutterCount', 'ShutterCount2', 'ShutterCount3', 'ImageCount'];

function summary(tags, raw) {
  const exposure = [pick(tags, 'ExposureTime') && `${pick(tags, 'ExposureTime')} s`, pick(tags, 'FNumber') && `f/${pick(tags, 'FNumber')}`, pick(tags, 'ISO') && `ISO ${pick(tags, 'ISO')}`, pick(tags, 'FocalLength')]
    .filter(Boolean)
    .join(' · ');
  const make = pick(tags, 'Make');
  const model = pick(tags, 'Model');
  // Canon writes the make into the model too ("Canon EOS R100").
  const camera = make && model && String(model).startsWith(make) ? model : [make, model].filter(Boolean).join(' ');
  // The tag name goes along: makers count differently (ImageCount is not always the shutter's).
  const [shutterTag, shutter] = entry(tags, ...SHUTTER);
  // The Composite coordinates carry the sign; the GPS ones keep it apart, in the Ref tags.
  const lat = pick(tags, 'Composite:GPSLatitude');
  const lon = pick(tags, 'Composite:GPSLongitude');
  const rows = [
    ['Cámara', camera],
    ['Contador de disparos', shutter !== undefined ? `${shutter} (${shutterTag})` : (camera && (raw ? 'Esta cámara no lo guarda en sus archivos.' : 'No aparece. Pruébalo con el archivo RAW o el JPG original de la cámara.'))],
    ['Número de serie', pick(tags, 'SerialNumber', 'BodySerialNumber', 'InternalSerialNumber')],
    ['Objetivo', pick(tags, 'LensModel', 'LensID', 'LensType', 'Lens')],
    ['Fecha de captura', pick(tags, 'DateTimeOriginal', 'CreateDate')],
    ['Exposición', exposure],
    ['Tamaño', pick(tags, 'ImageSize')],
    ['Ubicación', lat !== undefined && lon !== undefined && `${Number.parseFloat(lat)}, ${Number.parseFloat(lon)}`],
    ['Autor', pick(tags, 'Artist', 'Creator', 'By-line')],
    ['Copyright', pick(tags, 'Copyright', 'Rights', 'CopyrightNotice')],
    ['Programa', pick(tags, 'Software', 'CreatorTool')],
  ].filter(([, value]) => value);
  return h('div', { class: 'sheet' }, h('table', {}, rows.map(([label, value]) => h('tr', {}, h('th', {}, label), h('td', {}, String(value))))));
}

/** Every tag, grouped like ExifTool does (IFD0, ExifIFD, the maker's notes…), with a search box. */
function allTags(tags) {
  const groups = new Map();
  for (const [key, value] of Object.entries(tags)) {
    const at = key.indexOf(':');
    const group = at > 0 ? key.slice(0, at) : 'Otros';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([key.slice(at + 1), Array.isArray(value) ? value.join(', ') : String(value)]);
  }
  const sections = [...groups].map(([group, rows]) => {
    const trs = rows.map(([name, value]) => h('tr', { 'data-text': `${name} ${value}`.toLowerCase() }, h('th', {}, name), h('td', {}, value)));
    return { el: h('details', {}, h('summary', {}, `${group} (${rows.length})`), h('div', { class: 'sheet' }, h('table', {}, trs))), trs };
  });
  const search = h('input', {
    type: 'search',
    placeholder: 'Buscar una etiqueta o un valor…',
    'aria-label': 'Buscar en los metadatos',
    oninput() {
      const query = search.value.trim().toLowerCase();
      for (const { el, trs } of sections) {
        let shown = 0;
        for (const tr of trs) {
          tr.hidden = !!query && !tr.dataset.text.includes(query);
          if (!tr.hidden) shown++;
        }
        el.hidden = shown === 0;
        el.open = !!query && shown > 0;
      }
    },
  });
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      async onclick() {
        await navigator.clipboard.writeText(Object.entries(tags).map(([k, v]) => `${k}: ${v}`).join('\n'));
        copy.textContent = 'Copiado';
        setTimeout(() => (copy.textContent = 'Copiar todo'), 1500);
      },
    },
    'Copiar todo',
  );
  return h('div', { class: 'meta-all' }, h('div', { class: 'result-row' }, search, copy), sections.map((s) => s.el));
}

async function info({ file }) {
  const tags = await readTags(file);
  return h('div', { class: 'meta-view' }, summary(tags, isRaw(file)), h('h3', {}, `Todas las etiquetas (${Object.keys(tags).length})`), allTags(tags));
}

// Location, serial numbers and owner: what a RAW can lose without breaking.
const PRIVATE = [
  '-gps:all=', '-xmp:all=', '-iptc:all=', '-SerialNumber=', '-InternalSerialNumber=', '-LensSerialNumber=',
  '-OwnerName=', '-Artist=', '-Copyright=',
];
// Everything, except what changes how the photo looks: its rotation and colour profile.
const ALL = ['-all=', '--ICC_Profile:all', '-tagsfromfile', '@', '-Orientation'];

// Formats with no metadata to remove, which ExifTool cannot write: they come back as they are.
const NO_METADATA = ['bmp', 'ico'];

async function strip({ files, v, progress }) {
  const results = [];
  const kept = [];
  for (const [i, file] of files.entries()) {
    if (NO_METADATA.includes(ext(file.name))) {
      results.push({ blob: file, name: `${base(file.name)}-limpia.${ext(file.name)}` });
      progress((i + 1) / files.length);
      continue;
    }
    const raw = isRaw(file);
    const result = await writeTags(file, {}, v.mode === 'all' && !raw ? ALL : PRIVATE, 'limpia');
    results.push(result);
    // Some makers keep a serial number in their own notes, which ExifTool reads but cannot change
    // (Sony's InternalSerialNumber is enciphered): those are listed in the result.
    if (raw) {
      const tags = await readTags(new File([result.blob], file.name));
      const left = Object.entries(tags).filter(([key, value]) => /SerialNumber$/.test(key) && value !== '');
      if (left.length) kept.push(`${file.name}: ${left.map(([key, value]) => `${key.slice(key.indexOf(':') + 1)} ${value}`).join(', ')}`);
    }
    progress((i + 1) / files.length);
  }
  if (kept.length) {
    results.push(`Estos datos del fabricante no se pueden borrar sin dañar el RAW y siguen en el archivo:\n${kept.join('\n')}`);
  }
  return results;
}

/** The editable fields: what they show from the photo and what they write back. */
const EDITABLE = [
  { key: 'Title', label: 'Título', read: ['Title', 'XPTitle', 'ObjectName'] },
  { key: 'ImageDescription', label: 'Descripción', type: 'textarea', read: ['ImageDescription', 'Description', 'Caption-Abstract'] },
  { key: 'Artist', label: 'Autor', read: ['Artist', 'Creator', 'By-line'] },
  { key: 'Copyright', label: 'Copyright', read: ['Copyright', 'Rights', 'CopyrightNotice'] },
  { key: 'Subject', label: 'Palabras clave', hint: 'Separadas por comas.', read: ['Subject', 'Keywords', 'XPKeywords'] },
  { key: 'AllDates', label: 'Fecha de captura', type: 'datetime-local', step: 1, read: ['DateTimeOriginal', 'CreateDate'] },
  { key: 'Make', label: 'Marca de la cámara', read: ['Make'] },
  { key: 'Model', label: 'Modelo de la cámara', read: ['Model'] },
  { key: 'GPSLatitude', label: 'Latitud', inputmode: 'decimal', placeholder: '4.6097', hint: 'Grados decimales: negativa al sur.', read: ['Composite:GPSLatitude'] },
  { key: 'GPSLongitude', label: 'Longitud', inputmode: 'decimal', placeholder: '-74.0817', hint: 'Negativa al oeste.', read: ['Composite:GPSLongitude'] },
];

// ExifTool dates are "2024:05:01 13:45:00"; datetime-local wants "2024-05-01T13:45:00".
const toInput = (date) => {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d:\d\d:\d\d)/.exec(date);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : '';
};
const fromInput = (value) => {
  const [day, time = '00:00:00'] = value.split('T');
  return `${day.replaceAll('-', ':')} ${time.length === 5 ? `${time}:00` : time}`;
};

function shown(field, tags) {
  const value = pick(tags, ...field.read);
  if (value === undefined) return '';
  if (field.type === 'datetime-local') return toInput(String(value));
  if (field.key.startsWith('GPS')) return String(Number.parseFloat(value));
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** Lines "Etiqueta=valor" into tags; ExifTool names only, so nothing can pass as an option. */
function extraTags(text) {
  const tags = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`No se entiende la línea «${line}». Usa Etiqueta=valor, por ejemplo XPComment=Hola.`);
    tags[m[1]] = m[2];
  }
  return tags;
}

function renderEditor(root) {
  const out = resultView();
  const status = h('p', { class: 'status', role: 'status' });
  const form = h('div', { class: 'fields' });
  const save = h('button', { type: 'button', class: 'btn primary', hidden: true, onclick: run }, 'Guardar cambios');
  let file = null;
  let values = {};
  let initial = {};
  let token = 0;

  const setStatus = (message, isError) => {
    status.textContent = message || '';
    status.classList.toggle('error', !!isError);
  };

  const zone = fileZone({ accept: PHOTO_ACCEPT }, async ([picked]) => {
    const mine = ++token;
    file = picked || null;
    out.clear();
    form.replaceChildren();
    save.hidden = true;
    if (!file) return setStatus('');
    setStatus('Leyendo los metadatos…');
    try {
      const tags = await readTags(file);
      if (mine !== token) return;
      values = {};
      initial = {};
      const fields = EDITABLE.map(({ read, ...field }) => fieldEl({ ...field, value: shown({ read, ...field }, tags) }, values, () => {}));
      // Compared as run() reads them, after the browser has normalised the inputs (dates lose ":00").
      for (const { key } of EDITABLE) initial[key] = String(values[key] ?? '').trim();
      fields.push(
        fieldEl(
          {
            key: 'extra',
            label: 'Otras etiquetas',
            type: 'textarea',
            placeholder: 'XPComment=Vacaciones\nXMP-dc:Source=Mi archivo',
            hint: 'Una por línea, con el nombre de ExifTool. Deja el valor vacío para borrarla.',
          },
          values,
          () => {},
        ),
      );
      form.replaceChildren(...fields);
      save.hidden = false;
      setStatus('Cambia lo que quieras: un campo vacío borra ese dato.');
    } catch (error) {
      if (mine === token) setStatus(error.message || String(error), true);
    }
  });

  async function run() {
    const tags = {};
    const args = [];
    for (const { key, type } of EDITABLE) {
      const value = String(values[key] ?? '').trim();
      if (value === initial[key]) continue;
      if (key === 'Subject') tags[key] = value ? value.split(',').map((w) => w.trim()).filter(Boolean) : '';
      else if (type === 'datetime-local') tags[key] = value && fromInput(value);
      else tags[key] = value;
    }
    // Both coordinates go together. A signed number written to the Ref tags sets N/S and E/W.
    if ('GPSLatitude' in tags || 'GPSLongitude' in tags) {
      const lat = String(values.GPSLatitude).trim().replace(',', '.');
      const lon = String(values.GPSLongitude).trim().replace(',', '.');
      if (!lat && !lon) {
        delete tags.GPSLatitude;
        delete tags.GPSLongitude;
        args.push('-gps:all=');
      } else if (!lat || !lon || !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
        return setStatus('Escribe la latitud (entre -90 y 90) y la longitud (entre -180 y 180), o deja las dos vacías para quitar la ubicación.', true);
      } else Object.assign(tags, { GPSLatitude: lat, GPSLatitudeRef: lat, GPSLongitude: lon, GPSLongitudeRef: lon });
    }
    try {
      Object.assign(tags, extraTags(values.extra || ''));
    } catch (error) {
      return setStatus(error.message, true);
    }
    if (!Object.keys(tags).length && !args.length) return setStatus('No cambiaste nada.', true);
    save.disabled = true;
    setStatus('Guardando…');
    try {
      out.show(await writeTags(file, tags, args, 'editada'));
      setStatus('');
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      save.disabled = false;
    }
  }

  root.append(zone.el, h('p', { class: 'note' }, ENGINE_NOTE), status, form, save, out.el);
  return () => {
    token++;
    out.clear();
    zone.destroy();
  };
}

export default [
  {
    id: 'imagen-info',
    name: 'Información de una foto',
    desc: 'Cámara, objetivo, exposición, ubicación y contador de disparos, también de archivos RAW.',
    cat: 'imagen',
    files: { accept: PHOTO_ACCEPT },
    action: 'Ver información',
    folder: false,
    note: `El contador de disparos solo aparece si la cámara lo guarda en sus archivos. ${ENGINE_NOTE}`,
    run: info,
  },
  {
    id: 'imagen-metadatos-editar',
    name: 'Editar metadatos de una foto',
    desc: 'Cambia o añade título, autor, fecha, cámara, ubicación y otras etiquetas.',
    cat: 'imagen',
    render: renderEditor,
  },
  {
    id: 'imagen-metadatos',
    name: 'Quitar metadatos (EXIF)',
    desc: 'Elimina ubicación, cámara, número de serie y fecha de tus fotos, sin perder calidad.',
    cat: 'imagen',
    files: { accept: PHOTO_ACCEPT, multiple: true, preview: false },
    action: 'Limpiar',
    fields: [
      {
        key: 'mode',
        label: 'Qué quitar',
        type: 'select',
        value: 'all',
        options: [
          ['all', 'Todo (conserva la orientación y el perfil de color)'],
          ['private', 'Solo lo privado: ubicación, números de serie y autor'],
        ],
        hint: 'En los archivos RAW solo se quita lo privado: sin el resto no se podrían revelar. Algunas cámaras guardan además un número de serie cifrado que no se puede borrar; si queda, se avisa.',
      },
    ],
    note: `La imagen no se vuelve a codificar. ${ENGINE_NOTE}`,
    run: strip,
  },
];
