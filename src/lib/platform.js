// Saving and sharing result files. Browsers and the desktop app download them; the Android app, whose
// WebView cannot download blob: links, writes them to Documents/TodoEnUno with Capacitor's plugins.
// The plugins are only imported inside the Android branch, so the website does not carry them.
import { ANDROID } from '../env.js';

export const SAVED_FOLDER = 'Documents/TodoEnUno';

const CHUNK = 3 * 1024 * 1024; // bytes per write: a whole video as one base64 string would not fit in memory

function base64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Writes `blob` in pieces to `path` inside `directory`, and returns its file URI. */
async function writeAndroid(blob, path, directory) {
  const { Filesystem } = await import('@capacitor/filesystem');
  for (let at = 0; at < blob.size || at === 0; at += CHUNK) {
    const data = await base64(blob.slice(at, at + CHUNK));
    if (at === 0) await Filesystem.writeFile({ path, data, directory, recursive: true });
    else await Filesystem.appendFile({ path, data, directory });
  }
  return (await Filesystem.getUri({ path, directory })).uri;
}

/** A name that does not overwrite an earlier result: "foto.jpg", then "foto-1.jpg"… */
async function freeName(name, directory) {
  const { Filesystem } = await import('@capacitor/filesystem');
  for (let n = 0; ; n++) {
    const candidate = n ? name.replace(/(\.[^.]*)?$/, `-${n}$1`) : name;
    try {
      await Filesystem.stat({ path: `TodoEnUno/${candidate}`, directory });
    } catch {
      return candidate;
    }
  }
}

/**
 * Saves a result. Returns a message for the user on Android (where the file went), nothing elsewhere,
 * since the browser shows its own download.
 */
export async function saveFile(blob, name) {
  if (!ANDROID) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  }
  const { Directory } = await import('@capacitor/filesystem');
  const file = await freeName(name, Directory.Documents);
  await writeAndroid(blob, `TodoEnUno/${file}`, Directory.Documents);
  return `Guardado en ${SAVED_FOLDER}/${file}`;
}

/** Whether `shareFile` can work here. */
export function canShare(blob, name) {
  if (ANDROID) return true;
  return !!navigator.canShare?.({ files: [new File([blob], name, { type: blob.type })] });
}

/** Opens the system share sheet with the file. Closing the sheet is not an error. */
export async function shareFile(blob, name) {
  if (!ANDROID) {
    await navigator.share({ files: [new File([blob], name, { type: blob.type })] }).catch(() => {});
    return;
  }
  const [{ Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  // Shared copies go to the app's cache, which Android clears by itself.
  const uri = await writeAndroid(blob, `compartir/${name}`, Directory.Cache);
  await Share.share({ files: [uri] }).catch(() => {});
}
