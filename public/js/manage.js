// Video management: turn videos on or off, edit their text, add videos, and publish the
// catalog to Blob Storage, where the kiosks get it. Changes stay in this page until you
// publish them. The API (api/) checks each request and each published catalog.
import { $, $$, h, icon, loadUiIcons, formatTime } from './dom.js';
import { faststart } from './mp4-faststart.js';
import { prepareVideo } from './video-prep.js';
import { uploadFile } from './blob-upload.js';

try {
  const t = localStorage.getItem('kiosk-theme');
  if (/^(dark|light|github-dark|github-light|vscode-dark|vscode-light)$/.test(t)) document.documentElement.dataset.theme = t;
} catch {
  // Storage is off: use the default theme.
}

const LOGIN = '/.auth/login/github?post_login_redirect_uri=/manage.html';
const NEW_FOLDER = '__new__';
const clone = (x) => structuredClone(x);
const isOn = (v) => v.enabled !== false;

let state = null; // { name, original, draft, etag, published, videosBase }
const localThumbs = new Map(); // video URL -> object URL of the thumbnail made in this page

// ---- API ----
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json', 'X-Kiosk-Manage': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.redirected) {
    location.href = LOGIN;
    throw new Error('Sign in with GitHub.');
  }
  const data = await res.json().catch(() => ({ error: `The server answered HTTP ${res.status}.` }));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${res.status})`), { status: res.status });
  return data;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 6000);
}

// ---- Start ----
async function start() {
  await loadUiIcons();
  // /.auth/me is part of Azure Static Web Apps. The local Node server does not have it.
  const me = await fetch('/.auth/me', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!me) {
    $('#who').textContent = 'Not available here';
    $('#gate-text').textContent = 'Video management works on the Azure Static Web Apps site, where people sign in with GitHub. On the local server, edit the catalog JSON file, then select Reload on the settings page.';
    $('#gate').hidden = false;
    return;
  }
  if (!me.clientPrincipal) return (location.href = LOGIN);
  let info;
  try {
    info = await api('GET', '/api/manage/me');
  } catch (err) {
    $('#who').textContent = `Signed in as @${me.clientPrincipal.userDetails}`;
    $('#gate-text').textContent = err.status === 403 ? `${err.message} Ask an owner of the kiosk to add your GitHub username to the MANAGERS app setting.` : err.message;
    $('#gate').hidden = false;
    return;
  }
  $('#who').textContent = `Signed in as @${info.user}`;
  const select = $('#catalog');
  select.replaceChildren(...info.catalogs.map((n) => h('option', { value: n }, n)));
  select.value = preferredCatalog(info.catalogs);
  select.addEventListener('change', async () => {
    if (dirty() && !confirm('Discard the changes that you did not publish?')) return (select.value = state.name);
    await open(select.value);
  });
  $('#main').hidden = false;
  await open(select.value);
}

// The catalog in the link (?catalog=), else the one that this browser's kiosk uses.
function preferredCatalog(names) {
  const wanted = new URLSearchParams(location.search).get('catalog');
  if (names.includes(wanted)) return wanted;
  try {
    const saved = JSON.parse(localStorage.getItem('kiosk-settings'))?.catalog?.split('/').pop().replace(/\.json$/, '');
    if (names.includes(saved)) return saved;
  } catch {
    // No saved settings.
  }
  return names[0];
}

async function open(name) {
  $('#rows').replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'Loading…')));
  const data = await api('GET', `/api/manage/catalogs/${encodeURIComponent(name)}`);
  state = { name, original: data.catalog, draft: clone(data.catalog), etag: data.etag, published: data.published, videosBase: data.videosBase };
  history.replaceState(null, '', `?catalog=${encodeURIComponent(name)}`);
  render();
}

// ---- Changes ----
const folderKey = (f) => `${f.title}\u0000${f.description ?? ''}`;
function videoMap(catalog) {
  const map = new Map();
  for (const f of catalog.folders) for (const v of f.videos) map.set(v.path, v);
  return map;
}
function changes() {
  if (!state) return [];
  const { original, draft } = state;
  const before = videoMap(original);
  const after = videoMap(draft);
  const oldFolders = new Set(original.folders.map(folderKey));
  const newFolders = new Set(draft.folders.map(folderKey));
  const out = [];
  for (const f of draft.folders) if (!oldFolders.has(folderKey(f))) out.push(`New folder: ${f.title} (${f.description})`);
  for (const f of original.folders) if (!newFolders.has(folderKey(f))) out.push(`Removed folder: ${f.title} (${f.description})`);
  for (const [path, v] of after) {
    const o = before.get(path);
    if (!o) out.push(`Added: ${v.title}`);
    else {
      if (isOn(o) !== isOn(v)) out.push(`${isOn(v) ? 'Turned on' : 'Turned off'}: ${v.title}`);
      if (o.title !== v.title || (o.description ?? '') !== (v.description ?? '')) out.push(`Edited: ${v.title}`);
    }
  }
  for (const [path, v] of before) if (!after.has(path)) out.push(`Removed: ${v.title}`);
  if (!out.length && JSON.stringify(original) !== JSON.stringify(draft)) out.push('Other changes (for example, the order of the videos)');
  return out;
}
const dirty = () => changes().length > 0;

function rowStatus(v) {
  const o = videoMap(state.original).get(v.path);
  if (!o) return 'new';
  if (isOn(o) !== isOn(v) || o.title !== v.title || (o.description ?? '') !== (v.description ?? '')) return 'changed';
  return '';
}

// ---- Table ----
const fileName = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop());

function render() {
  const { draft, published } = state;
  $('#published').textContent = published
    ? `Live version: published ${new Date(published.at).toLocaleString()} by @${published.by}.`
    : 'Live version: the copy in the GitHub repo. Nothing is published from this page yet.';
  const filter = $('#filter').value.trim().toLowerCase();
  const rows = [];
  draft.folders.forEach((f, fi) => {
    const match = (v) => !filter || `${f.title} ${f.description} ${v.title} ${v.description ?? ''} ${fileName(v.path)}`.toLowerCase().includes(filter);
    const videos = f.videos.map((v, vi) => ({ v, vi })).filter(({ v }) => match(v));
    if (!videos.length) return;
    const on = f.videos.filter(isOn).length;
    rows.push(
      h(
        'tr',
        { class: 'folder-row' },
        h(
          'th',
          { colspan: 5, scope: 'rowgroup' },
          h('span', { class: 'f-title' }, f.title),
          f.description ? h('span', { class: 'f-desc' }, f.description) : null,
          h('span', { class: `f-count${on ? '' : ' is-off'}` }, on ? `${on} of ${f.videos.length} in kiosk` : 'Hidden: no videos are on'),
        ),
      ),
    );
    for (const { v, vi } of videos) rows.push(videoRow(v, fi, vi));
  });
  if (!rows.length) rows.push(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No videos match.')));
  $('#rows').replaceChildren(...rows);
  updateToolbar();
}

function videoRow(v, fi, vi) {
  const status = rowStatus(v);
  const thumbSrc = localThumbs.get(v.path) ?? v.thumbnail;
  const sw = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(isOn(v)),
    'aria-label': `Show "${v.title}" in the kiosk`,
    onclick: () => {
      if (isOn(v)) v.enabled = false;
      else delete v.enabled;
      render();
    },
  });
  return h(
    'tr',
    { class: [status && `is-${status}`, !isOn(v) && 'is-off'].filter(Boolean).join(' ') },
    h('td', { class: 'c-thumb' }, thumbSrc ? h('img', { src: thumbSrc, alt: '', loading: 'lazy' }) : h('span', { class: 'no-thumb' }, icon('video'))),
    h(
      'td',
      { class: 'c-video' },
      h('div', { class: 'v-title' }, v.title, status === 'new' ? h('span', { class: 'badge new' }, 'New') : status === 'changed' ? h('span', { class: 'badge' }, 'Changed') : null),
      v.description ? h('div', { class: 'v-desc' }, v.description) : null,
      h('div', { class: 'v-file' }, fileName(v.path), v.captions ? ' · captions' : ''),
    ),
    h('td', { class: 'c-dur' }, formatTime(v.duration)),
    h('td', { class: 'c-on' }, sw),
    h('td', { class: 'c-edit' }, h('button', { class: 'btn icon-btn', type: 'button', 'aria-label': `Edit "${v.title}"`, title: 'Edit', onclick: () => editVideo(fi, vi) }, icon('pencil'))),
  );
}

function updateToolbar() {
  const list = changes();
  $('#changes').textContent = list.length ? `${list.length} unpublished ${list.length === 1 ? 'change' : 'changes'}` : '';
  $('#publish').disabled = !list.length;
  $('#discard').disabled = !list.length;
}

// ---- Edit ----
function editVideo(fi, vi) {
  const v = state.draft.folders[fi].videos[vi];
  const dlg = $('#edit-dialog');
  $('#edit-file').textContent = `${state.draft.folders[fi].title} · ${fileName(v.path)}`;
  $('#edit-title').value = v.title;
  $('#edit-desc').value = v.description ?? '';
  $('#edit-form').onsubmit = (e) => {
    const title = $('#edit-title').value.trim();
    if (!title) {
      e.preventDefault();
      return $('#edit-title').focus();
    }
    v.title = title;
    v.description = $('#edit-desc').value.trim();
    render();
  };
  dlg.showModal();
}
$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());

// ---- Add a video ----
// The storage folder of a kiosk folder: the folder that most of its videos are in.
function storageFolderOf(folder) {
  const base = `${state.videosBase}/`;
  const counts = new Map();
  for (const v of folder.videos) {
    if (!v.path.startsWith(base)) continue;
    const parts = v.path.slice(base.length).split('?')[0].split('/').map(decodeURIComponent);
    if (parts.length !== 2) continue;
    counts.set(parts[0], (counts.get(parts[0]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
const cleanFolderName = (s) => s.replace(/[\\/\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150);

function storageFolder() {
  const pick = $('#add-folder').value;
  if (pick !== NEW_FOLDER) {
    const f = state.draft.folders[Number(pick)];
    return storageFolderOf(f) ?? cleanFolderName(f.description ? `${f.title} - ${f.description}` : f.title);
  }
  const title = $('#nf-title').value.trim();
  const desc = $('#nf-desc').value.trim();
  return title ? cleanFolderName(desc ? `${title} - ${desc}` : title) : '';
}
function syncAddForm() {
  $('#new-folder').hidden = $('#add-folder').value !== NEW_FOLDER;
  $('#add-storage').textContent = storageFolder() || '(enter a folder title)';
}

function showAdd() {
  const select = $('#add-folder');
  select.replaceChildren(
    ...state.draft.folders.map((f, i) => h('option', { value: i }, f.description ? `${f.title} · ${f.description}` : f.title)),
    h('option', { value: NEW_FOLDER }, 'New folder…'),
  );
  $('#add-form').reset();
  $('#nf-icon').value = 'file-directory';
  $('#steps').hidden = true;
  $('#add-error').hidden = true;
  setBusy(false);
  syncAddForm();
  $('#add-dialog').showModal();
}
for (const id of ['#add-folder', '#nf-title', '#nf-desc']) $(id).addEventListener('input', syncAddForm);
$('#add-folder').addEventListener('change', syncAddForm);
$('#add-file').addEventListener('change', () => {
  const file = $('#add-file').files[0];
  if (file && !$('#add-title').value) $('#add-title').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
});

let busy = false;
function setBusy(on) {
  busy = on;
  for (const el of $$('input, textarea, select, #add-go', $('#add-form'))) el.disabled = on;
  $('#add-cancel').textContent = on ? 'Stop' : 'Cancel';
}
$('#add-cancel').addEventListener('click', () => {
  if (busy && !confirm('Stop the upload? The files that are already uploaded stay in storage but are not in the catalog.')) return;
  addAbort?.abort();
  $('#add-dialog').close();
});
$('#add-dialog').addEventListener('cancel', (e) => busy && e.preventDefault());

function step(text) {
  const li = h('li', { class: 'is-active' }, h('span', { class: 'step-text' }, text), h('span', { class: 'step-state' }));
  $('#steps').append(li);
  return {
    progress: (p) => ($('.step-state', li).textContent = `${Math.round(p * 100)}%`),
    done: (note = '') => {
      li.className = 'is-done';
      $('.step-state', li).textContent = note || 'Done';
    },
    fail: () => {
      li.className = 'is-failed';
      $('.step-state', li).textContent = 'Failed';
    },
  };
}

let addAbort = null;
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const err = $('#add-error');
  err.hidden = true;
  const file = $('#add-file').files[0];
  const captionsFile = $('#add-captions').files[0];
  const title = $('#add-title').value.trim();
  const description = $('#add-desc').value.trim();
  const isNew = $('#add-folder').value === NEW_FOLDER;
  const folderTitle = $('#nf-title').value.trim();
  const folderIcon = $('#nf-icon').value.trim() || 'file-directory';
  const problem = !title
    ? 'Enter a video title.'
    : !file
      ? 'Pick a video file.'
      : !/\.(mp4|m4v|webm)$/i.test(file.name)
        ? 'The video must be an .mp4, .m4v, or .webm file.'
        : captionsFile && !/\.vtt$/i.test(captionsFile.name)
          ? 'Captions must be a .vtt file.'
          : isNew && !folderTitle
            ? 'Enter a title for the new folder.'
            : isNew && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(folderIcon)
              ? 'The folder icon must be an Octicon name, for example "file-directory".'
              : isNew && state.draft.folders.some((f) => folderKey(f) === folderKey({ title: folderTitle, description: $('#nf-desc').value.trim() }))
                ? 'A folder with this title and description is already in the catalog. Pick it in the list.'
                : '';
  if (problem) {
    err.textContent = problem;
    err.hidden = false;
    return;
  }

  setBusy(true);
  addAbort = new AbortController();
  $('#steps').replaceChildren();
  $('#steps').hidden = false;
  let current;
  const { signal } = addAbort;
  const check = () => {
    if (signal.aborted) throw new Error('The upload stopped.');
  };
  try {
    let video = file;
    if (/\.(mp4|m4v)$/i.test(file.name)) {
      current = step('Getting the video ready to stream');
      const fixed = await faststart(file);
      video = fixed.file;
      current.done(fixed.changed ? 'Done (index moved to the start)' : 'Done (already ready)');
    }
    current = step('Reading the video and making a thumbnail');
    const info = await prepareVideo(video);
    check();
    current.done(`${formatTime(info.duration)}, ${info.width}×${info.height}`);

    let captionsText = null;
    if (captionsFile) {
      current = step('Checking the captions');
      captionsText = (await captionsFile.text()).replace(/^\uFEFF/, '');
      if (!captionsText.startsWith('WEBVTT')) throw new Error('The captions file is not a WebVTT file (it must start with "WEBVTT").');
      current.done();
    }

    current = step('Getting upload links');
    const folder = storageFolder();
    check();
    const links = await api('POST', '/api/manage/uploads', { folder, fileName: file.name, size: video.size, captions: !!captionsText });
    check();
    current.done(fileName(links.video.url));

    current = step(`Uploading the video (${(video.size / 1024 ** 2).toFixed(1)} MB)`);
    await uploadFile(links.video, video, { onProgress: current.progress, signal });
    current.done();
    current = step('Uploading the thumbnail' + (captionsText ? ' and captions' : ''));
    await uploadFile(links.thumbnail, info.thumbnail, { signal });
    if (captionsText) await uploadFile(links.captions, new Blob([captionsText], { type: 'text/vtt' }), { signal });
    current.done();
    check();

    const entry = { title, description, path: links.video.url, ...(links.captions && { captions: links.captions.url }), duration: info.duration, thumbnail: links.thumbnail.url };
    localThumbs.set(entry.path, URL.createObjectURL(info.thumbnail));
    if (isNew) state.draft.folders.push({ title: folderTitle, description: $('#nf-desc').value.trim(), icon: folderIcon, videos: [entry] });
    else state.draft.folders[Number($('#add-folder').value)].videos.push(entry);
    setBusy(false);
    $('#add-dialog').close();
    $('#filter').value = '';
    render();
    showPublish(`"${title}" is uploaded. Publish now so that the kiosks show it?`);
  } catch (error) {
    if (signal.aborted) return setBusy(false);
    current?.fail();
    err.textContent = error.message;
    err.hidden = false;
    setBusy(false);
  }
});

// ---- Publish ----
function showPublish(lead) {
  const list = changes();
  if (!list.length) return;
  $('#publish-list').replaceChildren(...(lead ? [h('li', { class: 'lead' }, lead)] : []), ...list.map((c) => h('li', {}, c)));
  $('#publish-error').hidden = true;
  $('#publish-go').disabled = false;
  $('#publish-dialog').showModal();
}
$('#publish').addEventListener('click', () => showPublish());
$('#publish-cancel').addEventListener('click', () => $('#publish-dialog').close());
$('#publish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#publish-go');
  go.disabled = true;
  const err = $('#publish-error');
  err.hidden = true;
  try {
    const result = await api('PUT', `/api/manage/catalogs/${encodeURIComponent(state.name)}`, { catalog: state.draft, etag: state.etag, note: $('#publish-note').value.trim() });
    state.original = clone(state.draft);
    state.etag = result.etag;
    state.published = result.published;
    $('#publish-note').value = '';
    $('#publish-dialog').close();
    render();
    toast('Published. The kiosks show the change in about a minute.');
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
    go.disabled = false;
  }
});

$('#discard').addEventListener('click', () => {
  if (!confirm('Discard the changes that you did not publish? Uploaded files stay in storage.')) return;
  state.draft = clone(state.original);
  render();
});

// ---- History ----
$('#history').addEventListener('click', async () => {
  const list = $('#history-list');
  list.replaceChildren(h('li', { class: 'empty' }, 'Loading…'));
  $('#history-dialog').showModal();
  try {
    const versions = await api('GET', `/api/manage/catalogs/${encodeURIComponent(state.name)}/versions`);
    const item = (id, when, who, note, label) =>
      h(
        'li',
        {},
        h('div', { class: 'h-text' }, h('strong', {}, label ?? new Date(when).toLocaleString()), h('span', {}, [who && `@${who}`, note].filter(Boolean).join(' · '))),
        h('button', { class: 'btn', type: 'button', onclick: () => downloadVersion(id) }, icon('download'), 'JSON'),
        h('button', { class: 'btn', type: 'button', onclick: () => restore(id, label ?? new Date(when).toLocaleString()) }, icon('history'), 'Restore'),
      );
    list.replaceChildren(
      ...versions.map((v, i) => item(v.id, v.at, v.by, v.note, i === 0 ? `${new Date(v.at).toLocaleString()} (live)` : undefined)),
      item('repo', null, null, `catalogs/${state.name}.json in the GitHub repo`, 'Repo version'),
    );
  } catch (error) {
    list.replaceChildren(h('li', { class: 'empty' }, error.message));
  }
});
$('#history-close').addEventListener('click', () => $('#history-dialog').close());

async function restore(id, label) {
  if (dirty() && !confirm('Replace the changes that you did not publish with this version?')) return;
  const catalog = await api('GET', `/api/manage/catalogs/${encodeURIComponent(state.name)}/versions/${encodeURIComponent(id)}`);
  state.draft = catalog;
  $('#history-dialog').close();
  render();
  if (!dirty()) return toast('This version is the same as the live version.');
  $('#publish-note').value = `Restore ${label}`;
  showPublish(`Publish this version: ${label}?`);
}

function save(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadVersion(id) {
  save(`${state.name}${id === 'repo' ? '' : `-${id}`}.json`, await api('GET', `/api/manage/catalogs/${encodeURIComponent(state.name)}/versions/${encodeURIComponent(id)}`));
}
$('#download').addEventListener('click', () => save(`${state.name}.json`, state.draft));

$('#add').addEventListener('click', showAdd);
$('#filter').addEventListener('input', render);
addEventListener('beforeunload', (e) => {
  if (dirty() || busy) e.preventDefault();
});

start().catch((err) => {
  $('#gate-text').textContent = err.message;
  $('#gate').hidden = false;
});
