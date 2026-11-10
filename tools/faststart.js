#!/usr/bin/env node
// Finds MP4 files whose index (the "moov" box) is at the end, and writes a copy with the
// index at the start (ffmpeg -movflags +faststart, no re-encoding). A browser then starts
// streaming the video at once, without first fetching the end of the file.
// The copies go to --out with the same relative paths, ready to upload to Blob Storage.
// The files in --videos do not change, so they still match SharePoint.
//
//   node tools/faststart.js [--videos videos] [--out data/azure/faststart]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = path.join(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    videos: { type: 'string', default: path.join(ROOT, 'videos') },
    out: { type: 'string', default: path.join(ROOT, 'data', 'azure', 'faststart') },
  },
});

// True when the "mdat" box (the media data) comes before "moov" (the index).
function indexAtEnd(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    let sawData = false;
    while (pos + 8 <= size) {
      fs.readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      if (boxSize === 0) boxSize = size - pos;
      if (type === 'moov') return sawData;
      if (type === 'mdat') sawData = true;
      if (boxSize < 8) return false; // Not a valid MP4 box list.
      pos += boxSize;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(mp4|m4v|mov)$/i.test(e.name) ? [p] : [];
  });

const videosDir = path.resolve(args.videos);
const outDir = path.resolve(args.out);
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'].find((p) => p === 'ffmpeg' || fs.existsSync(p));
const fixed = [];
for (const file of walk(videosDir)) {
  if (!indexAtEnd(file)) continue;
  const dest = path.join(outDir, path.relative(videosDir, file));
  const done = fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(file).mtimeMs;
  if (!done) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp.mp4`;
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, dest);
  }
  fixed.push(path.relative(videosDir, file));
}
console.log(`${fixed.length} videos need the index at the start. Copies are in ${path.relative(ROOT, outDir) || outDir}:`);
for (const f of fixed) console.log(`  ${f}`);
