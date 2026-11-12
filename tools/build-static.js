#!/usr/bin/env node
// Builds a static copy of the kiosk in dist/ for a static host such as Azure Static
// Web Apps. Every video in the catalogs must be a URL (see tools/azure-catalog.js).
// static-site.json lists the catalogs and the site's default settings.
//
//   npm run build:static                       # the catalogs in static-site.json
//   npm run build:static -- catalogs/x.json    # other catalogs
import fs from 'node:fs';
import path from 'node:path';
import { readCatalogFile, validateCatalog, resolveCatalog, isUrl } from '../lib/catalog.js';
import { toClientCatalog } from '../lib/client-catalog.js';
import { uiIcons } from '../lib/icons.js';
import { THEMES, IDLE_CHOICES, CAPTION_SIZES, normalizeSettings, kioskSettings } from '../lib/settings.js';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'static-site.json'), 'utf8'));
const files = process.argv.length > 2 ? process.argv.slice(2) : site.catalogs.map((f) => path.join(ROOT, f));

const writeJson = (rel, data) => {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
fs.cpSync(path.join(ROOT, 'schema'), path.join(DIST, 'schema'), { recursive: true });
const fonts = path.join(ROOT, 'node_modules/@fontsource-variable/mona-sans/files');
fs.mkdirSync(path.join(DIST, 'fonts'));
for (const f of fs.readdirSync(fonts).filter((f) => /-latin(-ext)?-wght-normal\.woff2$/.test(f))) fs.copyFileSync(path.join(fonts, f), path.join(DIST, 'fonts', f));
writeJson('icons.json', uiIcons());

const catalogs = [];
for (const file of files) {
  const read = readCatalogFile(file);
  if (read.error) throw new Error(read.error);
  const { errors, summary } = validateCatalog(read.catalog, { baseDir: read.baseDir });
  if (errors.length) throw new Error(`${file}:\n  ${errors.join('\n  ')}`);
  const name = path.basename(read.file, '.json');

  // Video files must already be on the web. Icon images are copied into the site.
  // mediaVersion in static-site.json goes on each media URL: a new value makes browsers skip
  // copies they stored before (for example, after files or storage settings change).
  const mediaUrl = (src) => {
    if (!isUrl(src)) throw new Error(`${file}: "${src}" is not a URL. Run tools/azure-catalog.js first.`);
    if (!site.mediaVersion) return src;
    const url = new URL(src);
    url.searchParams.set('v', String(site.mediaVersion));
    return url.href;
  };
  const imageUrl = (src) => {
    if (isUrl(src)) return src;
    const rel = `catalogs/assets/${path.basename(src)}`;
    fs.mkdirSync(path.join(DIST, 'catalogs/assets'), { recursive: true });
    fs.copyFileSync(src, path.join(DIST, rel));
    return `/${rel}`;
  };
  const client = toClientCatalog(resolveCatalog(read.catalog, read.baseDir), { mediaUrl, imageUrl });
  writeJson(`catalogs/${name}.json`, client);
  catalogs.push({ file: `/catalogs/${name}.json`, title: client.title, summary });
}

// Each browser starts with these settings and can change them on the settings page.
const defaults = kioskSettings(normalizeSettings(site.defaults));
// liveCatalogs: where Video management publishes the catalogs (see api/). The kiosk loads a
// published catalog first, and the copy in this build if there is none.
const liveCatalogs = process.env.LIVE_CATALOGS ?? site.liveCatalogs ?? null;
writeJson('kiosk.config.json', { themes: THEMES, idleChoices: IDLE_CHOICES, captionSizes: CAPTION_SIZES, defaults, catalogs, liveCatalogs, mediaVersion: site.mediaVersion ?? null });

// Video management: only people signed in with GitHub can open the page or call the API,
// and the API also checks the MANAGERS app setting. The other sign-in providers are off.
const storageOrigin = liveCatalogs ? new URL(liveCatalogs).origin : '';
const manageCsp = [
  "default-src 'self'",
  `connect-src 'self' ${storageOrigin}`,
  `img-src 'self' data: blob: ${storageOrigin}`,
  `media-src 'self' blob: ${storageOrigin}`,
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
writeJson('staticwebapp.config.json', {
  platform: { apiRuntime: 'node:22' },
  globalHeaders: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' },
  routes: [
    { route: '/.auth/login/aad', statusCode: 404 },
    { route: '/.auth/login/twitter', statusCode: 404 },
    { route: '/manage', redirect: '/manage.html', statusCode: 302 },
    { route: '/manage.html', allowedRoles: ['authenticated'], headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': manageCsp } },
    { route: '/api/manage/*', allowedRoles: ['authenticated'] },
    { route: '/kiosk.config.json', headers: { 'Cache-Control': 'no-cache' } },
    { route: '/catalogs/*.json', headers: { 'Cache-Control': 'no-cache' } },
  ],
  responseOverrides: {
    401: { redirect: '/.auth/login/github?post_login_redirect_uri=/manage.html', statusCode: 302 },
  },
});
console.log(`Built ${path.relative(ROOT, DIST)}/ with ${catalogs.map((c) => `${c.title} (${c.summary.videos} videos)`).join(', ')}`);
