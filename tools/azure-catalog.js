#!/usr/bin/env node
// Makes a copy of a catalog whose files are in Azure Blob Storage (or any web server).
// Each local file under --videos gets the same relative path under --base-url, and the
// tool adds a thumbnail (made with ffmpeg, saved under --thumbs) and the video length.
//
//   node tools/azure-catalog.js --catalog catalogs/universe-on-the-road-11-2026.json \
//     --base-url https://<account>.blob.core.windows.net/videos \
//     --out catalogs/universe-on-the-road-azure-11-2026.json
//
// Then upload the videos/ folder and the thumbnails folder to the same container
// (see README.md, "Deploy to Azure").
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readCatalogFile, validateCatalog, resolvePath, isUrl } from '../lib/catalog.js';
import { createMediaTools } from '../lib/media.js';

const ROOT = path.join(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    catalog: { type: 'string' },
    'base-url': { type: 'string' },
    out: { type: 'string' },
    videos: { type: 'string', default: path.join(ROOT, 'videos') },
    thumbs: { type: 'string', default: path.join(ROOT, 'data', 'azure', 'thumbnails') },
  },
});
if (!args.catalog || !args['base-url'] || !args.out) {
  console.error('Usage: node tools/azure-catalog.js --catalog <file> --base-url <url> --out <file> [--videos <dir>] [--thumbs <dir>]');
  process.exit(2);
}

const read = readCatalogFile(args.catalog);
if (read.error) throw new Error(read.error);
const { catalog, baseDir } = read;
const videosDir = path.resolve(args.videos);
const thumbsDir = path.resolve(args.thumbs);
const outDir = path.dirname(path.resolve(args.out));
const baseUrl = args['base-url'].replace(/\/+$/, '');
const media = createMediaTools(path.join(ROOT, 'data', 'cache'));
if (!media.available.ffmpeg || !media.available.ffprobe) throw new Error('ffmpeg and ffprobe are required.');

// "GitHub Copilot - X/a b.mp4" -> "<base>/GitHub%20Copilot%20-%20X/a%20b.mp4"
const relToVideos = (abs) => {
  const rel = path.relative(videosDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Not inside ${videosDir}: ${abs}`);
  return rel.split(path.sep);
};
const urlFor = (parts) => `${baseUrl}/${parts.map(encodeURIComponent).join('/')}`;
const toUrl = (p) => (isUrl(p) ? p : urlFor(relToVideos(resolvePath(p, baseDir))));
// Icon images stay local (the static build copies them); fix their paths for the new location.
const moveLocal = (p) => (!p || isUrl(p) || !/\.[a-z]+$/i.test(p) ? p : path.relative(outDir, resolvePath(p, baseDir)).split(path.sep).join('/'));

const videos = catalog.folders.flatMap((f) => f.videos.map((v) => ({ v, src: resolvePath(v.path, baseDir) })));
const local = videos.filter((x) => !isUrl(x.src)).map((x) => ({ src: x.src, duration: x.v.duration }));
await media.fillDurations(local);
const durations = new Map(local.map((x) => [x.src, x.duration]));

let thumbs = 0;
for (const { v, src } of videos) {
  if (isUrl(src)) continue;
  v.duration ??= Math.round((durations.get(src) ?? 0) * 100) / 100 || undefined;
  if (!v.thumbnail) {
    const made = await media.thumbnail(src, v.duration);
    if (!made) throw new Error(`Could not make a thumbnail for ${src}`);
    const parts = relToVideos(src);
    parts[parts.length - 1] = parts.at(-1).replace(/\.[^.]+$/, '.jpg');
    const dest = path.join(thumbsDir, ...parts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(made, dest);
    v.thumbnail = `${baseUrl}/thumbnails/${parts.map(encodeURIComponent).join('/')}`;
    thumbs++;
  } else v.thumbnail = toUrl(v.thumbnail);
  v.path = toUrl(v.path);
  if (v.captions) v.captions = toUrl(v.captions);
}

catalog.icon = moveLocal(catalog.icon);
if (catalog.iconLight) catalog.iconLight = moveLocal(catalog.iconLight);
for (const f of catalog.folders) if (f.icon) f.icon = moveLocal(f.icon);
catalog.$schema = path.relative(outDir, path.join(ROOT, 'schema', 'kiosk-catalog.schema.json')).split(path.sep).join('/');

const result = validateCatalog(catalog, { baseDir: outDir });
if (result.errors.length) {
  for (const e of result.errors) console.error(`ERROR ${e}`);
  process.exit(1);
}
fs.writeFileSync(args.out, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${args.out}: ${result.summary.folders} folders, ${result.summary.videos} videos, ${thumbs} thumbnails in ${thumbsDir}`);
