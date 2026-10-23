import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { check, noSymlink, sha } from './util.mjs';

const caches = new WeakMap();
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

export async function openAssetReader(store, id, { maxBytes = Infinity, mimeTypes } = {}) {
  const record = store.get(id), local = store.assetLocation(id);
  check(record?.type === 'asset' && !record.deleted && !record.conflict && local, '附件尚未下载或不可用');
  check(!mimeTypes || mimeTypes.has(record.data.mime), '此附件格式不可嵌入');
  check(record.data.size <= maxBytes, '文件超过预览大小上限，请使用本机应用查看');
  noSymlink(local.path);
  store.activeAssetReads ||= new Map();
  store.activeAssetReads.set(id, (store.activeAssetReads.get(id) || 0) + 1);
  let handle, released = false;
  const release = () => {
    if (released) return;
    released = true;
    const count = (store.activeAssetReads.get(id) || 1) - 1;
    if (count > 0) store.activeAssetReads.set(id, count); else store.activeAssetReads.delete(id);
  };
  const close = async () => { try { await handle?.close(); } finally { release(); } };
  try {
    handle = await fs.promises.open(local.path, 'r');
    const stat = await handle.stat({ bigint: true }), identity = stamp(stat);
    check(stat.isFile() && stat.size === BigInt(record.data.size), '附件完整性校验失败');
    check(maxBytes === Infinity || stat.size <= BigInt(maxBytes), '文件超过预览大小上限，请使用本机应用查看');
    const assertUnchanged = async () => {
      noSymlink(local.path);
      const actual = await handle.stat({ bigint: true }), named = await fs.promises.stat(local.path, { bigint: true });
      noSymlink(local.path);
      const current = store.get(id), binding = store.assetLocation(id);
      check(current && !current.deleted && !current.conflict && current.heads.join() === record.heads.join()
        && binding?.path === local.path, '附件状态或位置已变化，请重新打开');
      check(stamp(actual) === identity && stamp(named) === identity, '附件在读取期间发生变化，请重新打开');
    };
    await assertUnchanged();
    const verify = async () => {
      let cache = caches.get(store);
      if (!cache) { cache = new Map(); caches.set(store, cache); }
      const key = `${local.path}\0${record.data.sha256}`, cacheable = stat.ino !== 0n && stat.mtimeNs !== undefined && stat.ctimeNs !== undefined;
      if (!cacheable || cache.get(key) !== identity) {
        cache.delete(key);
        const hash = createHash('sha256');
        if (stat.size > 0n) for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: Number(stat.size) - 1 })) hash.update(chunk);
        check(hash.digest('hex') === record.data.sha256, '附件完整性校验失败');
      }
      await assertUnchanged();
      if (cacheable) {
        cache.delete(key); cache.set(key, identity);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
      }
    };
    return { record, handle, size: Number(stat.size), verify, assertUnchanged, release, close };
  } catch (error) { await close(); throw error; }
}

export async function readAssetContent(store, id, maxBytes = 24 * 1024 * 1024) {
  const reader = await openAssetReader(store, id, { maxBytes });
  try {
    // Bound allocation and reads by the checked size, even if another program grows
    // the file during the read. Verify the exact bytes returned to the renderer.
    const data = Buffer.alloc(reader.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await reader.handle.read(data, offset, data.length - offset, offset);
      check(bytesRead > 0, '附件读取不完整'); offset += bytesRead;
    }
    await reader.assertUnchanged();
    check(sha(data) === reader.record.data.sha256, '附件完整性校验失败');
    return { mime: reader.record.data.mime, data: data.toString('base64'), filename: reader.record.data.filename };
  } finally { await reader.close(); }
}
