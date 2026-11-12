import { DESKTOP } from '../env.js';
import { resultView } from '../tool-page.js';
import { h } from '../ui.js';

/** Spanish voices first, then the rest by language. */
const byLanguage = (a, b) => Number(b.lang.startsWith('es')) - Number(a.lang.startsWith('es')) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);

function renderSpeech(root) {
  const text = h('textarea', { class: 'text-in', rows: 8, placeholder: 'Escribe o pega el texto que quieres oír…', 'aria-label': 'Texto' });
  const voice = h('select', {});
  const speed = h('input', { type: 'range', min: 0.5, max: 2, step: 0.1, value: 1 });
  const speedShown = h('output', {}, '1');
  speed.addEventListener('input', () => (speedShown.textContent = speed.value));
  const status = h('p', { class: 'status', role: 'status' });
  const out = resultView();
  const synth = !DESKTOP && window.speechSynthesis;

  const setStatus = (message, isError) => {
    status.textContent = message || '';
    status.classList.toggle('error', !!isError);
  };

  function fillVoices(voices) {
    const current = voice.value;
    const options = [...voices].sort(byLanguage).map((v) => h('option', { value: v.name, selected: v.name === current }, `${v.name} (${v.lang})`));
    voice.replaceChildren(...(options.length ? options : [h('option', { value: '' }, 'Voz predeterminada')]));
    // Browsers list their voices a moment after the page asks; only the desktop answer is final.
    if (DESKTOP && !voices.length) setStatus('No hay voces instaladas en este equipo.', true);
  }

  async function speakInBrowser() {
    if (!text.value.trim()) return setStatus('Escribe un texto primero.', true);
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text.value);
    const chosen = synth.getVoices().find((v) => v.name === voice.value);
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    }
    utterance.rate = Number(speed.value);
    utterance.onend = () => setStatus('');
    utterance.onerror = (event) => event.error !== 'canceled' && event.error !== 'interrupted' && setStatus(`No se pudo leer el texto: ${event.error}`, true);
    setStatus('Leyendo…');
    synth.speak(utterance);
  }

  async function generate() {
    if (!text.value.trim()) return setStatus('Escribe un texto primero.', true);
    button.disabled = true;
    out.clear();
    setStatus('Generando el audio…');
    try {
      // Windows rates go from -10 to 10; 10 is about three times faster than normal.
      const rate = Math.round((Number(speed.value) - 1) * 10);
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.value, voice: voice.value, rate }),
      });
      if (!response.ok) throw new Error((await response.text()) || 'No se pudo generar el audio.');
      out.show({ blob: await response.blob(), name: 'voz.wav' });
      setStatus('');
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  const button = DESKTOP
    ? h('button', { type: 'button', class: 'btn primary', onclick: generate }, 'Generar audio')
    : h('button', { type: 'button', class: 'btn primary', onclick: speakInBrowser }, 'Escuchar');
  const stop = synth && h('button', { type: 'button', class: 'btn', onclick: () => (synth.cancel(), setStatus('')) }, 'Detener');

  if (DESKTOP) {
    fetch('/api/voices', { method: 'POST' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then(fillVoices)
      .catch(() => setStatus('No se pudieron leer las voces de Windows.', true));
  } else {
    fillVoices(synth.getVoices());
    synth.addEventListener('voiceschanged', () => fillVoices(synth.getVoices()));
  }

  root.append(
    text,
    h(
      'div',
      { class: 'fields' },
      h('label', { class: 'field' }, h('span', {}, 'Voz'), voice),
      h('label', { class: 'field' }, h('span', {}, 'Velocidad ', speedShown), speed),
    ),
    h(
      'p',
      { class: 'note' },
      DESKTOP
        ? 'Usa las voces instaladas en Windows. Puedes añadir más en Configuración › Hora e idioma › Voz.'
        : 'Usa las voces de tu dispositivo y solo se puede escuchar. Para descargar el audio usa la versión para Windows.',
    ),
    h('div', { class: 'result-row' }, button, stop),
    status,
    out.el,
  );
  return () => {
    synth?.cancel();
    out.clear();
  };
}

export default [
  {
    id: 'texto-voz',
    name: 'Texto a voz',
    desc: DESKTOP ? 'Convierte un texto en audio hablado y descárgalo.' : 'Escucha cualquier texto leído en voz alta.',
    cat: 'texto',
    blocked: () => !DESKTOP && !window.speechSynthesis && 'Este navegador no puede leer texto en voz alta.',
    render: renderSpeech,
  },
];
