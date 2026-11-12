#!/usr/bin/env node
// Builds the video management API in dist-api/ for Azure Static Web Apps (managed functions).
// It copies api/, the catalog code in lib/, the schema, and the catalogs in static-site.json.
// The API uses those catalogs until a manager publishes a catalog for the first time.
//
//   npm run build:api && npm ci --omit=dev --prefix dist-api
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist-api');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'static-site.json'), 'utf8'));
const copy = (from, to = from) => fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true });

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of ['package.json', 'package-lock.json', 'host.json', 'src']) copy(`api/${f}`, f);
for (const f of ['catalog.js', 'client-catalog.js', 'icons.js', 'scan.js']) copy(`lib/${f}`);
copy('schema');
copy('catalogs/assets');
for (const file of site.catalogs) copy(file, `catalogs/${path.basename(file)}`);
console.log(`Built ${path.relative(ROOT, OUT)}/ with ${site.catalogs.length} catalogs`);
