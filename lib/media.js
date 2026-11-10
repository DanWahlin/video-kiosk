import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const SEARCH_DIRS = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function findTool(name, envVar) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of SEARCH_DIRS) {
    const p = dir && path.join(dir, exe);
    try {
      if (p) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

// A small queue so a long list does not start dozens of ffmpeg processes at once.
function limiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => (waiting.push({ fn, resolve, reject }), next()));
}

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

export function createMediaTools(cacheDir) {
  const ffmpeg = findTool('ffmpeg', 'FFMPEG_PATH');
  const ffprobe = findTool('ffprobe', 'FFPROBE_PATH');
  const thumbDir = path.join(cacheDir, 'thumbs');
  const durationFile = path.join(cacheDir, 'durations.json');
  const queue = limiter(4);
  const inFlight = new Map();
  let durations = {};
  try {
    durations = JSON.parse(fs.readFileSync(durationFile, 'utf8'));
  } catch {
    // No cache yet.
  }

  const fileKey = (file) => {
    try {
      const st = fs.statSync(file);
      return `${file}|${st.size}|${st.mtimeMs}`;
    } catch {
      return null; // The file was moved or deleted after validation.
    }
  };

  async function duration(file) {
    if (!ffprobe || /^https?:/i.test(file)) return null;
    const key = fileKey(file);
    if (!key) return null;
    if (durations[key]) return durations[key];
    const out = await queue(() => run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])).catch(() => '');
    const secs = parseFloat(out);
    if (!(secs > 0)) return null;
    durations[key] = secs;
    return secs;
  }

  // Reads durations for the videos that do not have one. Saves the cache one time at the end.
  async function fillDurations(videos) {
    await Promise.all(videos.filter((v) => !v.duration).map(async (v) => (v.duration = await duration(v.src))));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(durationFile, JSON.stringify(durations));
  }

  async function thumbnail(file, secs) {
    if (!ffmpeg || /^https?:/i.test(file)) return null;
    const key = fileKey(file);
    if (!key) return null;
    const out = path.join(thumbDir, crypto.createHash('sha1').update(key).digest('hex') + '.jpg');
    if (fs.existsSync(out)) return out;
    if (!inFlight.has(out)) {
      const at = secs ? Math.min(Math.max(secs * 0.15, 1), 30) : 3;
      inFlight.set(
        out,
        queue(async () => {
          fs.mkdirSync(thumbDir, { recursive: true });
          const tmp = out.replace(/\.jpg$/, `.${process.pid}.tmp.jpg`);
          await run(ffmpeg, ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', tmp]);
          fs.renameSync(tmp, out);
          return out;
        })
          .catch(() => null)
          .finally(() => inFlight.delete(out)),
      );
    }
    return inFlight.get(out);
  }

  return { available: { ffmpeg: !!ffmpeg, ffprobe: !!ffprobe }, fillDurations, thumbnail };
}
