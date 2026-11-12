import { h, formatBytes, clamp, base } from './ui.js';

function mediaEl(type, url) {
  if (type.startsWith('image/')) return h('img', { src: url, alt: 'Vista previa' });
  if (type.startsWith('video/')) return h('video', { src: url, controls: true });
  if (type.startsWith('audio/')) return h('audio', { src: url, controls: true });
  return null;
}

/** File picker with drag and drop. `spec`: { accept, multiple, preview }. */
export function fileZone(spec, onChange) {
  let files = [];
  let previewUrl = null;
  const input = h('input', {
    type: 'file',
    accept: spec.accept,
    multiple: !!spec.multiple,
    hidden: true,
    onchange() {
      add(input.files);
      input.value = '';
    },
  });
  const list = h('ul', { class: 'files' });
  const preview = h('div', { class: 'preview' });
  const zone = h(
    'button',
    {
      type: 'button',
      class: 'drop',
      onclick: () => input.click(),
      ondragover(e) {
        e.preventDefault();
        zone.classList.add('over');
      },
      ondragleave: () => zone.classList.remove('over'),
      ondrop(e) {
        e.preventDefault();
        zone.classList.remove('over');
        add(e.dataTransfer.files);
      },
    },
    spec.multiple ? 'Arrastra archivos aquí o haz clic para elegirlos' : 'Arrastra un archivo aquí o haz clic para elegirlo',
  );

  const iconBtn = (label, title, onclick) => h('button', { type: 'button', class: 'icon', title, 'aria-label': title, onclick }, label);

  function add(fileList) {
    files = spec.multiple ? [...files, ...fileList] : [...fileList].slice(0, 1);
    draw();
  }

  function move(i, delta) {
    [files[i], files[i + delta]] = [files[i + delta], files[i]];
    draw();
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    preview.replaceChildren();
  }

  function draw() {
    list.replaceChildren(
      ...files.map((f, i) =>
        h(
          'li',
          {},
          h('span', { class: 'fname' }, f.name),
          h('span', { class: 'muted' }, formatBytes(f.size)),
          spec.multiple && i > 0 && iconBtn('↑', 'Subir', () => move(i, -1)),
          spec.multiple && i < files.length - 1 && iconBtn('↓', 'Bajar', () => move(i, 1)),
          iconBtn('✕', 'Quitar', () => {
            files.splice(i, 1);
            draw();
          }),
        ),
      ),
    );
    clearPreview();
    if (spec.preview !== false && files.length === 1) {
      previewUrl = URL.createObjectURL(files[0]);
      const el = mediaEl(files[0].type, previewUrl);
      if (el) preview.append(el);
      else clearPreview();
    }
    onChange?.(files);
  }

  return {
    el: h('div', {}, zone, input, list, preview),
    get files() {
      return files;
    },
    destroy: clearPreview,
  };
}

function textResult(text) {
  const area = h('textarea', {
    class: 'text-out',
    readOnly: true,
    value: text,
    rows: clamp(text.split('\n').length + 1, 3, 20),
    'aria-label': 'Resultado',
  });
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      async onclick() {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copiado';
        setTimeout(() => (copy.textContent = 'Copiar'), 1500);
      },
    },
    'Copiar',
  );
  return h('div', { class: 'result' }, area, h('div', { class: 'result-row' }, copy));
}

async function downloadZip(items) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const seen = new Map();
  for (const { blob, name } of items) {
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    zip.file(n ? name.replace(/(\.[^.]*)?$/, `-${n}$1`) : name, blob);
  }
  const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  h('a', { href: url, download: 'todoenuno.zip' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Button for the system share sheet (phones mostly), or null where files cannot be shared. */
function shareButton({ blob, name }) {
  const file = new File([blob], name, { type: blob.type });
  if (!navigator.canShare?.({ files: [file] })) return null;
  // Closing the share sheet rejects the promise; that is not an error.
  return h('button', { type: 'button', class: 'btn', onclick: () => navigator.share({ files: [file] }).catch(() => {}) }, 'Compartir');
}

const MAX_PREVIEWS = 12;

/** Shows a tool result: strings, DOM nodes, or `{ blob, name }` files (one or an array). */
export function resultView() {
  const el = h('div', { class: 'results' });
  let urls = [];

  function clear() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    el.replaceChildren();
  }

  function show(result) {
    clear();
    if (result === null || result === undefined) return;
    const items = [result].flat();
    const blobs = items.filter((i) => i?.blob);
    if (blobs.length > 1) {
      el.append(h('button', { type: 'button', class: 'btn', onclick: () => downloadZip(blobs) }, `Descargar todo (${blobs.length}) en ZIP`));
    }
    for (const item of items) {
      if (typeof item === 'string') el.append(textResult(item));
      else if (item instanceof Node) el.append(item);
      else {
        const url = URL.createObjectURL(item.blob);
        urls.push(url);
        el.append(
          h(
            'div',
            { class: 'result' },
            blobs.length <= MAX_PREVIEWS && mediaEl(item.blob.type, url),
            h(
              'div',
              { class: 'result-row' },
              h('span', { class: 'fname' }, item.name),
              h('span', { class: 'muted' }, formatBytes(item.blob.size)),
              shareButton(item),
              h('a', { class: 'btn primary', href: url, download: item.name }, 'Descargar'),
            ),
          ),
        );
      }
    }
  }

  return { el, show, clear };
}

export function fieldEl(field, values, onInput) {
  const { key, label, type = 'text', value, options, hint, ...attrs } = field;
  const numeric = type === 'number' || type === 'range';
  const read = (input) => (type === 'checkbox' ? input.checked : numeric ? Number(input.value) : input.value);

  let input;
  if (type === 'select') {
    input = h(
      'select',
      {},
      options.map((o) => {
        const [val, text] = Array.isArray(o) ? o : [o, o];
        return h('option', { value: val, selected: val === value }, text);
      }),
    );
  } else if (type === 'textarea') input = h('textarea', { rows: 3, value: value ?? '', ...attrs });
  else if (type === 'checkbox') input = h('input', { type, checked: !!value });
  // min/max go before value: a range input clamps its value to the limits already set.
  else input = h('input', { type, ...attrs, value: value ?? '' });

  values[key] = read(input);
  const shown = type === 'range' && h('output', {}, String(values[key]));
  input.addEventListener('input', () => {
    values[key] = read(input);
    if (shown) shown.textContent = String(values[key]);
    onInput();
  });
  return h(
    'label',
    { class: type === 'checkbox' ? 'field check' : 'field' },
    h('span', {}, label, shown && ' ', shown),
    input,
    hint && h('small', {}, hint),
  );
}

/** Whether `file` is one of the types an `accept` list ("image/*,.pdf") names. */
function accepts(file, accept) {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept.split(',').some((rule) => {
    const r = rule.trim().toLowerCase();
    if (r.startsWith('.')) return name.endsWith(r);
    if (r.endsWith('/*')) return file.type.startsWith(r.slice(0, -1));
    return file.type === r;
  });
}

/**
 * Runs a tool on the matching files of a folder the user picks and writes the results to a "TodoEnUno"
 * folder inside it: once per file, or once with all of them for tools that take several files.
 * Chromium browsers and the desktop app only (File System Access API).
 */
async function processFolder(tool, values, setStatus) {
  let folder;
  try {
    folder = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return; // Closing the picker is not an error.
  }
  const files = [];
  for await (const handle of folder.values()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    if (accepts(file, tool.files.accept)) files.push(file);
  }
  if (!files.length) return setStatus('La carpeta no tiene archivos que esta herramienta pueda usar.', true);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const target = await folder.getDirectoryHandle('TodoEnUno', { create: true });
  const used = new Set();
  const save = async (blob, name) => {
    let unique = name;
    for (let n = 1; used.has(unique); n++) unique = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
    used.add(unique);
    const writable = await (await target.getFileHandle(unique, { create: true })).createWritable();
    await writable.write(blob);
    await writable.close();
  };
  let saved = 0;
  const keep = async (result, from) => {
    for (const item of [result].flat()) {
      if (item?.blob) await save(item.blob, item.name);
      else if (typeof item === 'string') await save(new Blob([item], { type: 'text/plain' }), `${base(from)}.txt`);
      else continue;
      saved++;
    }
  };
  const run = (batch) => tool.run({ files: batch, file: batch[0], text: '', v: { ...values }, progress: () => {} });
  const failed = [];
  if (tool.files.multiple) {
    setStatus(`Procesando ${files.length} archivos…`);
    await keep(await run(files), folder.name);
  } else {
    for (const [i, file] of files.entries()) {
      setStatus(`Procesando ${i + 1} de ${files.length}: ${file.name}`);
      try {
        await keep(await run([file]), file.name);
      } catch (error) {
        failed.push(`${file.name}: ${error.message || error}`);
      }
    }
  }
  const done = `Listo: ${saved} ${saved === 1 ? 'archivo guardado' : 'archivos guardados'} en la carpeta «TodoEnUno».`;
  setStatus(failed.length ? `${done}\nNo se pudieron procesar:\n${failed.join('\n')}` : done, failed.length > 0);
}

/**
 * Renders a declarative tool:
 * { files?: {accept, multiple, optional}, text?: true|{placeholder}, fields?, live?, action?, note?, run(ctx) }
 * or a custom one with `render(root)`. Returns a cleanup function.
 */
export function renderTool(tool, root) {
  if (tool.render) return tool.render(root);

  const values = {};
  const out = resultView();
  const status = h('p', { class: 'status', role: 'status' });
  const bar = h('progress', { hidden: true, max: 1 });
  let token = 0;

  const setStatus = (message, isError) => {
    status.textContent = message || '';
    status.classList.toggle('error', !!isError);
  };
  const onInput = () => {
    if (tool.live) run();
  };

  const zone = tool.files && fileZone(tool.files, onInput);
  const textIn =
    tool.text &&
    h('textarea', {
      class: 'text-in',
      rows: 8,
      placeholder: tool.text.placeholder || 'Escribe o pega el texto aquí…',
      'aria-label': 'Texto de entrada',
      oninput: onInput,
    });
  const fields = (tool.fields || []).map((f) => fieldEl(f, values, onInput));
  const button = !tool.live && h('button', { type: 'button', class: 'btn primary', onclick: run }, tool.action || 'Procesar');
  const folderButton =
    button &&
    zone &&
    'showDirectoryPicker' in window &&
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        title: 'Aplica la herramienta a todos los archivos de una carpeta',
        async onclick() {
          button.disabled = folderButton.disabled = true;
          out.clear();
          try {
            await processFolder(tool, values, setStatus);
          } catch (error) {
            setStatus(error.message || String(error), true);
          } finally {
            button.disabled = folderButton.disabled = false;
          }
        },
      },
      'Procesar una carpeta',
    );

  async function run() {
    const files = zone ? zone.files : [];
    const text = textIn ? textIn.value : '';
    const missing =
      zone && !tool.files.optional && !files.length
        ? 'Selecciona un archivo primero.'
        : textIn && !text.trim() && !files.length
          ? 'Escribe un texto primero.'
          : null;
    const mine = ++token;
    if (missing) {
      out.clear();
      setStatus(tool.live ? '' : missing, true);
      return;
    }
    if (button) {
      button.disabled = true;
      bar.removeAttribute('value');
      bar.hidden = false;
      setStatus('Procesando…');
    }
    try {
      const result = await tool.run({
        files,
        file: files[0],
        text,
        v: { ...values },
        progress: (p) => {
          if (Number.isFinite(p)) bar.value = clamp(p, 0, 1);
        },
      });
      if (mine !== token) return;
      out.show(result);
      setStatus('');
    } catch (error) {
      if (mine !== token) return;
      console.error(error);
      out.clear();
      setStatus(error.message || String(error), true);
    } finally {
      if (mine === token) {
        if (button) button.disabled = false;
        bar.hidden = true;
      }
    }
  }

  root.append(
    ...[
      zone?.el,
      textIn,
      fields.length > 0 && h('div', { class: 'fields' }, fields),
      tool.note && h('p', { class: 'note' }, tool.note),
      folderButton ? h('div', { class: 'result-row' }, button, folderButton) : button,
      bar,
      status,
      out.el,
    ].filter(Boolean),
  );
  if (tool.live && !zone && !textIn) run();

  return () => {
    token++;
    out.clear();
    zone?.destroy();
  };
}
