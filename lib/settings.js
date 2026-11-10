import fs from 'node:fs';
import path from 'node:path';

export const THEMES = [
  { id: 'dark', name: 'Dark', description: 'Deep navy with cyan and violet light' },
  { id: 'light', name: 'Light', description: 'Bright glass with cyan and lavender' },
  { id: 'github-dark', name: 'GitHub Dark', description: 'GitHub brand neutrals with GitHub Green' },
  { id: 'github-light', name: 'GitHub Light', description: 'GitHub brand light neutrals with GitHub Green' },
];
export const IDLE_CHOICES = [0, 60, 120, 300, 600];
export const CAPTION_SIZES = ['small', 'medium', 'large', 'x-large'];

const DEFAULTS = {
  source: { type: 'json', path: '', title: '', subtitle: '' },
  theme: 'dark',
  idleSeconds: 120,
  attractMode: true,
  captions: true,
  captionSize: 'medium',
  recent: [],
};

const str = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createSettingsStore(file) {
  let settings = structuredClone(DEFAULTS);
  try {
    settings = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')), settings);
  } catch {
    // First run, or an unreadable file: use the defaults.
  }

  function sanitize(input, base) {
    const next = structuredClone(base);
    if (input?.source && typeof input.source === 'object') {
      const s = input.source;
      if (s.type === 'json' || s.type === 'folder') next.source.type = s.type;
      if ('path' in s) next.source.path = str(s.path).trim();
      if ('title' in s) next.source.title = str(s.title, 80);
      if ('subtitle' in s) next.source.subtitle = str(s.subtitle, 120);
    }
    if (THEMES.some((t) => t.id === input?.theme)) next.theme = input.theme;
    if (IDLE_CHOICES.includes(input?.idleSeconds)) next.idleSeconds = input.idleSeconds;
    if (typeof input?.attractMode === 'boolean') next.attractMode = input.attractMode;
    if (typeof input?.captions === 'boolean') next.captions = input.captions;
    if (CAPTION_SIZES.includes(input?.captionSize)) next.captionSize = input.captionSize;
    if (Array.isArray(input?.recent)) {
      next.recent = input.recent
        .filter((r) => r && (r.type === 'json' || r.type === 'folder') && typeof r.path === 'string' && r.path)
        .slice(0, 8)
        .map((r) => ({ type: r.type, path: r.path }));
    }
    return next;
  }

  return {
    get: () => structuredClone(settings),
    update(patch) {
      settings = sanitize(patch, settings);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
      return structuredClone(settings);
    },
  };
}
