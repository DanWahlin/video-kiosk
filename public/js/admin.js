import { $, $$, h, icon, cssTriples, setTheme } from './dom.js';

const IDLE_LABELS = { 0: 'Never', 60: 'After 1 minute', 120: 'After 2 minutes', 300: 'After 5 minutes', 600: 'After 10 minutes' };

export function createAdmin({ onLaunch }) {
  const root = $('#admin');
  const pathInput = $('#source-path');
  const titleInput = $('#folder-title');
  const subtitleInput = $('#folder-subtitle');
  const statusEl = $('#status');
  const launchBtn = $('#launch');
  const dialog = $('#browser');
  let state = null;
  let browseDir = '';

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function save(patch) {
    try {
      state = await api('PUT', '/api/settings', patch);
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  function toast(msg) {
    const t = h('div', { class: 'toast', role: 'alert' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---- Rendering ----
  function render() {
    const { settings, validation, tools } = state;
    const type = settings.source.type;
    setTheme(settings.theme);

    $$('.segmented button', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
    $('#path-label').textContent = type === 'json' ? 'Catalog file' : 'Videos folder';
    pathInput.placeholder = type === 'json' ? '/path/to/catalog.json' : '/path/to/videos';
    if (document.activeElement !== pathInput) pathInput.value = settings.source.path;
    $('#folder-fields').hidden = type !== 'folder';
    if (document.activeElement !== titleInput) titleInput.value = settings.source.title;
    if (document.activeElement !== subtitleInput) subtitleInput.value = settings.source.subtitle;

    // Quick picks: catalogs in this app, then recent sources of the same type.
    const picks = new Map();
    if (type === 'json') for (const p of state.bundled) picks.set(p, p);
    for (const r of settings.recent) if (r.type === type) picks.set(r.path, r.path);
    picks.delete(settings.source.path);
    $('#quick-picks').replaceChildren(
      ...[...picks.keys()].slice(0, 6).map((p) =>
        h('button', { class: 'chip', type: 'button', title: p, onclick: () => save({ source: { path: p } }) }, icon(type === 'json' ? 'file' : 'file-directory'), h('span', {}, p.split(/[\\/]/).pop())),
      ),
    );

    renderStatus(validation, tools);
    renderThemes();

    const idle = $('#idle');
    if (!idle.options.length) for (const s of state.idleChoices) idle.append(h('option', { value: s }, IDLE_LABELS[s] ?? `${s} s`));
    idle.value = String(settings.idleSeconds);
    $('#attract').setAttribute('aria-checked', String(settings.attractMode));
    $('#captions').setAttribute('aria-checked', String(settings.captions));

    launchBtn.disabled = validation.errors.length > 0;
  }

  function renderStatus({ errors, warnings, summary }, tools) {
    const ok = errors.length === 0;
    statusEl.className = `status ${ok ? 'ok' : 'bad'}`;
    const parts = [];
    if (ok && summary) {
      const missing = summary.videos - summary.playable;
      parts.push(
        h('div', { class: 'status-head' }, icon('check-circle-fill'), `Ready: ${summary.folders} ${summary.folders === 1 ? 'folder' : 'folders'}, ${summary.playable} ${summary.playable === 1 ? 'video' : 'videos'}${missing ? ` (${missing} not found)` : ''}`),
      );
    } else {
      parts.push(h('div', { class: 'status-head' }, icon('alert'), state.settings.source.path ? 'The kiosk cannot use this source' : 'Pick a source to start'));
      if (state.settings.source.path) parts.push(h('ul', {}, errors.map((e) => h('li', {}, e))));
    }
    if (warnings.length) {
      parts.push(h('details', {}, h('summary', {}, `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`), h('ul', {}, warnings.map((w) => h('li', {}, w)))));
    }
    if (ok && (!tools.ffmpeg || !tools.ffprobe)) {
      parts.push(h('p', { style: { margin: '8px 0 0' } }, 'Install ', h('code', {}, 'ffmpeg'), ' to show video thumbnails and lengths in the list.'));
    }
    if (state.settings.source.path) {
      parts.push(
        h(
          'div',
          { class: 'status-actions' },
          h('button', { class: 'btn', type: 'button', onclick: reload }, icon('sync'), 'Reload'),
          ok ? h('a', { class: 'btn', href: '/api/catalog/export', download: 'kiosk-catalog.json' }, icon('download'), 'Download catalog JSON') : null,
        ),
      );
    }
    statusEl.replaceChildren(...parts);
  }

  function renderThemes() {
    const wrap = $('#themes');
    if (!wrap.children.length) {
      for (const t of state.themes) {
        const preview = h('span', { class: 'theme-preview' }, h('i'), h('i', { class: 'mid' }), h('i'));
        const tile = h(
          'button',
          { class: 'theme-tile', type: 'button', role: 'radio', 'data-theme': t.id, dataset: { id: t.id }, onclick: () => save({ theme: t.id }) },
          preview,
          h('span', { class: 'theme-name' }, t.name),
          h('span', { class: 'theme-desc' }, t.description),
        );
        wrap.append(tile);
        const palette = cssTriples('--palette', tile);
        const active = cssTriples('--active', tile)[0];
        const [a, b, c] = $$('i', preview);
        a.style.setProperty('--c', palette[0].join(' '));
        b.style.setProperty('--c', active.join(' '));
        c.style.setProperty('--c', palette[palette.length > 2 ? 2 : 0].join(' '));
      }
    }
    $$('.theme-tile', wrap).forEach((tile) => tile.setAttribute('aria-checked', String(tile.dataset.id === state.settings.theme)));
  }

  async function reload() {
    try {
      state = await api('POST', '/api/reload');
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- Folder and file browser ----
  async function browse(dir) {
    const type = state.settings.source.type;
    try {
      const data = await api('GET', `/api/browse?files=${type === 'json' ? 'json' : ''}&dir=${encodeURIComponent(dir ?? '')}`);
      browseDir = data.dir;
      $('#browser-path').textContent = data.dir;
      $('#browser-shortcuts').replaceChildren(
        ...data.shortcuts.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => browse(s.path) }, h('span', {}, s.name))),
      );
      const items = [];
      if (data.parent) items.push(h('li', {}, h('button', { type: 'button', onclick: () => browse(data.parent) }, icon('arrow-left'), '..')));
      for (const e of data.entries) {
        items.push(
          h(
            'li',
            { class: e.kind === 'json' ? 'is-json' : '' },
            h('button', { type: 'button', ondblclick: e.kind === 'dir' && type === 'folder' ? () => choose(e.path) : null, onclick: () => (e.kind === 'dir' ? browse(e.path) : choose(e.path)) }, icon(e.kind === 'dir' ? 'file-directory' : 'file'), e.name),
          ),
        );
      }
      if (!data.entries.length) items.push(h('li', { class: 'empty' }, type === 'json' ? 'No folders or JSON files here.' : 'No subfolders here.'));
      $('#browser-list').replaceChildren(...items);
      $('#browser-list').scrollTop = 0;
    } catch (err) {
      toast(err.message);
    }
  }

  function choose(p) {
    dialog.close();
    save({ source: { path: p } });
  }

  function openBrowser() {
    const type = state.settings.source.type;
    $('#browser-title').textContent = type === 'json' ? 'Select a catalog JSON file' : 'Select a videos folder';
    $('#browser-use').hidden = type !== 'folder';
    const current = state.settings.source.path;
    browse(current ? (type === 'json' ? current.replace(/[\\/][^\\/]*$/, '') : current) : '');
    dialog.showModal();
  }

  // ---- Events ----
  $$('.segmented button', root).forEach((b) =>
    b.addEventListener('click', () => {
      const type = b.dataset.type;
      if (type === state.settings.source.type) return;
      const recent = state.settings.recent.find((r) => r.type === type);
      save({ source: { type, path: recent?.path ?? '' } });
    }),
  );
  const commitPath = () => pathInput.value.trim() !== state.settings.source.path && save({ source: { path: pathInput.value.trim() } });
  pathInput.addEventListener('change', commitPath);
  pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && commitPath());
  titleInput.addEventListener('change', () => save({ source: { title: titleInput.value } }));
  subtitleInput.addEventListener('change', () => save({ source: { subtitle: subtitleInput.value } }));
  $('#browse').addEventListener('click', openBrowser);
  $('#browser-cancel').addEventListener('click', () => dialog.close());
  $('#browser-use').addEventListener('click', () => choose(browseDir));
  $('#idle').addEventListener('change', (e) => save({ idleSeconds: Number(e.target.value) }));
  $('#attract').addEventListener('click', () => save({ attractMode: !state.settings.attractMode }));
  $('#captions').addEventListener('click', () => save({ captions: !state.settings.captions }));
  launchBtn.addEventListener('click', async () => {
    launchBtn.disabled = true;
    root.hidden = true;
    try {
      await onLaunch();
    } catch (err) {
      root.hidden = false;
      toast(err.message);
    } finally {
      launchBtn.disabled = state.validation.errors.length > 0;
    }
  });
  $('#kiosk-url').textContent = `${location.origin}/#kiosk`;

  return {
    async show() {
      try {
        state = await api('GET', '/api/settings');
      } catch (err) {
        root.hidden = false;
        $('.admin-panel', root).replaceChildren(
          h('section', { class: 'card' }, h('h2', {}, 'Settings are not available here'), h('p', { class: 'hint' }, err.message, ' To show the kiosk on this screen, open ', h('a', { href: '/#kiosk' }, '/#kiosk'), '.')),
        );
        return;
      }
      render();
      root.hidden = false;
    },
  };
}
