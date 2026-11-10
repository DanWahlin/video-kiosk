#!/usr/bin/env node
// Builds a kiosk catalog from a SharePoint folder listing (read with WorkIQ),
// GitHub project board draft items (read with `gh project item-list`), and a local
// copy of the videos. This script only reads its inputs. It never calls SharePoint
// or GitHub, so it cannot change them.
//
// Usage:
//   node tools/sharepoint-catalog.js --listing listing.json --local <videos dir> --out catalogs/x.json
//        [--board board.json] [--metadata video-metadata.json]
//
// See .github/skills/kiosk-catalog-from-sharepoint/SKILL.md for the full procedure.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { quickXorHashFile } from '../lib/quickxorhash.js';
import { validateCatalog } from '../lib/catalog.js';
import { splitFolderName, prettifyFileName, questionTitle, VIDEO_EXTENSIONS } from '../lib/scan.js';

const { values: args } = parseArgs({
  options: {
    listing: { type: 'string' },
    local: { type: 'string' },
    out: { type: 'string' },
    board: { type: 'string' },
    metadata: { type: 'string' },
    'hash-cache': { type: 'string', default: path.join(import.meta.dirname, '..', 'data', 'cache', 'hashes.json') },
  },
});
for (const k of ['listing', 'local', 'out']) {
  if (!args[k]) {
    console.error(`Missing --${k}. Usage: node tools/sharepoint-catalog.js --listing <file> --local <dir> --out <file> [--board <file>] [--metadata <file>]`);
    process.exit(2);
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const listing = readJson(args.listing);
const board = args.board ? readJson(args.board).items ?? [] : [];
const metadata = args.metadata ? readJson(args.metadata).videos ?? {} : {};
const outDir = path.dirname(path.resolve(args.out));

// Accept raw Graph driveItems or the compact { name, hash, uniqueId } form.
const normalize = (it) => ({
  name: it.name,
  hash: it.hash ?? it.file?.hashes?.quickXorHash ?? null,
  uniqueId: (it.uniqueId ?? it.sharepointIds?.listItemUniqueId ?? '').toLowerCase() || null,
});
const ext = (n) => path.extname(n).toLowerCase();
const base = (n) => path.basename(n, path.extname(n));

// ---- Local files, indexed by QuickXorHash (cached by path + size + mtime) ----
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (VIDEO_EXTENSIONS.has(ext(e.name)) || ext(e.name) === '.vtt') out.push(p);
  }
  return out;
}
const cacheFile = args['hash-cache'];
const cache = fs.existsSync(cacheFile) ? readJson(cacheFile) : {};
const localRoot = path.resolve(args.local);
const localFiles = walk(localRoot);
const byHash = new Map();
let hashed = 0;
for (const file of localFiles) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (!cache[key]) {
    cache[key] = await quickXorHashFile(file);
    hashed++;
  }
  if (!byHash.has(cache[key])) byHash.set(cache[key], []);
  byHash.get(cache[key]).push(file);
}
fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify(cache));
console.log(`Local files: ${localFiles.length} (${hashed} hashed now, ${localFiles.length - hashed} from cache)`);

// Prefer a local copy inside the folder that has the same name as the SharePoint folder.
function findLocal(spFolder, item) {
  const inFolder = (f) => path.basename(path.dirname(f)) === spFolder;
  const hits = item.hash ? byHash.get(item.hash) ?? [] : [];
  if (hits.length) return { file: hits.find(inFolder) ?? hits[0], how: 'hash' };
  // SharePoint names can carry a sort prefix ("a-question-x.mp4" for local "question-x.mp4").
  const folderFiles = localFiles.filter(inFolder);
  const exact = folderFiles.find((f) => path.basename(f) === item.name);
  if (exact) return { file: exact, how: 'name' };
  const suffix = folderFiles
    .filter((f) => item.name.endsWith('-' + path.basename(f)))
    .sort((a, b) => path.basename(b).length - path.basename(a).length)[0];
  if (suffix) return { file: suffix, how: 'name-suffix' };
  return null;
}

// ---- Board draft items: title + "Description:" section ----
const boardEntries = board.map((it) => {
  const body = it.content?.body ?? '';
  // The description section ends at the next "Field:" line, if there is one.
  const after = body.split(/^Description:\s*$/m)[1] ?? '';
  const desc = after.split(/^(?:Type|File|SharePoint ID|Booth folder|Video URL):/m)[0].trim();
  return {
    title: (it.content?.title ?? it.title ?? '').trim(),
    description: desc.replace(/\s*\n\s*/g, ' '),
    uniqueId: (body.match(/SharePoint ID:\s*([0-9a-f-]{36})/i)?.[1] ?? it['video Content URL']?.match(/UniqueId=([0-9a-f-]{36})/i)?.[1] ?? '').toLowerCase(),
    file: body.match(/^File:\s*(.+)$/m)?.[1]?.trim() ?? '',
  };
});
function boardFor(item) {
  return (
    (item.uniqueId && boardEntries.find((b) => b.uniqueId === item.uniqueId)) ||
    boardEntries.find((b) => b.file && b.file === item.name) ||
    null
  );
}

// ---- Build the catalog ----
const report = { hash: 0, name: 0, 'name-suffix': 0, missing: [], board: 0, boardByContent: 0, metadata: 0, fallback: [] };
const rel = (f) => {
  const r = path.relative(outDir, f);
  return r.startsWith('..' + path.sep + '..' + path.sep) ? f : r.split(path.sep).join('/');
};

const prepared = listing.folders.map((folder) => {
  const items = folder.items.map(normalize);
  const videos = items.filter((i) => VIDEO_EXTENSIONS.has(ext(i.name)));
  const vtts = items.filter((i) => ext(i.name) === '.vtt');
  return { folder, videos, vtts };
});

// Board item for each SharePoint video, then share it with copies that have the same content.
const boardByHash = new Map();
for (const { videos } of prepared) {
  for (const v of videos) {
    v.board = boardFor(v);
    if (v.board && v.hash) boardByHash.set(v.hash, v.board);
  }
}

const catalog = {
  $schema: listing.$schema ?? '../schema/kiosk-catalog.schema.json',
  title: listing.title,
  ...(listing.subtitle ? { subtitle: listing.subtitle } : {}),
  icon: listing.icon ?? 'video',
  ...(listing.iconLight ? { iconLight: listing.iconLight } : {}),
  folders: [],
};

for (const { folder, videos, vtts } of prepared) {
  const names = splitFolderName(folder.name);
  const out = {
    title: folder.title ?? names.title,
    description: folder.description ?? names.description,
    ...(folder.icon ? { icon: folder.icon } : {}),
    videos: [],
  };
  for (const v of videos) {
    const local = findLocal(folder.name, v);
    if (!local) {
      report.missing.push(`${folder.name}/${v.name}`);
      continue;
    }
    report[local.how]++;
    if (local.how !== 'hash') console.log(`  NOTE  ${folder.name}/${v.name}: matched by ${local.how} (the local copy differs from SharePoint)`);

    let meta = v.board;
    if (meta) report.board++;
    else if ((meta = v.hash && boardByHash.get(v.hash))) report.boardByContent++;
    else if ((meta = metadata[base(v.name)] ?? metadata[base(local.file)])) report.metadata++;
    else {
      meta = { title: prettifyFileName(v.name), description: '' };
      report.fallback.push(`${folder.name}/${v.name}`);
    }

    const vtt = vtts.find((c) => base(c.name) === base(v.name));
    const vttLocal = (vtt && findLocal(folder.name, vtt)?.file) ||
      [local.file.replace(/\.[^.]+$/, '.vtt')].find((f) => fs.existsSync(f));

    out.videos.push({
      title: questionTitle(meta.title),
      description: meta.description ?? '',
      path: rel(local.file),
      ...(vttLocal ? { captions: rel(vttLocal) } : {}),
    });
  }
  catalog.folders.push(out);
}

const result = validateCatalog(catalog, { baseDir: outDir });
const total = catalog.folders.reduce((n, f) => n + f.videos.length, 0);
if (result.errors.length) {
  // Keep the current catalog when the new one is not valid.
  console.log(`\nNot written: the new catalog has errors. ${args.out} did not change.`);
} else {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = `${args.out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n');
  fs.renameSync(tmp, args.out);
  console.log(`\nWrote ${args.out}: ${catalog.folders.length} folders, ${total} videos`);
}
console.log(`Local match: ${report.hash} by hash, ${report.name} by name, ${report['name-suffix']} by name suffix`);
console.log(`Titles: ${report.board} from the board, ${report.boardByContent} from a board item for the same content, ${report.metadata} from metadata, ${report.fallback.length} from the file name`);
for (const m of report.fallback) console.log(`  NEEDS METADATA  ${m}`);
for (const m of report.missing) console.log(`  NOT LOCAL (skipped)  ${m}`);
for (const e of result.errors) console.log(`  ERROR  ${e}`);
for (const w of result.warnings) console.log(`  WARN   ${w}`);
process.exit(result.errors.length ? 1 : 0);
