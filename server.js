import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { readCatalogFile, validateCatalog, resolveCatalog, resolvePath, isUrl } from './lib/catalog.js';
import { scanFolder } from './lib/scan.js';
import { createSettingsStore, kioskSettings, THEMES, IDLE_CHOICES, CAPTION_SIZES } from './lib/settings.js';
import { createMediaTools } from './lib/media.js';
import { uiIcons } from './lib/icons.js';
import { toClientCatalog } from './lib/client-catalog.js';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const CATALOG_DIR = path.join(ROOT, 'catalogs');
// Folder mode can use only this folder and the folders inside it.
const VIDEOS_DIR = path.join(ROOT, 'videos');

const settingsStore = createSettingsStore(path.join(ROOT, 'data', 'settings.json'));
const media = createMediaTools(path.join(ROOT, 'data', 'cache'));

// ---- Catalog source ----
const fail = (message) => ({ errors: [message], warnings: [], summary: null });
let active = null; // { raw, runtime, ready, version }
let lastResult = fail('Pick a JSON file or a folder.');

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// True when dir is base or inside it. Real paths stop a symbolic link from pointing outside.
function insideVideos(dir) {
  try {
    const rel = path.relative(fs.realpathSync(VIDEOS_DIR), fs.realpathSync(dir));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function loadSource(source) {
  if (!source?.path && source?.type !== 'folder') return fail('Pick a JSON file or a folder.');
  if (source.type === 'folder') {
    // An empty folder path means the videos folder itself.
    const dir = source.path ? resolvePath(source.path, VIDEOS_DIR) : VIDEOS_DIR;
    if (!isDir(dir)) return fail(`Folder not found: ${dir}`);
    if (!insideVideos(dir)) return fail(`Pick a folder inside ${VIDEOS_DIR}`);
    const catalog = scanFolder(dir, source);
    if (!catalog.folders.length) return fail('No video files were found in this folder.');
    return { catalog, baseDir: dir, ...validateCatalog(catalog, { baseDir: dir }) };
  }
  const read = readCatalogFile(resolvePath(source.path, os.homedir()));
  if (read.error) return fail(read.error);
  return { catalog: read.catalog, baseDir: read.baseDir, ...validateCatalog(read.catalog, { baseDir: read.baseDir }) };
}

function activate() {
  let result;
  try {
    result = loadSource(settingsStore.get().source);
  } catch (err) {
    // A bad saved source must never stop the server: the settings page has to open to fix it.
    result = fail(`Cannot read the source: ${err.code ?? err.message}`);
  }
  lastResult = { errors: result.errors, warnings: result.warnings, summary: result.summary };
  if (result.errors.length) {
    active = null;
  } else {
    const runtime = resolveCatalog(result.catalog, result.baseDir);
    const videos = runtime.folders.flatMap((f) => f.videos);
    const ready = media.fillDurations(videos).catch(() => {});
    const version = Date.now();
    active = { raw: result.catalog, runtime, ready, version };
    // Make thumbnails in the background so the lists show them right away.
    ready
      .then(async () => {
        for (const v of videos) {
          if (active?.version !== version) return;
          if (!v.thumbnail) await media.thumbnail(v.src, v.duration).catch(() => null);
        }
      })
      .catch(() => {});
  }
  return lastResult;
}

function settingsResponse() {
  const settings = settingsStore.get();
  // Folder sources outside the videos folder cannot load, so do not offer them as quick picks.
  settings.recent = settings.recent.filter((r) => r.type !== 'folder' || insideVideos(r.path));
  return {
    settings,
    videosDir: VIDEOS_DIR,
    themes: THEMES,
    idleChoices: IDLE_CHOICES,
    captionSizes: CAPTION_SIZES,
    validation: lastResult,
    tools: media.available,
    bundled: fs.existsSync(CATALOG_DIR)
      ? fs.readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(CATALOG_DIR, f))
      : [],
  };
}

// ---- App ----
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const loopback = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h ?? '');
const isLocalAddress = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
// The admin API can read folder listings, so only this computer can use it. The Host
// check also blocks DNS-rebinding attacks from web pages.
function adminOnly(req, res, next) {
  if (isLocalAddress(req.socket.remoteAddress) && loopback(req.headers.host)) return next();
  res.status(403).json({ error: 'The settings are available only on the kiosk computer.' });
}

app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
app.use('/fonts', express.static(path.join(ROOT, 'node_modules/@fontsource-variable/mona-sans/files'), { maxAge: '30d', immutable: true }));
app.use('/schema', express.static(path.join(ROOT, 'schema')));

const ICONS = uiIcons();
app.get('/icons.json', (_req, res) => res.json(ICONS));
// Only a static build has kiosk.config.json. "No content" tells the page to use this server.
app.get('/kiosk.config.json', (_req, res) => res.sendStatus(204));

app.get('/api/settings', adminOnly, (_req, res) => res.json(settingsResponse()));

app.put('/api/settings', adminOnly, (req, res) => {
  const before = settingsStore.get();
  const after = settingsStore.update(req.body);
  if (JSON.stringify(after.source) !== JSON.stringify(before.source)) {
    activate();
    // Remember only sources that load, so a bad path never comes back as a quick pick.
    if (after.source.path && !lastResult.errors.length) {
      settingsStore.update({ recent: [{ type: after.source.type, path: after.source.path }, ...after.recent.filter((r) => r.path !== after.source.path)] });
    }
  }
  res.json(settingsResponse());
});

app.post('/api/reload', adminOnly, (_req, res) => {
  activate();
  res.json(settingsResponse());
});

app.get('/api/browse', adminOnly, (req, res) => {
  const wantFiles = req.query.files === 'json';
  const base = wantFiles ? null : VIDEOS_DIR;
  let dir = typeof req.query.dir === 'string' && req.query.dir ? resolvePath(req.query.dir, base ?? os.homedir()) : (base ?? os.homedir());
  if (!isDir(dir) && fs.existsSync(dir)) dir = path.dirname(dir); // A file: open its folder.
  // A folder that no longer exists opens its nearest parent.
  while (!isDir(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (base && !insideVideos(dir)) dir = base;
  if (!isDir(dir)) return res.status(400).json({ error: base ? `The videos folder was not found: ${base}` : `Cannot open ${dir}` });
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => e.isDirectory() || (wantFiles && e.isFile() && e.name.toLowerCase().endsWith('.json')))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), kind: e.isDirectory() ? 'dir' : 'json' }))
      .filter((e) => !base || insideVideos(e.path))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
    const shortcuts = base
      ? [{ name: 'Videos', path: base }]
      : [
          { name: 'Home', path: os.homedir() },
          { name: 'Desktop', path: path.join(os.homedir(), 'Desktop') },
          { name: 'Documents', path: path.join(os.homedir(), 'Documents') },
          { name: 'App catalogs', path: CATALOG_DIR },
          ...(process.platform === 'darwin' ? [{ name: 'Drives', path: '/Volumes' }] : []),
        ].filter((s) => fs.existsSync(s.path));
    const atTop = base ? path.resolve(dir) === path.resolve(base) : path.dirname(dir) === dir;
    res.json({ dir, root: base, parent: atTop ? null : path.dirname(dir), entries, shortcuts });
  } catch (err) {
    res.status(400).json({ error: `Cannot open ${dir}: ${err.code ?? err.message}` });
  }
});

app.get('/api/catalog/export', adminOnly, (_req, res) => {
  if (!active) return res.status(409).json({ error: 'No catalog is loaded.' });
  res.attachment('kiosk-catalog.json').type('application/json').send(JSON.stringify(active.raw, null, 2) + '\n');
});

app.get('/api/catalog', async (_req, res) => {
  if (!active) return res.status(409).json({ error: 'No catalog is loaded. Open the settings page on the kiosk computer.' });
  // Wait for video lengths, but never more than a few seconds.
  let timer;
  await Promise.race([active.ready, new Promise((r) => (timer = setTimeout(r, 8000)))]);
  clearTimeout(timer);
  const { runtime, version } = active;
  const s = settingsStore.get();
  // A URL plays from where it is; a local file goes through the /media routes.
  const local = (file, route) => (isUrl(file) ? file : `${route}?v=${version}`);
  res.json({
    version,
    settings: kioskSettings(s),
    ...toClientCatalog(runtime, { mediaUrl: local, imageUrl: local, canMakeThumbnails: media.available.ffmpeg }),
  });
});

// ---- Media: only files that the active catalog names can be read ----
function lookup(req, res) {
  const f = active?.runtime.folders[Number(req.params.f)];
  const v = req.params.v === undefined ? null : f?.videos[Number(req.params.v)];
  if (!f || (req.params.v !== undefined && !v)) {
    res.sendStatus(404);
    return null;
  }
  return { folder: f, video: v };
}
const send = (res, file, type) => {
  if (!file) return res.sendStatus(404);
  if (isUrl(file)) return res.redirect(file);
  res.sendFile(file, { headers: type ? { 'Content-Type': type } : {}, maxAge: '1h' }, (err) => err && !res.headersSent && res.sendStatus(404));
};

app.get('/media/icon', (_req, res) => send(res, active?.runtime.icon.image));
app.get('/media/icon-light', (_req, res) => send(res, active?.runtime.iconLight?.image));
app.get('/media/:f/icon', (req, res) => {
  const hit = lookup(req, res);
  if (hit) send(res, hit.folder.icon.image);
});
app.get('/media/:f/:v/video', (req, res) => {
  const hit = lookup(req, res);
  if (hit) send(res, hit.video.src);
});
app.get('/media/:f/:v/captions', (req, res) => {
  const hit = lookup(req, res);
  if (hit) send(res, hit.video.captions, 'text/vtt; charset=utf-8');
});
app.get('/media/:f/:v/thumb', async (req, res) => {
  const hit = lookup(req, res);
  if (!hit) return;
  if (hit.video.thumbnail) return send(res, hit.video.thumbnail);
  send(res, await media.thumbnail(hit.video.src, hit.video.duration));
});

activate();
const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}/`;
  console.log(`Video kiosk settings: ${url}`);
  console.log(`Catalog: ${lastResult.errors.length ? 'not loaded (' + lastResult.errors[0] + ')' : 'loaded'}`);
  if (!media.available.ffmpeg) console.log('ffmpeg not found: the video list uses placeholder thumbnails.');
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Set a different port: PORT=3001 npm start` : err.message);
  process.exit(1);
});
