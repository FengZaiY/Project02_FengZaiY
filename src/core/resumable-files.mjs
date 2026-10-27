import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CHUNK_BYTES, assetAAD, chunkName, localAsset, validateAssets } from './sync-objects.mjs';
import { check, hashFile, noSymlink, sha, now } from './util.mjs';
import { centralAssetPath } from './material-center.mjs';

export function diskSpace(directory) {
  let target = path.resolve(directory);
  while (!fs.existsSync(target)) {
    const parent = path.dirname(target); check(parent !== target, '无法检查磁盘空间'); target = parent;
  }
  noSymlink(target);
  const info = fs.statfsSync(target);
  return { freeBytes: info.bavail * info.bsize };
}

export async function describeAsset(store, asset, known) {
  if (known && known.size === asset.size) {
    validateAssets([known]);
    return { ...known, ids: asset.ids };
  }
  const file = await localAsset(store, asset);
  check(file, '原件尚未在本机或已知同步内容中找到，请先补全原件');
  const handle = await fs.promises.open(file, 'r'), fullHash = createHash('sha256'), chunks = [];
  try {
    for (let index = 0; index < Math.max(1, Math.ceil(asset.size / CHUNK_BYTES)); index++) {
      const size = Math.min(CHUNK_BYTES, asset.size - index * CHUNK_BYTES), data = Buffer.alloc(size);
      const { bytesRead } = await handle.read(data, 0, size, index * CHUNK_BYTES);
      check(bytesRead === size, '原件在空间预估期间发生变化');
      fullHash.update(data); chunks.push({ name: chunkName(asset.hash, index), hash: sha(data), size });
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { await handle.close(); }
  check(fullHash.digest('hex') === asset.hash, '原件在空间预估期间发生变化');
  return { ...asset, chunks };
}

export async function assetChunk(store, asset, index) {
  const chunk = asset.chunks[index];
  for (const id of asset.ids) {
    const location = store.assetLocation(id);
    if (!location || !fs.existsSync(location.path)) continue;
    noSymlink(location.path);
    const handle = await fs.promises.open(location.path, 'r');
    try {
      const data = Buffer.alloc(chunk.size), result = await handle.read(data, 0, chunk.size, index * CHUNK_BYTES);
      check(result.bytesRead === chunk.size && sha(data) === chunk.hash, '原件内容已变化，请重新导入后发布');
      return data;
    } finally { await handle.close(); }
  }
  throw new Error('当前批次需要的原件未在本机，请先通过百度客户端下载对应分块');
}

// The partial file survives failures. Each fsynced chunk is checkpointed; a crash can only
// cause uncheckpointed bytes to be re-read. Already assembled chunks need no cloud access.
export async function receiveResumable(channel, store, asset, options = {}) {
  validateAssets([asset]);
  const key = `v3Receive:${asset.hash}`, fingerprint = sha(JSON.stringify(asset.chunks));
  const existing = await localAsset(store, asset);
  if (existing) { store.local(key, null); return existing; }
  const directory = path.join(store.directory, 'received-objects'); noSymlink(directory);
  fs.mkdirSync(directory, { recursive: true });
  const staging = path.join(directory, asset.hash), target = store.personalSystem ? centralAssetPath(store, asset.hash) : staging;
  const temp = `${staging}.v3.partial`;
  noSymlink(target); noSymlink(temp);
  if (fs.existsSync(target)) {
    check(fs.statSync(target).size === asset.size && await hashFile(target) === asset.hash, '本地同名原件损坏，请先移开损坏副本');
    store.local(key, null);
    return target;
  }
  let progress = store.local(key);
  if (!progress || progress.fingerprint !== fingerprint || !fs.existsSync(temp)) {
    progress = { hash: asset.hash, fingerprint, completed: 0, bytes: 0, size: asset.size, at: now() };
  }
  const handle = await fs.promises.open(temp, fs.existsSync(temp) ? 'r+' : 'wx+', 0o600);
  let offset = 0;
  try {
    // Check only the prefix we intend to trust. A damaged prefix resumes at the first bad chunk.
    for (let i = 0; i < progress.completed; i++) {
      const chunk = asset.chunks[i], data = Buffer.alloc(chunk.size);
      const { bytesRead } = await handle.read(data, 0, chunk.size, offset);
      if (bytesRead !== chunk.size || sha(data) !== chunk.hash) { progress.completed = i; break; }
      offset += chunk.size;
    }
    await handle.truncate(offset);
    progress.bytes = offset; store.local(key, progress);
    const space = options.space || diskSpace, reserve = options.reserveBytes ?? 64 * 1024 * 1024;
    for (let i = progress.completed; i < asset.chunks.length; i++) {
      check(!options.paused?.(), '接收已暂停，可从已校验分块继续', 'PAUSED');
      const chunk = asset.chunks[i];
      check(space(directory).freeBytes - reserve >= chunk.size, '接收空间不足，已保留组装进度', 'SPACE');
      const data = channel.read(chunk.name, assetAAD(asset, i), CHUNK_BYTES);
      check(data.length === chunk.size && sha(data) === chunk.hash, '附件分块不完整或校验失败');
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written, offset + written);
        check(result.bytesWritten > 0, '原件写入中断'); written += result.bytesWritten;
      }
      offset += data.length; await handle.sync();
      progress = { ...progress, completed: i + 1, bytes: offset, at: now() };
      store.local(key, progress);
      await options.afterChunk?.(i);
      await new Promise(resolve => setImmediate(resolve));
    }
    await handle.close();
    check(fs.statSync(temp).size === asset.size && await hashFile(temp) === asset.hash, '原文件整体校验失败');
    if (store.personalSystem) {
      noSymlink(target);
      try { await fs.promises.link(temp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      check(fs.statSync(target).size === asset.size && await hashFile(target) === asset.hash, '集中目录原件已变化，未覆盖');
      await fs.promises.unlink(temp);
    } else await fs.promises.rename(temp, target);
    store.local(key, null);
    return target;
  } finally { await handle.close().catch(() => {}); }
}
