#!/usr/bin/env node
// After a deploy, checks that the live site serves the files in dist/. It tries again for
// up to 5 minutes, because a new deploy can take some time to reach every server.
//
//   npm run check:live -- https://<site>.azurestaticapps.net
//   (with no URL, it uses "siteUrl" in static-site.json)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'static-site.json'), 'utf8'));
const base = (process.argv[2] || site.siteUrl || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: npm run check:live -- <site URL>');
  process.exit(2);
}

const files = ['index.html', 'kiosk.config.json', ...fs.readdirSync(path.join(DIST, 'catalogs')).filter((f) => f.endsWith('.json')).map((f) => `catalogs/${f}`)];
const DEADLINE = Date.now() + 5 * 60_000;

async function differs(rel) {
  try {
    const res = await fetch(`${base}/${rel}?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return `HTTP ${res.status}`;
    return (await res.text()) === fs.readFileSync(path.join(DIST, rel), 'utf8') ? null : 'an older copy';
  } catch (err) {
    return err.cause?.code ?? err.name ?? err.message;
  }
}

let pending = files;
for (;;) {
  const results = await Promise.all(pending.map(async (rel) => [rel, await differs(rel)]));
  pending = results.filter(([, problem]) => problem).map(([rel]) => rel);
  if (!pending.length) break;
  if (Date.now() > DEADLINE) {
    console.error(`✖ ${base} does not serve the new build:\n  ${results.filter(([, p]) => p).map(([rel, p]) => `${rel}: ${p}`).join('\n  ')}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`✔ ${base} serves the new build (${files.length} files checked).`);
