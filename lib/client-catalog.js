import { svg } from './icons.js';

// "Visual Studio & VS Code" -> "visual-studio-and-vs-code"
const slugify = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

// The file name without its folder, extension, or query: ".../budget-delegation.mp4?v=3" -> "budget-delegation"
const fileStem = (src) => {
  const pathPart = /^https?:\/\//i.test(src) ? decodeURIComponent(new URL(src).pathname) : src;
  return pathPart.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
};

// Makes each ID unique in its list by adding -2, -3, and so on.
function unique(ids) {
  const used = new Set();
  return ids.map((id) => {
    let next = id;
    for (let n = 2; used.has(next); n++) next = `${id}-${n}`;
    used.add(next);
    return next;
  });
}

// Link IDs (#kiosk/<folder>/<video>). A folder ID is its title, plus its description when
// another folder has the same title. A video ID is its file name, so it does not change
// when the title changes.
function folderIds(folders) {
  const count = new Map();
  for (const f of folders) count.set(slugify(f.title), (count.get(slugify(f.title)) ?? 0) + 1);
  return unique(folders.map((f) => (count.get(slugify(f.title)) > 1 ? slugify(`${f.title} ${f.description}`) : slugify(f.title))));
}

// The catalog as the browser gets it: icons as SVG markup or image URLs, and every
// video file as a URL. The server and the static build both use this shape.
//   mediaUrl(file, route) -> URL for a video, captions, or thumbnail file
//   imageUrl(file, route) -> URL for an icon image
export function toClientCatalog(runtime, { mediaUrl, imageUrl, canMakeThumbnails = false }) {
  const icon = (ref, route) => (ref.octicon ? { svg: svg(ref.octicon) } : { url: imageUrl(ref.image, route) });
  const ids = folderIds(runtime.folders);
  return {
    title: runtime.title,
    subtitle: runtime.subtitle,
    icon: icon(runtime.icon, '/media/icon'),
    iconLight: runtime.iconLight ? icon(runtime.iconLight, '/media/icon-light') : null,
    folders: runtime.folders.map((f, fi) => {
      const videoIds = unique(f.videos.map((v) => slugify(fileStem(v.src))));
      return {
        id: ids[fi],
        title: f.title,
        description: f.description,
        icon: icon(f.icon, `/media/${fi}/icon`),
        videos: f.videos.map((v, vi) => {
          const base = `/media/${fi}/${vi}`;
          return {
            id: videoIds[vi],
            title: v.title,
            description: v.description,
            duration: v.duration,
            src: mediaUrl(v.src, `${base}/video`),
            captions: v.captions ? mediaUrl(v.captions, `${base}/captions`) : null,
            // Without a thumbnail file, only a server with ffmpeg can make one.
            thumbnail: v.thumbnail ? mediaUrl(v.thumbnail, `${base}/thumb`) : canMakeThumbnails ? mediaUrl('', `${base}/thumb`) : null,
          };
        }),
      };
    }),
  };
}
