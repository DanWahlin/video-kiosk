// The live catalogs in Azure Blob Storage.
//
//   <ADMIN_CONTAINER>/<name>/current.json          The catalog as managers edit it (private)
//   <ADMIN_CONTAINER>/<name>/versions/<id>.json     Each published version (private)
//   <CATALOGS_CONTAINER>/<name>.json               The catalog as kiosks load it (public)
//
// Before the first publish, a catalog starts from the copy in the repo (catalogs/ in this API).
import fs from 'node:fs';
import path from 'node:path';
import { BlobServiceClient, BlobSASPermissions, SASProtocol, StorageSharedKeyCredential, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { validateCatalog, resolveCatalog, isUrl, isOcticonName } from '../lib/catalog.js';
import { toClientCatalog } from '../lib/client-catalog.js';

const SEEDS = path.join(import.meta.dirname, '..', 'catalogs');
const MAX_CATALOG_BYTES = 2_000_000;
const MAX_VIDEO_BYTES = 4 * 1024 ** 3;
const UPLOAD_MINUTES = 60;
const JSON_TYPE = { blobContentType: 'application/json; charset=utf-8' };
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let blob;
function storage() {
  if (blob) return blob;
  const conn = process.env.STORAGE_CONNECTION_STRING;
  if (!conn) throw new HttpError(500, 'The STORAGE_CONNECTION_STRING app setting is missing.');
  const parts = Object.fromEntries(conn.split(';').filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const service = BlobServiceClient.fromConnectionString(conn);
  const names = {
    videos: process.env.VIDEOS_CONTAINER || 'videos',
    catalogs: process.env.CATALOGS_CONTAINER || 'catalogs',
    admin: process.env.ADMIN_CONTAINER || 'catalog-admin',
  };
  blob = {
    service,
    credential: new StorageSharedKeyCredential(parts.AccountName, parts.AccountKey),
    videos: service.getContainerClient(names.videos),
    catalogs: service.getContainerClient(names.catalogs),
    admin: service.getContainerClient(names.admin),
    videosBase: service.getContainerClient(names.videos).url.replace(/\/+$/, ''),
  };
  return blob;
}

// ---- Catalog names: only the catalogs that the site was built with ----
export function catalogNames() {
  return fs
    .readdirSync(SEEDS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}
function checkName(name) {
  if (!catalogNames().includes(name)) throw new HttpError(404, `There is no catalog named "${name}".`);
}
const seed = (name) => JSON.parse(fs.readFileSync(path.join(SEEDS, `${name}.json`), 'utf8'));

// The content, ETag, and metadata come from one response, so they always match.
async function readJson(client) {
  try {
    const res = await client.download();
    const chunks = [];
    for await (const chunk of res.readableStreamBody) chunks.push(chunk);
    return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: res.etag, metadata: res.metadata ?? {} };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

const meta = (s) => encodeURIComponent(String(s ?? '').slice(0, 300));
const unmeta = (s) => {
  try {
    return decodeURIComponent(s ?? '');
  } catch {
    return '';
  }
};

// The catalog that managers edit: the published one, or the repo copy before the first publish.
export async function getCatalog(name) {
  checkName(name);
  const cur = await readJson(storage().admin.getBlockBlobClient(`${name}/current.json`));
  if (!cur) return { catalog: seed(name), etag: null, published: null, videosBase: storage().videosBase };
  await syncLive(name, cur);
  return {
    catalog: cur.data,
    etag: cur.etag,
    published: { at: unmeta(cur.metadata?.publishedat), by: unmeta(cur.metadata?.publishedby), version: unmeta(cur.metadata?.version) },
    videosBase: storage().videosBase,
  };
}

// ---- Validation ----
function catalogUrls(c) {
  const urls = [];
  for (const icon of [c.icon, c.iconLight]) if (icon && isUrl(icon)) urls.push({ url: icon, kind: 'image' });
  for (const f of c.folders ?? []) {
    if (f.icon && isUrl(f.icon)) urls.push({ url: f.icon, kind: 'image' });
    for (const v of f.videos ?? []) {
      if (v.path) urls.push({ url: v.path, kind: 'video' });
      if (v.captions) urls.push({ url: v.captions, kind: 'captions' });
      if (v.thumbnail) urls.push({ url: v.thumbnail, kind: 'image' });
    }
  }
  return urls;
}

const CONTENT_TYPES = { video: /^video\//, captions: /^text\/vtt/, image: /^image\// };
async function checkUrl({ url, kind }) {
  let res;
  try {
    res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
  } catch {
    return `No answer from ${url}`;
  }
  if (res.status !== 200) return `HTTP ${res.status} for ${url}`;
  const type = res.headers.get('content-type') ?? '';
  if (!CONTENT_TYPES[kind].test(type)) return `The content type of ${url} is "${type}"`;
  if (kind === 'video' && res.headers.get('accept-ranges') !== 'bytes') return `${url} does not accept byte ranges, so it cannot stream`;
  return null;
}

// Every new URL must be in the videos container and answer with the correct content type.
// URLs that the previous version had stay valid. Icons are Octicon names, or the logo
// files that the repo has (catalogs/assets).
async function validate(catalog, previous) {
  const { errors } = validateCatalog(catalog, { baseDir: SEEDS });
  if (errors.length) throw new HttpError(400, `The catalog is not valid:\n${errors.join('\n')}`);
  const assets = new Set(fs.readdirSync(path.join(SEEDS, 'assets')).map((f) => `assets/${f}`));
  const iconOk = (icon) => icon === undefined || isOcticonName(icon) || assets.has(icon) || catalogUrls(previous).some((u) => u.url === icon);
  const icons = [catalog.icon, catalog.iconLight, ...catalog.folders.map((f) => f.icon)];
  const badIcon = icons.find((i) => !iconOk(i));
  if (badIcon) throw new HttpError(400, `The icon "${badIcon}" is not an Octicon name or a logo in catalogs/assets.`);

  const known = new Set(catalogUrls(previous).map((u) => u.url));
  const base = `${storage().videosBase}/`;
  const added = [...new Map(catalogUrls(catalog).filter((u) => !known.has(u.url)).map((u) => [`${u.kind} ${u.url}`, u])).values()];
  const outside = added.find((u) => !u.url.startsWith(base));
  if (outside) throw new HttpError(400, `${outside.url} is not in ${base}. Upload the file on this page.`);
  const problems = (await Promise.all(added.map(checkUrl))).filter(Boolean);
  if (problems.length) throw new HttpError(400, `Some files cannot be used:\n${problems.join('\n')}`);
}

// The catalog as kiosks load it. Logo files are in the site's /catalogs/assets folder.
export function toKioskCatalog(catalog) {
  return toClientCatalog(resolveCatalog(catalog, SEEDS), { mediaUrl: (src) => src, imageUrl: (src) => `/catalogs/assets/${path.basename(src)}` });
}

// ---- Publish ----
// etag: the version that the manager edited (null for the repo copy). If someone published
// after that, the publish stops, so no change is lost.
export async function publish(name, catalog, { etag, user, note }) {
  checkName(name);
  if (!catalog || typeof catalog !== 'object') throw new HttpError(400, 'Send the catalog.');
  const text = JSON.stringify(catalog, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new HttpError(413, 'The catalog is too large.');

  const before = await getCatalog(name);
  if ((before.etag ?? null) !== (etag ?? null)) throw new HttpError(409, 'Someone published a change after you opened this catalog. Reload the page to get it, then make your change again.');
  await validate(catalog, before.catalog);
  toKioskCatalog(catalog); // Fails here, before any write, if the kiosk copy cannot be made.

  const at = new Date().toISOString();
  const version = `${at.replace(/[:.]/g, '-')}_${user.replace(/[^A-Za-z0-9-]/g, '')}`;
  const metadata = { publishedat: meta(at), publishedby: meta(user), version: meta(version), note: meta(note) };
  const { admin } = storage();

  // The conditional write is first: if two people publish at the same time, one gets an
  // error. Then the history copy and the copy that kiosks load.
  let newEtag;
  try {
    const res = await admin.getBlockBlobClient(`${name}/current.json`).upload(text, Buffer.byteLength(text), {
      blobHTTPHeaders: { ...JSON_TYPE, blobCacheControl: 'no-cache' },
      metadata,
      conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
    });
    newEtag = res.etag;
  } catch (err) {
    if (err.statusCode === 412 || err.statusCode === 409) throw new HttpError(409, 'Someone published a change after you opened this catalog. Reload the page to get it, then make your change again.');
    throw err;
  }
  await admin.getBlockBlobClient(`${name}/versions/${version}.json`).upload(text, Buffer.byteLength(text), { blobHTTPHeaders: JSON_TYPE, metadata });
  await syncLive(name);
  return { etag: newEtag, published: { at, by: user, version } };
}

// Makes the copy that kiosks load match current.json. It always copies the newest
// current.json, and the write fails if another write changed the copy first (then it tries
// again), so an older catalog never replaces a newer one. Opening a catalog on the page
// also runs it, so a publish that stopped after current.json is completed later.
async function syncLive(name, cur) {
  const { admin, catalogs } = storage();
  const live = catalogs.getBlockBlobClient(`${name}.json`);
  for (let attempt = 0; attempt < 3; attempt++) {
    cur = attempt === 0 && cur ? cur : await readJson(admin.getBlockBlobClient(`${name}/current.json`));
    if (!cur) return;
    const version = unmeta(cur.metadata.version);
    let props = null;
    try {
      props = await live.getProperties();
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    if (props && unmeta(props.metadata?.version) === version) return;
    const body = JSON.stringify({ ...toKioskCatalog(cur.data), version });
    try {
      await live.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { ...JSON_TYPE, blobCacheControl: 'no-cache' },
        metadata: { version: meta(version) },
        conditions: props ? { ifMatch: props.etag } : { ifNoneMatch: '*' },
      });
      return;
    } catch (err) {
      if (err.statusCode !== 412 && err.statusCode !== 409) throw err;
    }
  }
  throw new HttpError(503, 'The kiosk copy of the catalog is busy. Try again.');
}

export async function listVersions(name) {
  checkName(name);
  const versions = [];
  for await (const b of storage().admin.listBlobsFlat({ prefix: `${name}/versions/`, includeMetadata: true })) {
    versions.push({
      id: b.name.slice(`${name}/versions/`.length, -5),
      at: unmeta(b.metadata?.publishedat),
      by: unmeta(b.metadata?.publishedby),
      note: unmeta(b.metadata?.note),
    });
  }
  return versions.sort((a, b) => b.at.localeCompare(a.at));
}

// A version from the history, or "repo" for the copy in the repo.
export async function getVersion(name, id) {
  checkName(name);
  if (id === 'repo') return seed(name);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, 'Not a version ID.');
  const v = await readJson(storage().admin.getBlockBlobClient(`${name}/versions/${id}.json`));
  if (!v) throw new HttpError(404, 'There is no such version.');
  return v.data;
}

// ---- Uploads ----
// The browser uploads straight to Blob Storage with a short-lived link for each new file.
// A link has only the Create permission for its one file name: it can upload a new file
// (in blocks, too), but it cannot read, list, delete, or replace a file.
const slug = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';

export function checkFolder(folder) {
  const f = String(folder ?? '').trim();
  if (!f || f.length > 150) throw new HttpError(400, 'The storage folder name must have 1 to 150 characters.');
  if (/[\\/\u0000-\u001f\u007f]|^\.+$/.test(f) || f.toLowerCase() === 'thumbnails') throw new HttpError(400, `"${f}" cannot be a storage folder name.`);
  return f;
}

export async function createUpload({ folder, fileName, size, captions }) {
  folder = checkFolder(folder);
  const ext = path.extname(String(fileName ?? '')).toLowerCase();
  if (!VIDEO_TYPES[ext]) throw new HttpError(400, 'The video must be an .mp4, .m4v, or .webm file.');
  if (!(Number.isFinite(size) && size > 0 && size <= MAX_VIDEO_BYTES)) throw new HttpError(400, 'The video must be smaller than 4 GB.');

  const { videos, videosBase, credential } = storage();
  const base = path.basename(String(fileName));
  const stem = slug(base.slice(0, base.length - ext.length));
  let name = stem;
  const taken = async (n) =>
    (await Promise.all([`${folder}/${n}${ext}`, `thumbnails/${folder}/${n}.jpg`, `${folder}/${n}.vtt`].map((b) => videos.getBlockBlobClient(b).exists()))).some(Boolean);
  for (let n = 2; await taken(name); n++) name = `${stem}-${n}`;

  const startsOn = new Date(Date.now() - 5 * 60_000);
  const expiresOn = new Date(Date.now() + UPLOAD_MINUTES * 60_000);
  const link = (blobName, contentType) => {
    const sas = generateBlobSASQueryParameters(
      { containerName: videos.containerName, blobName, permissions: BlobSASPermissions.parse('c'), startsOn, expiresOn, protocol: SASProtocol.Https },
      credential,
    ).toString();
    const url = `${videosBase}/${blobName.split('/').map(encodeURIComponent).join('/')}`;
    return { url, upload: `${url}?${sas}`, contentType };
  };
  return {
    video: link(`${folder}/${name}${ext}`, VIDEO_TYPES[ext]),
    thumbnail: link(`thumbnails/${folder}/${name}.jpg`, 'image/jpeg'),
    captions: captions ? link(`${folder}/${name}.vtt`, 'text/vtt; charset=utf-8') : null,
  };
}
