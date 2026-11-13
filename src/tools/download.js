import { ANDROID, DESKTOP } from '../env.js';
import { h } from '../ui.js';

// A browser cannot fetch video sites by itself: yt-dlp does it on this computer. The desktop app
// answers on the page's own address; in a browser it is the local server in server/downloader.js.
const SERVER = DESKTOP ? `${location.origin}/api` : 'http://127.0.0.1:47821';
const OFFLINE = DESKTOP
  ? 'No se pudo conectar con el descargador de la app. Cierra TodoEnUno y vuelve a abrirlo.'
  : 'No se encuentra el servidor de descargas. Inícialo en tu equipo con: npm run downloader';

/**
 * Android app: yt-dlp runs on the phone (android/…/DownloaderPlugin.java) and saves the file to
 * Download/TodoEnUno itself, so the result is only a message saying where it went.
 */
async function downloadOnPhone(url, v, progress) {
  const { registerPlugin } = await import('@capacitor/core');
  const downloader = registerPlugin('Downloader');
  const listener = await downloader.addListener('progress', (event) => progress(event.progress));
  try {
    const { location: saved } = await downloader.download({ url: url.href, kind: v.kind, quality: v.quality });
    return h('p', { class: 'note' }, `Guardado en ${saved}`);
  } catch (error) {
    throw new Error(error.message || String(error));
  } finally {
    listener.remove();
  }
}

async function download({ v, progress }) {
  let url;
  try {
    url = new URL(v.url.trim());
  } catch {
    throw new Error('Pega una URL completa, por ejemplo https://…');
  }
  if (ANDROID) return downloadOnPhone(url, v, progress);
  let response;
  try {
    response = await fetch(`${SERVER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href, kind: v.kind, quality: v.quality }),
    });
  } catch {
    throw new Error(OFFLINE);
  }
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw new Error(error || `El servidor respondió ${response.status}.`);
  }
  const encoded = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''(.+)$/)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : `descarga.${v.kind === 'audio' ? 'mp3' : 'mp4'}`;
  const type = name.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
  return { blob: new Blob([await response.blob()], { type }), name };
}

export default [
  {
    id: 'descargar',
    name: 'Descargar video o audio',
    desc: DESKTOP || ANDROID ? 'Descarga un video o su audio desde una URL.' : 'Descarga desde una URL con yt-dlp en tu equipo.',
    cat: 'descargas',
    action: 'Descargar',
    // The published site cannot rely on a server on the visitor's machine, and a phone cannot run one.
    // Its lock card says where the tool does work instead of the generic text.
    desktopOnly: true,
    blocked: () =>
      !DESKTOP &&
      !ANDROID &&
      !['localhost', '127.0.0.1'].includes(location.hostname) &&
      'Solo en las versiones para Windows y Android de TodoEnUno. Descargar de sitios de video necesita un programa en el equipo (yt-dlp); un navegador no puede hacerlo solo.',
    note: ANDROID
      ? 'Se guarda en Descargas/TodoEnUno. La primera descarga tarda un poco más mientras se prepara yt-dlp. Descarga solo contenido que tengas derecho a guardar.'
      : DESKTOP
      ? 'Descarga solo contenido que tengas derecho a guardar.'
      : 'Requiere el servidor local (npm run downloader) con yt-dlp y ffmpeg instalados. Descarga solo contenido que tengas derecho a guardar.',
    fields: [
      { key: 'url', label: 'URL del video', type: 'url', placeholder: 'https://…' },
      {
        key: 'kind',
        label: 'Tipo',
        type: 'select',
        value: 'video',
        options: [
          ['video', 'Video (MP4)'],
          ['audio', 'Solo audio (MP3)'],
        ],
      },
      {
        key: 'quality',
        label: 'Calidad máxima de video',
        type: 'select',
        value: '1080',
        options: [
          ['', 'La mejor disponible'],
          ['1080', '1080p'],
          ['720', '720p'],
          ['480', '480p'],
          ['360', '360p'],
        ],
      },
    ],
    run: download,
  },
];
