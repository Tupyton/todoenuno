# TodoEnUno

Más de 90 herramientas de imagen, PDF, documentos, video, audio y texto en una sola app. Todo se procesa en el dispositivo: los archivos no se suben a ningún servidor.

- Sitio: https://todoenunoapp.netlify.app
- Versión para Windows:
  - [TodoEnUno-Instalador.msi](https://github.com/Tupyton/todoenuno/releases/latest/download/TodoEnUno-Instalador.msi): instalador de Windows (MSI), con accesos directos y desinstalación desde Windows.
  - [TodoEnUno-Portable.exe](https://github.com/Tupyton/todoenuno/releases/latest/download/TodoEnUno-Portable.exe): se abre sin instalar.

La versión para Windows añade lo que un navegador no puede hacer por sí solo:

- Descargador de video y audio (yt-dlp).
- FFmpeg nativo en todas las herramientas de video y audio, con la tarjeta gráfica cuando la hay y sin límite de tamaño.
- Grabar una pantalla o ventana concreta, con el sonido del equipo.
- Transcribir audio o video a texto o subtítulos (whisper.cpp), aumentar la resolución de imágenes (Real-ESRGAN), quitar el fondo (ONNX Runtime) y comprimir PDF conservando el texto (Ghostscript). Estos programas y modelos no vienen en el instalador: la app descarga cada uno la primera vez que se usa, desde el release `componentes`, y comprueba su SHA-256.
- Aviso al abrirse cuando hay una versión nueva.

En los navegadores basados en Chromium y en la app, las herramientas pueden procesar todos los archivos de una carpeta.

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
| `npm run desktop:win` | Compila el instalador MSI y el `.exe` portable para Windows en `release/` |

## Estructura

- `src/` — la app web: cada herramienta se declara en `src/tools/`.
- `electron/` — proceso principal de la app de escritorio.
- `server/` — descargas con `yt-dlp`.
- `scripts/` — preparación de FFmpeg, libarchive y de los programas que acompañan al `.exe`.

## Tecnologías

JavaScript, Vite, FFmpeg (WebAssembly y nativo), pdf-lib, pdf.js, qpdf, SheetJS, libarchive, Electron, whisper.cpp, Real-ESRGAN, ONNX Runtime, Ghostscript.

## Autor

Javier Stiven Martínez Cáceres — https://javiermportfolio.netlify.app
