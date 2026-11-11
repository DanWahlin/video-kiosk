#!/usr/bin/env node
// Checks the catalogs before a deploy (GitHub Actions runs it for each pull request and
// each push to main). Any problem stops the deploy, so the live site keeps its last good copy.
//
//   1. The catalogs in static-site.json pass the schema and have no warnings.
//   2. Each video, captions, thumbnail, and icon URL answers with the correct content type,
//      and each video accepts byte-range requests (the kiosk needs them to stream).
//   3. Each deployed catalog has the same text as its source catalog (for example
//      ignite-azure-11-2026.json and ignite-11-2026.json), so tools/azure-catalog.js does not
//      remove edits later.
//
//   npm run check
//   npm run check -- --offline    # skip the URL checks
import fs from 'node:fs';
import path from 'node:path';
import { readCatalogFile, validateCatalog, isUrl, isOcticonName } from '../lib/catalog.js';

const ROOT = path.join(import.meta.dirname, '..');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'static-site.json'), 'utf8'));
const offline = process.argv.includes('--offline');
const problems = [];
const fail = (file, msg) => problems.push(`${path.relative(ROOT, file)}: ${msg}`);

// "<kind> <URL>" -> what to check. A URL can be in more than one catalog; check it one time.
const urls = new Map();
const expect = (file, where, url, kind) => {
  if (!isUrl(url)) return fail(file, `${where}: "${url}" is not a URL. Run tools/azure-catalog.js first.`);
  const key = `${kind} ${url}`;
  if (!urls.has(key)) urls.set(key, { url, kind, where: `${path.relative(ROOT, file)} ${where}` });
};

const fileName = (p) => decodeURIComponent(path.basename(isUrl(p) ? new URL(p).pathname : p));
const iconText = (icon) => (icon && isOcticonName(icon) ? icon : icon ? fileName(icon) : '');

function compareText(deployed, source, file) {
  const diff = (where, a, b) => a !== b && fail(file, `${where} is "${a}" here but "${b}" in ${path.basename(source.file)}. Make the same change in both files.`);
  const d = deployed.catalog;
  const s = source.catalog;
  diff('title', d.title, s.title);
  diff('subtitle', d.subtitle ?? '', s.subtitle ?? '');
  diff('icon', iconText(d.icon), iconText(s.icon));
  diff('iconLight', iconText(d.iconLight), iconText(s.iconLight));
  if (d.folders.length !== s.folders.length) return diff('The number of folders', d.folders.length, s.folders.length);
  d.folders.forEach((df, f) => {
    const sf = s.folders[f];
    diff(`folders[${f}].title`, df.title, sf.title);
    diff(`folders[${f}].description`, df.description, sf.description);
    diff(`folders[${f}].icon`, iconText(df.icon), iconText(sf.icon));
    if (df.videos.length !== sf.videos.length) return diff(`The number of videos in folders[${f}]`, df.videos.length, sf.videos.length);
    df.videos.forEach((dv, v) => {
      const sv = sf.videos[v];
      const w = `folders[${f}].videos[${v}]`;
      diff(`${w} file`, fileName(dv.path), fileName(sv.path));
      diff(`${w}.title`, dv.title, sv.title);
      diff(`${w}.description`, dv.description, sv.description);
    });
  });
}

for (const rel of site.catalogs) {
  const file = path.join(ROOT, rel);
  const read = readCatalogFile(file);
  if (read.error) {
    fail(file, read.error);
    continue;
  }
  const { errors, warnings } = validateCatalog(read.catalog, { baseDir: read.baseDir });
  for (const e of errors) fail(file, e);
  for (const w of warnings) fail(file, w);
  if (errors.length) continue;

  const c = read.catalog;
  for (const [key, icon] of [['icon', c.icon], ['iconLight', c.iconLight]]) if (icon && isUrl(icon)) expect(file, key, icon, 'image');
  c.folders.forEach((folder, f) => {
    if (folder.icon && isUrl(folder.icon)) expect(file, `folders[${f}].icon`, folder.icon, 'image');
    folder.videos.forEach((video, v) => {
      const w = `folders[${f}].videos[${v}]`;
      expect(file, `${w}.path`, video.path, 'video');
      if (video.captions) expect(file, `${w}.captions`, video.captions, 'captions');
      if (video.thumbnail) expect(file, `${w}.thumbnail`, video.thumbnail, 'image');
    });
  });

  const sourceFile = file.replace(/-azure(?=-|\.json$)/, '');
  if (sourceFile !== file && fs.existsSync(sourceFile)) {
    const source = readCatalogFile(sourceFile);
    const { summary } = source.error ? {} : validateCatalog(source.catalog, { baseDir: source.baseDir });
    if (source.error) fail(sourceFile, source.error);
    else if (!summary) fail(sourceFile, 'does not pass the schema. Run npm run validate on it.');
    else compareText(read, source, file);
  }
}

const CONTENT_TYPES = { video: /^video\//, captions: /^text\/vtt/, image: /^image\// };

async function head(url) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
      if (res.status < 500 && res.status !== 429) return res;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.cause?.code ?? err.name ?? err.message;
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw new Error(`no answer after 4 tries (${last})`);
}

async function checkUrl({ url, kind, where }) {
  try {
    const res = await head(url);
    if (res.status !== 200) return problems.push(`${where}: HTTP ${res.status} for ${url}`);
    const type = res.headers.get('content-type') ?? '';
    if (!CONTENT_TYPES[kind].test(type)) problems.push(`${where}: content type is "${type}" for ${url}`);
    if (kind === 'video' && res.headers.get('accept-ranges') !== 'bytes') {
      problems.push(`${where}: the server does not accept byte ranges, so the video cannot stream (${url}). Check the storage account's default service version.`);
    }
  } catch (err) {
    problems.push(`${where}: ${err.message} for ${url}`);
  }
}

if (!offline) {
  const queue = [...urls.values()];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) await checkUrl(queue.shift());
  }));
}

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s) in the catalogs:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ ${site.catalogs.length} catalogs are correct${offline ? ' (URLs not checked)' : `, and ${urls.size} URLs answer correctly`}.`);
