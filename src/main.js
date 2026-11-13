import './style.css';
import { ANDROID, ANDROID_DOWNLOAD, APP_VERSION, DESKTOP, WINDOWS_DOWNLOAD, WINDOWS_PORTABLE } from './env.js';
import { categoryIcon, lockIcon, toolIcon, uiIcon } from './icons.js';
import { addRecent, favorites, recents, saveTheme, toggleFavorite } from './store.js';
import { tools, categories } from './tools/index.js';
import { renderTool } from './tool-page.js';
import { h } from './ui.js';

const app = document.getElementById('app');
let cleanup = null;

const normalize = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const tile = (icon) => h('span', { class: 'tile' }, icon);
const categoryName = Object.fromEntries(categories.map((c) => [c.id, c.name]));

function card(tool) {
  const blocked = tool.blocked?.();
  return {
    haystack: normalize(`${tool.name} ${tool.desc} ${categoryName[tool.cat]}`),
    el: h(
      'a',
      { class: blocked ? 'card blocked' : 'card', href: `#/${tool.id}`, 'data-cat': tool.cat },
      tile(blocked ? lockIcon() : toolIcon(tool)),
      h('span', { class: 'card-text' }, h('strong', {}, tool.name), h('span', {}, blocked ? (tool.desktopOnly ? (tool.alsoAndroid ? 'Solo en las apps para Windows y Android.' : 'Solo en la versión para Windows.') : 'No disponible en este dispositivo.') : tool.desc)),
    ),
  };
}

function section({ id, name, icon, list, cat }) {
  const cards = list.map(card);
  return {
    cards,
    el: h(
      'section',
      { id, 'data-cat': cat },
      h('h2', {}, tile(icon), name, h('span', { class: 'count' }, String(cards.length))),
      h('div', { class: 'grid' }, cards.map((c) => c.el)),
    ),
  };
}

const byIds = (ids) => ids.map((id) => tools.find((t) => t.id === id)).filter(Boolean);

function home() {
  document.title = 'TodoEnUno · Herramientas en tu navegador';
  const sections = [
    { id: 'favoritas', name: 'Favoritas', icon: uiIcon('star'), list: byIds(favorites()) },
    { id: 'recientes', name: 'Usadas recientemente', icon: uiIcon('history'), list: byIds(recents()) },
    ...categories.map((category) => ({
      id: `cat-${category.id}`,
      name: category.name,
      icon: categoryIcon(category.id),
      list: tools.filter((t) => t.cat === category.id),
      cat: category.id,
    })),
  ]
    .filter((s) => s.list.length)
    .map(section);
  const empty = h('p', { class: 'muted', hidden: true }, 'Ninguna herramienta coincide con la búsqueda.');
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: `Buscar entre ${tools.length} herramientas…`,
    'aria-label': 'Buscar herramienta',
    oninput() {
      const query = normalize(search.value.trim());
      let total = 0;
      for (const s of sections) {
        let visible = 0;
        for (const c of s.cards) {
          const match = c.haystack.includes(query);
          c.el.hidden = !match;
          if (match) visible++;
        }
        s.el.hidden = visible === 0;
        total += visible;
      }
      empty.hidden = total > 0;
    },
  });
  const chips = h(
    'nav',
    { class: 'chips', 'aria-label': 'Categorías' },
    categories.map((category) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'data-cat': category.id,
          // Not a link: the URL hash belongs to the router.
          onclick: () => document.getElementById(`cat-${category.id}`).scrollIntoView(),
        },
        categoryIcon(category.id),
        category.name,
      ),
    ),
  );
  app.append(
    h(
      'div',
      { class: 'hero' },
      h('h1', {}, 'Todas tus herramientas, ', h('em', {}, 'en un solo lugar')),
      h('p', {}, 'Imágenes, PDF, video, audio y texto. Gratis y privado: los archivos no salen de tu equipo.'),
      search,
      chips,
      !DESKTOP && !ANDROID && WINDOWS_DOWNLOAD && windowsDownload(),
    ),
    ...sections.map((s) => s.el),
    empty,
  );
}

const windowsDownload = () =>
  h(
    'p',
    { class: 'get-app' },
    h('a', { class: 'btn primary', href: WINDOWS_DOWNLOAD }, 'Descargar para Windows'),
    ANDROID_DOWNLOAD && h('a', { class: 'btn primary', href: ANDROID_DOWNLOAD }, 'Descargar para Android'),
    WINDOWS_PORTABLE && h('a', { class: 'portable', href: WINDOWS_PORTABLE }, 'o Windows portable, sin instalar'),
  );

function favoriteButton(tool) {
  const button = h('button', {
    type: 'button',
    class: 'fav',
    'aria-label': 'Favorita',
    title: 'Marcar como favorita',
    'aria-pressed': String(favorites().includes(tool.id)),
    onclick: () => button.setAttribute('aria-pressed', String(toggleFavorite(tool.id))),
  });
  button.append(uiIcon('star'));
  return button;
}

function route() {
  cleanup?.();
  cleanup = null;
  app.replaceChildren();
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const tool = tools.find((t) => t.id === id);
  if (!tool) return home();

  document.title = `${tool.name} · TodoEnUno`;
  const body = h('div', { class: 'tool' });
  app.append(
    h(
      'article',
      { class: 'tool-page', 'data-cat': tool.cat },
      h('a', { class: 'back', href: '#/' }, '← Todas las herramientas'),
      h(
        'header',
        { class: 'tool-head' },
        tile(toolIcon(tool)),
        h('div', { class: 'tool-title' }, h('h1', {}, tool.name), h('p', { class: 'desc' }, tool.desc)),
        favoriteButton(tool),
      ),
      h('div', { class: 'panel' }, body),
    ),
  );
  const blocked = tool.blocked?.();
  if (blocked) {
    body.append(h('p', { class: 'status error' }, blocked));
    if (tool.desktopOnly && !ANDROID && WINDOWS_DOWNLOAD) body.append(windowsDownload());
  }
  else {
    addRecent(tool.id);
    cleanup = renderTool(tool, body) || null;
  }
  window.scrollTo(0, 0);
}

function themeToggle() {
  const button = document.getElementById('theme');
  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  const paint = () => button.replaceChildren(uiIcon(isDark() ? 'sun' : 'moon'));
  button.addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    saveTheme(root.dataset.theme);
    paint();
  });
  paint();
}

/** True when version `a` ("1.2.3", with or without a leading "v") is newer than `b`. */
function isNewer(a, b) {
  const parts = (v) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/**
 * Android app: a bar at the top when a newer version is published on GitHub (the Windows app does
 * the same with a dialog, see electron/main.js). Offline or with GitHub unavailable it says nothing.
 */
async function checkForUpdate() {
  try {
    const response = await fetch('https://api.github.com/repos/Tupyton/todoenuno/releases/latest');
    if (!response.ok) return;
    const { tag_name: latest } = await response.json();
    if (!latest || !isNewer(latest, APP_VERSION)) return;
    const bar = h(
      'div',
      { class: 'update-bar', role: 'status' },
      h('span', {}, `Hay una nueva versión (${latest.replace(/^v/, '')}).`),
      h('a', { class: 'btn primary', href: ANDROID_DOWNLOAD, target: '_blank', rel: 'noopener' }, 'Descargar'),
      h('button', { type: 'button', class: 'icon', title: 'Cerrar', 'aria-label': 'Cerrar', onclick: () => bar.remove() }, '✕'),
    );
    document.body.prepend(bar);
  } catch {
    // Try again on the next start.
  }
}

themeToggle();
window.addEventListener('hashchange', route);
route();
if (ANDROID) checkForUpdate();

// Installable and usable offline. Only in the built site: a worker would cache stale modules during development.
// Not in the desktop app, where the files are already on the computer.
if (import.meta.env.PROD && !DESKTOP && !ANDROID && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
