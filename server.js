import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import octicons from '@primer/octicons';
import { readCatalogFile, validateCatalog, resolveCatalog, resolvePath, isUrl } from './lib/catalog.js';
import { scanFolder } from './lib/scan.js';
import { createSettingsStore, THEMES, IDLE_CHOICES } from './lib/settings.js';
import { createMediaTools } from './lib/media.js';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const CATALOG_DIR = path.join(ROOT, 'catalogs');
const UI_ICONS = ['arrow-left', 'check', 'check-circle-fill', 'chevron-left', 'chevron-right', 'file', 'file-directory', 'home', 'play', 'screen-full', 'video', 'x', 'alert', 'sync', 'download', 'comment'];

const settingsStore = createSettingsStore(path.join(ROOT, 'data', 'settings.json'));
const media = createMediaTools(path.join(ROOT, 'data', 'cache'));

// ---- Catalog source ----
let active = null; // { raw, runtime, ready, version }
let lastResult = { errors: ['Pick a JSON file or a folder.'], warnings: [], summary: null };

function loadSource(source) {
  if (!source?.path) return { errors: ['Pick a JSON file or a folder.'], warnings: [], summary: null };
  if (source.type === 'folder') {
    const dir = resolvePath(source.path, os.homedir());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { errors: [`Folder not found: ${dir}`], warnings: [], summary: null };
    const catalog = scanFolder(dir, source);
    if (!catalog.folders.length) return { errors: ['No subfolders with video files were found in this folder.'], warnings: [], summary: null };
    return { catalog, baseDir: dir, ...validateCatalog(catalog, { baseDir: dir }) };
  }
  const read = readCatalogFile(resolvePath(source.path, os.homedir()));
  if (read.error) return { errors: [read.error], warnings: [], summary: null };
  return { catalog: read.catalog, baseDir: read.baseDir, ...validateCatalog(read.catalog, { baseDir: read.baseDir }) };
}

function activate() {
  let result;
  try {
    result = loadSource(settingsStore.get().source);
  } catch (err) {
    // A bad saved source must never stop the server: the settings page has to open to fix it.
    result = { errors: [`Cannot read the source: ${err.code ?? err.message}`], warnings: [], summary: null };
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

function svg(name) {
  const icon = octicons[name];
  return icon ? icon.toSVG({ height: 24, 'aria-hidden': 'true' }) : '';
}
const iconForClient = (icon, url) => (icon.octicon ? { svg: svg(icon.octicon) } : { url });

function settingsResponse() {
  return {
    settings: settingsStore.get(),
    themes: THEMES,
    idleChoices: IDLE_CHOICES,
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

app.get('/api/ui-icons', (_req, res) => res.json(Object.fromEntries(UI_ICONS.map((n) => [n, svg(n)]))));

app.get('/api/settings', adminOnly, (_req, res) => res.json(settingsResponse()));

app.put('/api/settings', adminOnly, (req, res) => {
  const before = settingsStore.get();
  const patch = { ...req.body };
  if (patch.source) {
    const next = { ...before.source, ...patch.source };
    if (next.path) patch.recent = [{ type: next.type, path: next.path }, ...before.recent.filter((r) => r.path !== next.path)];
  }
  const after = settingsStore.update(patch);
  if (JSON.stringify(after.source) !== JSON.stringify(before.source)) activate();
  res.json(settingsResponse());
});

app.post('/api/reload', adminOnly, (_req, res) => {
  activate();
  res.json(settingsResponse());
});

app.get('/api/browse', adminOnly, (req, res) => {
  const wantFiles = req.query.files === 'json';
  let dir = typeof req.query.dir === 'string' && req.query.dir ? resolvePath(req.query.dir, os.homedir()) : os.homedir();
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => e.isDirectory() || (wantFiles && e.isFile() && e.name.toLowerCase().endsWith('.json')))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), kind: e.isDirectory() ? 'dir' : 'json' }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
    const shortcuts = [
      { name: 'Home', path: os.homedir() },
      { name: 'Desktop', path: path.join(os.homedir(), 'Desktop') },
      { name: 'Documents', path: path.join(os.homedir(), 'Documents') },
      { name: 'App catalogs', path: CATALOG_DIR },
      ...(process.platform === 'darwin' ? [{ name: 'Drives', path: '/Volumes' }] : []),
    ].filter((s) => fs.existsSync(s.path));
    res.json({ dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries, shortcuts });
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
  await Promise.race([active.ready, new Promise((r) => setTimeout(r, 8000))]);
  const { runtime, version } = active;
  const s = settingsStore.get();
  res.json({
    version,
    settings: { theme: s.theme, idleSeconds: s.idleSeconds, attractMode: s.attractMode, captions: s.captions },
    title: runtime.title,
    subtitle: runtime.subtitle,
    icon: iconForClient(runtime.icon, `/media/icon?v=${version}`),
    iconLight: runtime.iconLight ? iconForClient(runtime.iconLight, `/media/icon-light?v=${version}`) : null,
    folders: runtime.folders.map((f, fi) => ({
      title: f.title,
      description: f.description,
      icon: iconForClient(f.icon, `/media/${fi}/icon?v=${version}`),
      videos: f.videos.map((v, vi) => {
        const base = `/media/${fi}/${vi}`;
        return {
          title: v.title,
          description: v.description,
          duration: v.duration,
          src: isUrl(v.src) ? v.src : `${base}/video?v=${version}`,
          captions: v.captions ? (isUrl(v.captions) ? v.captions : `${base}/captions?v=${version}`) : null,
          thumbnail: v.thumbnail && isUrl(v.thumbnail) ? v.thumbnail : media.available.ffmpeg || v.thumbnail ? `${base}/thumb?v=${version}` : null,
        };
      }),
    })),
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
