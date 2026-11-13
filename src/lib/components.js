// Desktop app: optional programs and models the app downloads the first time a tool needs them
// (see electron/components.js), and the jobs that use them.
import { base, ext } from '../ui.js';

const post = async (url, body) => {
  const response = await fetch(url, { method: 'POST', body });
  if (!response.ok) throw new Error((await response.text()) || 'No se pudo completar la operación.');
  return response;
};

/** Installs whatever of `names` is missing. `progress` goes from 0 to 1 over all the downloads. */
export async function ensureComponents(names, progress) {
  const status = await (await post(`/api/components/status?names=${names.join(',')}`)).json();
  const missing = names.filter((name) => !status[name]?.installed);
  const total = missing.reduce((sum, name) => sum + status[name].size, 0);
  let done = 0;
  for (const name of missing) {
    const timer = setInterval(async () => {
      try {
        const now = (await (await post(`/api/components/status?names=${name}`)).json())[name];
        progress?.((done + (now.received || 0)) / total);
      } catch {
        // The next poll or the install itself reports problems.
      }
    }, 400);
    try {
      await post(`/api/components/install?name=${name}`);
    } finally {
      clearInterval(timer);
    }
    done += status[name].size;
  }
}

/**
 * Sends `file` to one of the app's component jobs (/api/transcribe…) and returns the result as a Blob,
 * reporting the job's progress meanwhile.
 */
export async function componentJob(path, params, file, progress) {
  const id = crypto.randomUUID();
  const timer = setInterval(() => {
    post(`/api/progress?id=${id}`)
      .then((response) => response.json())
      .then((answer) => answer.progress && progress?.(answer.progress))
      .catch(() => {});
  }, 500);
  try {
    const query = new URLSearchParams({ ...params, id, ext: ext(file.name) || 'bin' });
    return await (await post(`${path}?${query}`, file)).blob();
  } finally {
    clearInterval(timer);
  }
}

export const renamed = (file, suffix, extension) => `${base(file.name)}-${suffix}.${extension}`;
