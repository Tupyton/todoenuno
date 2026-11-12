# TodoEnUno

Más de 90 herramientas de imagen, PDF, documentos, video, audio y texto en una sola app. Todo se procesa en el dispositivo: los archivos no se suben a ningún servidor.

- Sitio: https://todoenunoapp.netlify.app
- Versión para Windows:
  - [TodoEnUno-Instalador.exe](https://github.com/Tupyton/todoenuno/releases/latest/download/TodoEnUno-Instalador.exe): se instala con accesos directos y se desinstala desde Windows.
  - [TodoEnUno-Portable.exe](https://github.com/Tupyton/todoenuno/releases/latest/download/TodoEnUno-Portable.exe): se abre sin instalar.

La versión para Windows incluye además el descargador de video y audio, que un navegador no puede ofrecer por sí solo, y avisa al abrirse cuando hay una versión nueva.

## Desarrollo

Requiere Node.js 20 o superior.

```bash
npm install
npm run dev
```

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compila el sitio en `dist/` |
| `npm run downloader` | Servidor local de descargas para usar con el sitio en `localhost` (necesita `yt-dlp` y `ffmpeg`) |
| `npm run desktop` | Abre la app de escritorio desde el código |
| `npm run desktop:win` | Compila el instalador y el `.exe` portable para Windows en `release/` |

## Estructura

- `src/` — la app web: cada herramienta se declara en `src/tools/`.
- `electron/` — proceso principal de la app de escritorio.
- `server/` — descargas con `yt-dlp`.
- `scripts/` — preparación de FFmpeg, libarchive y de los programas que acompañan al `.exe`.

## Tecnologías

JavaScript, Vite, FFmpeg (WebAssembly), pdf-lib, pdf.js, qpdf, SheetJS, libarchive, Electron.

## Autor

Javier Stiven Martínez Cáceres — https://javiermportfolio.netlify.app
