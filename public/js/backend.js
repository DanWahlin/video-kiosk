// The settings page and the kiosk talk to one of two backends:
//   - The Node server (npm start): settings are saved on the server, and the server
//     can read folders and make thumbnails.
//   - A static site (npm run build:static), for example Azure Static Web Apps:
//     the build writes kiosk.config.json and the catalogs, and the settings are
//     saved in this browser.

const SETTINGS_KEY = 'kiosk-settings';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const serverBackend = {
  isStatic: false,
  getSettings: () => request('GET', '/api/settings'),
  updateSettings: (patch) => request('PUT', '/api/settings', patch),
  reload: () => request('POST', '/api/reload'),
  browse: (type, dir) => request('GET', `/api/browse?files=${type === 'json' ? 'json' : ''}&dir=${encodeURIComponent(dir ?? '')}`),
  getCatalog: () => request('GET', '/api/catalog'),
};

function staticBackend(config) {
  const catalogs = config.catalogs;
  const find = (file) => catalogs.find((c) => c.file === file) ?? catalogs[0];

  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
    } catch {
      // No saved settings, or storage is off: use the defaults.
    }
    const s = { ...config.defaults };
    if (config.themes.some((t) => t.id === saved.theme)) s.theme = saved.theme;
    if (config.idleChoices.includes(saved.idleSeconds)) s.idleSeconds = saved.idleSeconds;
    if (config.captionSizes.includes(saved.captionSize)) s.captionSize = saved.captionSize;
    // On/off settings (attract mode, captions, loop playback): any boolean in the defaults.
    for (const [key, value] of Object.entries(config.defaults)) if (typeof value === 'boolean' && typeof saved[key] === 'boolean') s[key] = saved[key];
    s.catalog = find(saved.catalog).file;
    return s;
  }

  function response(s) {
    const catalog = find(s.catalog);
    return {
      static: true,
      settings: { ...s, source: { type: 'json', path: catalog.file, title: '', subtitle: '' }, recent: [] },
      themes: config.themes,
      idleChoices: config.idleChoices,
      captionSizes: config.captionSizes,
      validation: { errors: [], warnings: [], summary: catalog.summary },
      tools: { ffmpeg: true, ffprobe: true },
      bundled: catalogs.map((c) => c.file),
    };
  }

  return {
    isStatic: true,
    getSettings: async () => response(load()),
    async updateSettings(patch) {
      const s = { ...load(), ...patch };
      if (patch.source?.path) s.catalog = patch.source.path;
      delete s.source;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
      } catch {
        // Storage is off: the change applies until the page reloads.
      }
      return response(s);
    },
    reload: async () => response(load()),
    // The dialog lists the catalog JSON files that the build put in /catalogs.
    browse: async () => ({
      dir: '/catalogs',
      root: null,
      parent: null,
      shortcuts: [],
      entries: catalogs.map((c) => ({ name: c.file.split('/').pop(), path: c.file, kind: 'json' })),
    }),
    async getCatalog() {
      const s = load();
      const catalog = await request('GET', s.catalog);
      return { ...catalog, settings: s };
    },
  };
}

export async function createBackend() {
  try {
    const res = await fetch('/kiosk.config.json', { cache: 'no-store' });
    if (res.status === 200) return staticBackend(await res.json());
  } catch {
    // No static config: use the server.
  }
  return serverBackend;
}
