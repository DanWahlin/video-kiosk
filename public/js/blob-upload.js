// Uploads a file to Azure Blob Storage with a link from the API (a SAS URL that can only
// create that one file). Large files go in 8 MB blocks, 4 at a time, and each block tries
// again after a network error. "If-None-Match: *" makes sure that no file is replaced.
const BLOCK = 8 * 1024 * 1024;
const PARALLEL = 4;
const TRIES = 4;

async function put(url, body, headers, signal) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'PUT', body, headers, signal });
    } catch (err) {
      if (signal?.aborted) throw new Error('The upload stopped.');
      if (attempt >= TRIES) throw new Error(`The upload stopped: ${err.message}. Check the network, then try again.`);
    }
    if (res?.ok) return;
    if (res && res.status < 500 && res.status !== 408 && res.status !== 429) {
      const code = res.headers.get('x-ms-error-code') ?? '';
      throw new Error(code === 'BlobAlreadyExists' ? 'A file with this name is already in storage.' : res.status === 403 ? 'The upload link is not valid any more. Try again.' : `Blob Storage refused the upload (HTTP ${res.status} ${code}).`);
    }
    if (res && attempt >= TRIES) throw new Error(`Blob Storage did not accept the upload (HTTP ${res.status}). Try again.`);
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
}

export async function uploadFile(link, blob, { onProgress, signal, cacheControl = 'public,max-age=86400' } = {}) {
  const props = { 'x-ms-blob-content-type': link.contentType, 'x-ms-blob-cache-control': cacheControl };
  if (blob.size <= BLOCK) {
    await put(link.upload, blob, { 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*', ...props }, signal);
    onProgress?.(1);
    return;
  }
  const count = Math.ceil(blob.size / BLOCK);
  // A new prefix for each upload, so two uploads to the same name cannot mix their blocks.
  const tag = crypto.randomUUID().slice(0, 8);
  const ids = Array.from({ length: count }, (_, i) => btoa(`${tag}-${String(i).padStart(6, '0')}`));
  let next = 0;
  let sent = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      const part = blob.slice(i * BLOCK, Math.min(blob.size, (i + 1) * BLOCK));
      await put(`${link.upload}&comp=block&blockid=${encodeURIComponent(ids[i])}`, part, {}, signal);
      sent += part.size;
      onProgress?.(sent / blob.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
  const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
  await put(`${link.upload}&comp=blocklist`, xml, { 'Content-Type': 'application/xml', 'If-None-Match': '*', ...props }, signal);
}
