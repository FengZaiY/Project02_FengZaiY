import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { atomicWrite, canonical, check, hashFile, isHash, noSymlink, sha, uuid } from './util.mjs';

export const CHUNK_BYTES = 4 * 1024 * 1024;
const MAGIC = Buffer.from('SSOBJ002');
const LIMIT = 128 * 1024 * 1024;

// Binary authenticated envelopes: AAD binds every object to its logical identity.
export function sealBinary(data, key, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
export function openBinary(data, key, aad) {
  check(data.length >= 36 && data.subarray(0, 8).equals(MAGIC), 'Invalid encrypted object');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(8, 20));
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(data.subarray(20, 36));
  return Buffer.concat([cipher.update(data.subarray(36)), cipher.final()]);
}

export class DirectoryChannel {
  constructor(root, key) { this.root = root; this.key = key; }
  capabilities() { return { provider: 'baidu-folder', cloudStatus: false, remoteListing: false, cloudOnlyEviction: false }; }
  file(name) {
    check(typeof name === 'string' && /^[a-z0-9.-]{1,160}$/.test(name), 'Invalid object name');
    const file = path.join(this.root, name); noSymlink(file); return file;
  }
  names(suffix) {
    noSymlink(this.root);
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter(name => name.endsWith(suffix) && /^[a-z0-9.-]{1,160}$/.test(name)).sort();
  }
  read(name, aad, limit = LIMIT) {
    const file = this.file(name), stat = fs.statSync(file);
    check(stat.isFile() && stat.size <= limit + 36, 'Object size exceeds limit');
    return openBinary(fs.readFileSync(file), this.key, aad);
  }
  write(name, data, aad) {
    const file = this.file(name);
    if (fs.existsSync(file)) {
      check(sha(this.read(name, aad)) === sha(data), '已存在的不可变传输对象不同，请检查客户端文件');
      return false;
    }
    atomicWrite(file, sealBinary(data, this.key, aad)); return true;
  }
  json(name, aad) { return JSON.parse(this.read(name, aad, 32 * 1024 * 1024).toString('utf8')); }
  writeJson(name, value, aad) { return this.write(name, Buffer.from(canonical(value)), aad); }
}

export function assetObjects(events) {
  const values = new Map();
  for (const event of events.filter(event => event.type === 'asset')) {
    const asset = event.data, existing = values.get(asset.sha256);
    check(!existing || existing.size === asset.size, 'Asset size mismatch');
    if (!existing) values.set(asset.sha256, { hash: asset.sha256, size: asset.size, ids: [] });
    if (!values.get(asset.sha256).ids.includes(event.entityId)) values.get(asset.sha256).ids.push(event.entityId);
  }
  return [...values.values()].map(asset => ({ ...asset, ids: asset.ids.sort() })).sort((a, b) => a.hash.localeCompare(b.hash));
}
export function chunkName(hash, index) { check(isHash(hash) && Number.isSafeInteger(index) && index >= 0, 'Invalid chunk'); return `asset-${hash}-${index}.ssobj`; }
export function assetAAD(asset, index) { return `v2:asset:${asset.hash}:${asset.size}:${index}`; }

export async function localAsset(store, asset) {
  for (const id of asset.ids) {
    const local = store.assetLocation(id);
    if (!local || !fs.existsSync(local.path)) continue;
    noSymlink(local.path);
    if (fs.statSync(local.path).size === asset.size && await hashFile(local.path) === asset.hash) return local.path;
  }
  return null;
}
export async function publishAsset(channel, store, asset) {
  const count = Math.max(1, Math.ceil(asset.size / CHUNK_BYTES));
  const file = await localAsset(store, asset);
  const chunks = [];
  if (!file) {
    const hash = createHash('sha256');
    for (let i = 0; i < count; i++) {
      const name = chunkName(asset.hash, i), data = channel.read(name, assetAAD(asset, i), CHUNK_BYTES);
      check(data.length === Math.min(CHUNK_BYTES, asset.size - i * CHUNK_BYTES), '原文件分块长度不符');
      hash.update(data);
      chunks.push({ name, hash: sha(data), size: data.length });
    }
    check(hash.digest('hex') === asset.hash, '原文件整体校验失败');
    return { ...asset, chunks };
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    for (let i = 0; i < count; i++) {
      const length = Math.min(CHUNK_BYTES, asset.size - i * CHUNK_BYTES), buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, i * CHUNK_BYTES);
      check(bytesRead === length, '原文件在传输时发生变化');
      const name = chunkName(asset.hash, i);
      channel.write(name, buffer, assetAAD(asset, i)); chunks.push({ name, size: length, hash: sha(buffer) });
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { await handle.close(); }
  check(await hashFile(file) === asset.hash, '原文件在传输时发生变化，版本未发布');
  return { ...asset, chunks };
}

export function validateAssets(assets) {
  check(Array.isArray(assets) && assets.length <= 100000, 'Invalid asset manifest');
  const hashes = new Set();
  for (const asset of assets) {
    check(isHash(asset.hash) && !hashes.has(asset.hash) && Number.isSafeInteger(asset.size) && asset.size >= 0, 'Invalid asset identity'); hashes.add(asset.hash);
    check(Array.isArray(asset.ids) && Array.isArray(asset.chunks) && asset.chunks.length === Math.max(1, Math.ceil(asset.size / CHUNK_BYTES)), 'Invalid chunk count');
    asset.chunks.forEach((chunk, i) => check(chunk.name === chunkName(asset.hash, i) && isHash(chunk.hash)
      && chunk.size === Math.min(CHUNK_BYTES, asset.size - i * CHUNK_BYTES), 'Invalid chunk manifest'));
  }
}
export async function receiveAsset(channel, store, asset) {
  validateAssets([asset]);
  const existing = await localAsset(store, asset);
  if (existing) return existing;
  const directory = path.join(store.directory, 'received-objects'); noSymlink(directory);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, asset.hash), temp = `${target}.${uuid()}.partial`;
  noSymlink(target); noSymlink(temp);
  if (fs.existsSync(target) && await hashFile(target) === asset.hash) return target;
  const handle = await fs.promises.open(temp, 'wx', 0o600);
  try {
    for (let i = 0; i < asset.chunks.length; i++) {
      const chunk = asset.chunks[i], data = channel.read(chunk.name, assetAAD(asset, i), CHUNK_BYTES);
      check(data.length === chunk.size && sha(data) === chunk.hash, '附件分块不完整或校验失败');
      await handle.writeFile(data);
    }
    await handle.sync(); await handle.close();
    check(await hashFile(temp) === asset.hash && fs.statSync(temp).size === asset.size, '原文件整体校验失败');
    check(!fs.existsSync(target), '本地对象同名文件损坏，请先恢复或移开损坏副本');
    await fs.promises.rename(temp, target); return target;
  } finally { await handle.close().catch(() => {}); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
