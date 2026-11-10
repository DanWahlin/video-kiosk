import { svg } from './icons.js';

// The catalog as the browser gets it: icons as SVG markup or image URLs, and every
// video file as a URL. The server and the static build both use this shape.
//   mediaUrl(file, route) -> URL for a video, captions, or thumbnail file
//   imageUrl(file, route) -> URL for an icon image
export function toClientCatalog(runtime, { mediaUrl, imageUrl, canMakeThumbnails = false }) {
  const icon = (ref, route) => (ref.octicon ? { svg: svg(ref.octicon) } : { url: imageUrl(ref.image, route) });
  return {
    title: runtime.title,
    subtitle: runtime.subtitle,
    icon: icon(runtime.icon, '/media/icon'),
    iconLight: runtime.iconLight ? icon(runtime.iconLight, '/media/icon-light') : null,
    folders: runtime.folders.map((f, fi) => ({
      title: f.title,
      description: f.description,
      icon: icon(f.icon, `/media/${fi}/icon`),
      videos: f.videos.map((v, vi) => {
        const base = `/media/${fi}/${vi}`;
        return {
          title: v.title,
          description: v.description,
          duration: v.duration,
          src: mediaUrl(v.src, `${base}/video`),
          captions: v.captions ? mediaUrl(v.captions, `${base}/captions`) : null,
          // Without a thumbnail file, only a server with ffmpeg can make one.
          thumbnail: v.thumbnail ? mediaUrl(v.thumbnail, `${base}/thumb`) : canMakeThumbnails ? mediaUrl('', `${base}/thumb`) : null,
        };
      }),
    })),
  };
}
