#!/usr/bin/env node
// Validates a kiosk catalog file: npm run validate -- path/to/catalog.json
import { readCatalogFile, validateCatalog } from '../lib/catalog.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run validate -- <catalog.json> [more.json]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  const read = readCatalogFile(file);
  if (read.error) {
    console.log(`✖ ${file}\n  ERROR ${read.error}`);
    failed = true;
    continue;
  }
  const { errors, warnings, summary } = validateCatalog(read.catalog, { baseDir: read.baseDir });
  console.log(`${errors.length ? '✖' : '✔'} ${read.file}`);
  if (summary) console.log(`  ${summary.folders} folders, ${summary.videos} videos (${summary.playable} found on disk)`);
  for (const e of errors) console.log(`  ERROR ${e}`);
  for (const w of warnings) console.log(`  WARN  ${w}`);
  failed ||= errors.length > 0;
}
process.exit(failed ? 1 : 0);
