import { createReadStream } from 'node:fs';

// Microsoft QuickXorHash (the hash OneDrive and SharePoint report in file.hashes.quickXorHash).
// Each byte n is XORed into a 160-bit circular register at bit offset (11 * n) mod 160.
// Bytes with the same n mod 160 land at the same offset, so they are XORed together first.
const WIDTH = 160;
const SHIFT = 11;

export function createQuickXorHash() {
  const lanes = new Uint8Array(WIDTH);
  let lane = 0;
  let length = 0;
  return {
    update(buf) {
      for (let i = 0; i < buf.length; i++) {
        lanes[lane] ^= buf[i];
        if (++lane === WIDTH) lane = 0;
      }
      length += buf.length;
    },
    digest() {
      const out = new Uint8Array(WIDTH / 8);
      for (let r = 0; r < WIDTH; r++) {
        if (!lanes[r]) continue;
        const bit = (SHIFT * r) % WIDTH;
        const v = lanes[r] << (bit & 7);
        out[bit >> 3] ^= v & 0xff;
        out[((bit >> 3) + 1) % out.length] ^= v >> 8;
      }
      let len = BigInt(length);
      for (let i = 0; i < 8; i++) {
        out[12 + i] ^= Number(len & 0xffn);
        len >>= 8n;
      }
      return Buffer.from(out).toString('base64');
    },
  };
}

export function quickXorHashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createQuickXorHash();
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest()));
  });
}
