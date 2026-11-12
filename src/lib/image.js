import { base } from '../ui.js';

export const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`No se pudo leer la imagen: ${file.name}`));
    };
    img.src = url;
  });
}

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** Draws the image scaled to the given size, optionally through a CSS filter string. */
export function drawn(img, width = img.naturalWidth, height = img.naturalHeight, filter) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (filter) {
    if (!('filter' in ctx)) throw new Error('Este navegador no soporta filtros de canvas.');
    ctx.filter = filter;
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Encodes a canvas. JPEG has no transparency, so it gets a white background. */
export function encode(canvas, type = 'image/png', quality) {
  let source = canvas;
  if (type === 'image/jpeg') {
    source = makeCanvas(canvas.width, canvas.height);
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(canvas, 0, 0);
  }
  return new Promise((resolve, reject) =>
    source.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo codificar la imagen.'))), type, quality),
  );
}

/** Resolves the "same as original" format choice to a type the browser can encode. */
export function outputType(file, format) {
  if (format && format !== 'same') return format;
  return IMAGE_EXT[file.type] ? file.type : 'image/png';
}

export const rename = (file, suffix, type) => `${base(file.name)}-${suffix}.${IMAGE_EXT[type]}`;
