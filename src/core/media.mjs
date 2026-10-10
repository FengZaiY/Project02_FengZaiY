import fs from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { check, noSymlink } from './util.mjs';

const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']);
export async function mediaResponse(store, id, range, method = 'GET') {
  check(['GET', 'HEAD'].includes(method), 'Unsupported media method');
  const record = store.get(id), local = store.assetLocation(id);
  check(record?.type === 'asset' && !record.deleted && !record.conflict && local, '附件尚未下载或不可用');
  check(mediaTypes.has(record.data.mime), '此附件格式不可嵌入');
  noSymlink(local.path);
  store.activeAssetReads ||= new Map();
  store.activeAssetReads.set(id, (store.activeAssetReads.get(id) || 0) + 1);
  let streaming = false, released = false, handle;
  const release = () => { if (!released) { released = true; store.activeAssetReads.set(id, Math.max(0, (store.activeAssetReads.get(id) || 1) - 1)); } };
  try {
    handle = await fs.promises.open(local.path, 'r');
    const stat = await handle.stat();
    check(stat.isFile() && stat.size === record.data.size, '附件完整性校验失败');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    check(hash.digest('hex') === record.data.sha256, '附件完整性校验失败');
    const size = stat.size;
    const headers = { 'Content-Type': record.data.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
    let start = 0, end = size - 1;
    if (range) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!parts || (!parts[1] && !parts[2])) { await handle.close(); return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } }); }
      if (parts[1]) { start = Number(parts[1]); end = parts[2] ? Math.min(Number(parts[2]), end) : end; }
      else start = Math.max(0, size - Number(parts[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        await handle.close(); return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    if (method === 'HEAD' || size === 0) { await handle.close(); return new Response(null, { status: range ? 206 : 200, headers }); }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    stream.once('close', release); stream.once('error', release); streaming = true;
    return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
  } catch (error) { await handle?.close(); throw error; }
  finally { if (!streaming) release(); }
}
