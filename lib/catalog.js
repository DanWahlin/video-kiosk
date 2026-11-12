import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import octicons from '@primer/octicons';
import { VIDEO_EXTENSIONS } from './scan.js';

const schema = JSON.parse(fs.readFileSync(new URL('../schema/kiosk-catalog.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

export const DEFAULT_FOLDER_ICON = 'file-directory';
export function isUrl(s) {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    return Boolean(new URL(s).host);
  } catch {
    return false;
  }
}
export const isOcticonName = (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
export const octiconExists = (s) => Object.hasOwn(octicons, s);
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function resolvePath(p, baseDir) {
  if (isUrl(p)) return p;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(baseDir, p);
}

// "/folders/2/videos/0/path" -> "folders[2].videos[0].path"
function readablePointer(pointer) {
  if (!pointer) return '(root)';
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), '');
}

function schemaMessage(e) {
  const where = readablePointer(e.instancePath);
  switch (e.keyword) {
    case 'required':
      return `${where}: the "${e.params.missingProperty}" property is required`;
    case 'additionalProperties':
      return `${where}: unknown property "${e.params.additionalProperty}"`;
    case 'pattern':
      return where.endsWith('icon')
        ? `${where}: must be an Octicon name (for example "shield-check") or an image path`
        : where.endsWith('captions')
          ? `${where}: must be a WebVTT (.vtt) file`
          : `${where}: ${e.message}`;
    default:
      return `${where}: ${e.message}`;
  }
}

export function readCatalogFile(file) {
  const abs = resolvePath(file, process.cwd());
  if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
  if (!isFile(abs)) return { error: `Not a file: ${abs}` };
  try {
    return { catalog: JSON.parse(fs.readFileSync(abs, 'utf8')), baseDir: path.dirname(abs), file: abs };
  } catch (err) {
    return { error: err instanceof SyntaxError ? `The file is not valid JSON: ${err.message}` : `Cannot read ${abs}: ${err.code ?? err.message}` };
  }
}

function checkIcon(icon, where, baseDir, warnings, errors) {
  if (icon === undefined) return;
  if (isOcticonName(icon)) {
    if (!octiconExists(icon)) errors.push(`${where}: "${icon}" is not an Octicon name (see https://primer.style/octicons)`);
  } else if (!isUrl(icon) && !isFile(resolvePath(icon, baseDir))) {
    warnings.push(`${where}: image not found (${resolvePath(icon, baseDir)}); the kiosk uses a default icon`);
  }
}

const exists = (p, baseDir) => isUrl(p) || isFile(resolvePath(p, baseDir));

// Validates against the JSON schema, then checks that the files exist.
// Errors stop the kiosk from loading the catalog. Warnings do not: the kiosk hides
// videos that cannot play and folders that have no videos left. The kiosk also hides
// videos with "enabled": false, without a warning.
export function validateCatalog(catalog, { baseDir }) {
  const errors = [];
  const warnings = [];
  if (!validateSchema(catalog)) {
    const seen = new Set();
    for (const e of validateSchema.errors) {
      const msg = schemaMessage(e);
      if (!seen.has(msg)) errors.push(msg), seen.add(msg);
    }
    return { errors, warnings, summary: null };
  }

  checkIcon(catalog.icon, 'icon', baseDir, warnings, errors);
  checkIcon(catalog.iconLight, 'iconLight', baseDir, warnings, errors);
  let videos = 0;
  let playable = 0;
  const titles = new Map();
  catalog.folders.forEach((folder, f) => {
    const fw = `folders[${f}]`;
    checkIcon(folder.icon, `${fw}.icon`, baseDir, warnings, errors);
    const key = `${folder.title}\u0000${folder.description}`.toLowerCase();
    if (titles.has(key)) warnings.push(`${fw}: same title and description as folders[${titles.get(key)}]`);
    else titles.set(key, f);

    let folderPlayable = 0;
    folder.videos.forEach((video, v) => {
      const vw = `${fw}.videos[${v}]`;
      videos++;
      if (video.enabled === false) return;
      if (!exists(video.path, baseDir)) {
        warnings.push(`${vw}.path: file not found (${resolvePath(video.path, baseDir)}); the kiosk hides this video`);
        return;
      }
      const ext = path.extname(isUrl(video.path) ? new URL(video.path).pathname : video.path).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) warnings.push(`${vw}.path: "${ext || 'no extension'}" files may not play in the browser`);
      if (video.captions && !exists(video.captions, baseDir)) warnings.push(`${vw}.captions: file not found; the video plays without captions`);
      if (video.thumbnail && !exists(video.thumbnail, baseDir)) warnings.push(`${vw}.thumbnail: file not found; the kiosk makes a thumbnail`);
      folderPlayable++;
      playable++;
    });
    if (!folderPlayable) warnings.push(`${fw}: no video can play (files not found, or all videos are disabled); the kiosk hides "${folder.title}"`);
  });
  if (!playable) {
    const allOff = catalog.folders.every((f) => f.videos.every((v) => v.enabled === false));
    errors.push(allOff ? 'Every video is turned off. Turn on at least one video.' : 'No video files were found. Make sure that the "path" values are correct.');
  }
  return { errors, warnings, summary: { folders: catalog.folders.length, videos, playable } };
}

function resolveIcon(icon, baseDir, fallback) {
  if (icon && isOcticonName(icon)) return { octicon: octiconExists(icon) ? icon : fallback };
  if (icon && (isUrl(icon) || isFile(resolvePath(icon, baseDir)))) return { image: resolvePath(icon, baseDir) };
  return { octicon: fallback };
}

// The runtime model: absolute paths, and only videos that can play.
export function resolveCatalog(catalog, baseDir) {
  const opt = (p) => (p && exists(p, baseDir) ? resolvePath(p, baseDir) : null);
  const folders = catalog.folders
    .map((folder) => ({
      title: folder.title,
      description: folder.description ?? '',
      icon: resolveIcon(folder.icon, baseDir, DEFAULT_FOLDER_ICON),
      videos: folder.videos
        .filter((v) => v.enabled !== false && exists(v.path, baseDir))
        .map((v) => ({
          title: v.title,
          description: v.description ?? '',
          src: resolvePath(v.path, baseDir),
          captions: opt(v.captions),
          thumbnail: opt(v.thumbnail),
          duration: v.duration ?? null,
        })),
    }))
    .filter((f) => f.videos.length);
  return {
    title: catalog.title,
    subtitle: catalog.subtitle ?? '',
    icon: resolveIcon(catalog.icon, baseDir, 'video'),
    iconLight: catalog.iconLight ? resolveIcon(catalog.iconLight, baseDir, 'video') : null,
    folders,
  };
}
