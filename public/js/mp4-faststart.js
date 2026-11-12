// Moves an MP4 file's index (the "moov" box) in front of the media data, so a browser can
// start a video before it downloads the whole file. tools/faststart.js does the same with
// ffmpeg. This version runs in the browser and reads only the box headers and the index;
// the media data stays in the original file (Blob slices).
//
//   const fixed = await faststart(file); // the same file if the index is already first

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

const type = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

// The top-level boxes: { type, start, size }.
async function topBoxes(file) {
  const boxes = [];
  let at = 0;
  while (at < file.size) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    if (head.byteLength < 8) throw new Error('The file ends inside a box header. It is not a complete MP4 file.');
    let size = head.getUint32(0);
    if (size === 1) {
      if (head.byteLength < 16) throw new Error('The file ends inside a box header. It is not a complete MP4 file.');
      size = Number(head.getBigUint64(8));
    } else if (size === 0) size = file.size - at;
    if (size < 8 || at + size > file.size) throw new Error('A box size is not correct. It is not a complete MP4 file.');
    boxes.push({ type: type(head, 4), start: at, size });
    at += size;
  }
  return boxes;
}

// Adds `shift` to each chunk offset (stco and co64 boxes) that points into the data
// before the old index position.
function patchOffsets(view, start, end, moovStart, shift) {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) size = end - at;
    if (size < 8 || at + size > end) throw new Error('The MP4 index is not correct.');
    const t = type(view, at + 4);
    if (CONTAINERS.has(t)) patchOffsets(view, at + head, at + size, moovStart, shift);
    else if (t === 'stco') {
      const count = view.getUint32(at + head + 4);
      for (let k = 0, p = at + head + 8; k < count; k++, p += 4) {
        const o = view.getUint32(p);
        if (o >= moovStart) continue;
        if (o + shift > 0xffffffff) throw new Error('The video is too large to change in the browser. Run tools/faststart.js on it.');
        view.setUint32(p, o + shift);
      }
    } else if (t === 'co64') {
      const count = view.getUint32(at + head + 4);
      for (let k = 0, p = at + head + 8; k < count; k++, p += 8) {
        const o = view.getBigUint64(p);
        if (o < BigInt(moovStart)) view.setBigUint64(p, o + BigInt(shift));
      }
    } else if (t === 'cmov') throw new Error('The MP4 index is compressed. Run tools/faststart.js on it.');
    at += size;
  }
}

export async function faststart(file) {
  const boxes = await topBoxes(file);
  const moov = boxes.find((b) => b.type === 'moov');
  const firstMdat = boxes.find((b) => b.type === 'mdat');
  if (!moov || !firstMdat) throw new Error('The file is not an MP4 video (it has no index or no media data).');
  if (moov.start < firstMdat.start) return { file, changed: false };

  const index = new DataView(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
  patchOffsets(index, 8, moov.size, moov.start, moov.size);
  // [boxes before the first mdat] [moov] [the other boxes, in order]
  const before = boxes.filter((b) => b.start < firstMdat.start);
  const after = boxes.filter((b) => b.start >= firstMdat.start && b !== moov);
  const parts = [...before.map((b) => file.slice(b.start, b.start + b.size)), index, ...after.map((b) => file.slice(b.start, b.start + b.size))];
  return { file: new Blob(parts, { type: file.type || 'video/mp4' }), changed: true };
}
