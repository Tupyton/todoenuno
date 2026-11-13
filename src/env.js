/** True inside the desktop app (electron/main.js), which also serves the download API on the page's own address. */
export const DESKTOP = /\bElectron\//.test(navigator.userAgent);

/** True inside the Android app (Capacitor), which serves the site from the phone itself. */
export const ANDROID = !!window.Capacitor?.isNativePlatform?.();

/** Where the Windows version is downloaded from. Leave empty to hide the download links on the site. */
export const WINDOWS_DOWNLOAD = 'https://github.com/Tupyton/todoenuno/releases/latest/download/TodoEnUno-Instalador.msi';
/** The same version as a single .exe that runs without installing. */
export const WINDOWS_PORTABLE = 'https://github.com/Tupyton/todoenuno/releases/latest/download/TodoEnUno-Portable.exe';
