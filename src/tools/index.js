import download from './download.js';
import image from './image.js';
import pdf from './pdf.js';
import media from './media.js';
import text from './text.js';
import imageEditors from './image-editors.js';
import mediaCompose from './media-compose.js';
import pdfEditors from './pdf-editors.js';
import utilities from './utilities.js';
import office from './office.js';
import speech from './speech.js';
import fonts from './fonts.js';

export const categories = [
  { id: 'descargas', name: 'Descargas' },
  { id: 'imagen', name: 'Imagen' },
  { id: 'pdf', name: 'PDF' },
  { id: 'documentos', name: 'Documentos' },
  { id: 'video', name: 'Video' },
  { id: 'audio', name: 'Audio' },
  { id: 'texto', name: 'Texto' },
  { id: 'utilidades', name: 'Utilidades' },
];

export const tools = [...download, ...image, ...imageEditors, ...pdf, ...pdfEditors, ...office, ...media, ...mediaCompose, ...text, ...speech, ...utilities, ...fonts];
