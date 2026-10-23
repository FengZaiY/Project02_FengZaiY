import { Readable } from 'node:stream';
import { check } from './util.mjs';
import { openAssetReader } from './asset-reader.mjs';

const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']);
export async function mediaResponse(store, id, range, method = 'GET') {
  check(['GET', 'HEAD'].includes(method), 'Unsupported media method');
  const reader = await openAssetReader(store, id, { mimeTypes: mediaTypes });
  const { record, handle, size } = reader;
  let streaming = false;
  try {
    const headers = { 'Content-Type': record.data.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
    let start = 0, end = size - 1;
    if (range) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!parts || (!parts[1] && !parts[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      if (parts[1]) { start = Number(parts[1]); end = parts[2] ? Math.min(Number(parts[2]), end) : end; }
      else start = Math.max(0, size - Number(parts[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    await reader.verify();
    if (method === 'HEAD' || size === 0) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = handle.createReadStream({ start, end, autoClose: true });
    stream.once('close', reader.release);
    const response = new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
    streaming = true; return response;
  } finally { if (!streaming) await reader.close(); }
}
