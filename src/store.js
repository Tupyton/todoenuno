/** Small lists kept in localStorage. Storage can be unavailable (private mode), so every access is guarded. */
function read(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: the list just does not persist.
  }
}

const MAX_RECENTS = 6;

export const favorites = () => read('favorites');
export const recents = () => read('recents');
export const addRecent = (id) => write('recents', [id, ...read('recents').filter((x) => x !== id)].slice(0, MAX_RECENTS));

/** Returns whether the tool is a favorite after the change. */
export function toggleFavorite(id) {
  const list = read('favorites');
  const on = !list.includes(id);
  write('favorites', on ? [...list, id] : list.filter((x) => x !== id));
  return on;
}

/** The saved theme ('light' | 'dark'), or null to follow the system. */
export function savedTheme() {
  try {
    return localStorage.getItem('theme');
  } catch {
    return null;
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Applies to this visit only.
  }
}
