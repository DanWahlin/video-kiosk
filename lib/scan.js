import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv']);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// "GitHub Copilot - Desktop App, CLI, SDK" -> { title: "GitHub Copilot", description: "Desktop App, CLI, SDK" }
export function splitFolderName(name) {
  const i = name.indexOf(' - ');
  return i > 0
    ? { title: name.slice(0, i).trim(), description: name.slice(i + 3).trim() }
    : { title: name.trim(), description: '' };
}

const ACRONYMS = new Set(['ai', 'api', 'aks', 'cd', 'ci', 'cli', 'csv', 'ghas', 'ghec', 'ghes', 'id', 'ide', 'json', 'llm', 'mcp', 'pr', 'prs', 'qr', 'sdk', 'sso', 'ui', 'url', 'ux', 'vm', 'vs', 'yaml']);
const SPELLINGS = { github: 'GitHub', vscode: 'VS Code', devops: 'DevOps', codeql: 'CodeQL', finops: 'FinOps', javascript: 'JavaScript', typescript: 'TypeScript' };

// "02-copilot_cli-overview.mp4" -> "Copilot CLI Overview"
export function prettifyFileName(file) {
  const words = path
    .basename(file, path.extname(file))
    .replace(/^\d+[\s._-]+/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const word = (w) => SPELLINGS[w.toLowerCase()] ?? (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  return words.map(word).join(' ') || file;
}

function listVideos(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => collator.compare(a.name, b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listVideos(p));
    else if (VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function readSidecar(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function toVideo(file) {
  const stem = file.slice(0, -path.extname(file).length);
  const side = readSidecar(stem + '.json');
  const video = {
    title: typeof side.title === 'string' && side.title ? side.title : prettifyFileName(file),
    description: typeof side.description === 'string' ? side.description : '',
    path: file,
  };
  if (fs.existsSync(stem + '.vtt')) video.captions = stem + '.vtt';
  return video;
}

// Builds a catalog from a folder: each subfolder is a kiosk folder, and each video file
// in it (at any depth) is a video. An optional "<video>.json" next to a video can set
// "title" and "description".
export function scanFolder(root, { title, subtitle } = {}) {
  const abs = path.resolve(root);
  const folders = [];
  const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  for (const e of entries.sort((a, b) => collator.compare(a.name, b.name))) {
    const videos = listVideos(path.join(abs, e.name)).map(toVideo);
    if (videos.length) folders.push({ ...splitFolderName(e.name), videos });
  }
  const loose = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => toVideo(path.join(abs, e.name)));
  if (loose.length) folders.push({ title: 'More videos', description: '', videos: loose });

  const catalog = { title: title?.trim() || splitFolderName(path.basename(abs)).title, icon: 'video', folders };
  if (subtitle?.trim()) catalog.subtitle = subtitle.trim();
  return catalog;
}
