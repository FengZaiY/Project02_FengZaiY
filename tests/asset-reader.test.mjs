import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { mediaResponse } from '../src/core/media.mjs';

async function fixture(t, name = 'document.txt', bytes = Buffer.from('original content')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyself-reader-'));
  const service = new Service(path.join(root, 'workspace')); t.after(() => service.close());
  const source = path.join(root, name); fs.writeFileSync(source, bytes);
  const asset = await service.call('assetImport', { path: source, domain: 'Reader test' });
  return { service, store: service.store, asset, file: service.store.assetLocation(asset.id).path, bytes, root };
}

test('inline preview verifies returned bytes, actual size, missing files and record state', async t => {
  const { service, store, asset, file, bytes } = await fixture(t);
  assert.deepEqual(Buffer.from((await service.call('assetContent', { id: asset.id })).data, 'base64'), bytes);
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 4));
  await assert.rejects(service.call('assetContent', { id: asset.id }), /完整性/);
  fs.truncateSync(file, 25 * 1024 * 1024);
  await assert.rejects(service.call('assetContent', { id: asset.id }), /完整性|大小/);
  fs.writeFileSync(file, bytes);
  const updated = store.write({ id: asset.id, type: 'asset', parents: asset.heads, data: { ...asset.data, title: 'changed' } });
  store.write({ id: asset.id, type: 'asset', parents: asset.heads, allowBranch: true, data: { ...asset.data, title: 'parallel' } });
  await assert.rejects(service.call('assetContent', { id: asset.id }), /不可用/);
  const resolved = store.write({ id: asset.id, type: 'asset', parents: store.get(asset.id).heads, data: updated.data });
  store.remove(asset.id, resolved.heads);
  await assert.rejects(service.call('assetContent', { id: asset.id }), /不可用/);
  assert.equal(store.activeAssetReads.size, 0);
});

test('preview rejects changes during a read and releases its original-file guard', async t => {
  const { service, store, asset, file } = await fixture(t);
  const open = fs.promises.open;
  t.after(() => { fs.promises.open = open; });
  fs.promises.open = async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle);
    if (args[0] === file) handle.read = async (...input) => {
      assert.equal(store.activeAssetReads.get(asset.id), 1);
      const result = await read(...input);
      fs.appendFileSync(file, 'changed after read'); return result;
    };
    return handle;
  };
  await assert.rejects(service.call('assetContent', { id: asset.id }), /发生变化/);
  assert.equal(store.activeAssetReads.size, 0);
});

test('preview rejects a binding through a directory link without retaining a read guard', async t => {
  const { service, store, asset, file, root } = await fixture(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(path.dirname(file), alias, 'junction');
  store.bindAsset(asset.id, path.join(alias, path.basename(file)));
  await assert.rejects(service.call('assetContent', { id: asset.id }), /link|链接|symbolic/i);
  assert.equal(store.activeAssetReads?.size || 0, 0);
});

test('media ranges and HEAD reuse verification, but same-size changes invalidate the cache', async t => {
  const { store, asset, file, bytes } = await fixture(t, 'clip.mp4', Buffer.alloc(8 * 1024 * 1024, 7));
  const open = fs.promises.open; let readBytes = 0;
  t.after(() => { fs.promises.open = open; });
  fs.promises.open = async (...args) => {
    const handle = await open(...args), stream = handle.createReadStream.bind(handle);
    handle.createReadStream = (...input) => {
      const result = stream(...input); result.on('data', chunk => { readBytes += chunk.length; }); return result;
    };
    return handle;
  };
  assert.equal((await mediaResponse(store, asset.id, 'bytes=99999999-')).status, 416);
  assert.equal(readBytes, 0);
  for (let i = 0; i < 3; i++) {
    const response = await mediaResponse(store, asset.id, 'bytes=0-1023');
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 1024);
  }
  assert.equal((await mediaResponse(store, asset.id, null, 'HEAD')).headers.get('content-length'), String(bytes.length));
  assert.equal(readBytes, bytes.length + 3072);
  const stat = fs.statSync(file);
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 8)); fs.utimesSync(file, stat.atime, stat.mtime);
  await assert.rejects(mediaResponse(store, asset.id, 'bytes=0-1023'), /完整性/);
  assert.equal(store.activeAssetReads.size, 0);
});

test('cancelled media releases its read guard; a replaced binding cannot use cached verification', async t => {
  const { store, asset, file, bytes, root } = await fixture(t, 'clip.mp4', Buffer.alloc(1024 * 1024, 5));
  const response = await mediaResponse(store, asset.id);
  assert.equal(store.activeAssetReads.get(asset.id), 1);
  await response.body.cancel();
  for (let i = 0; i < 100 && store.activeAssetReads.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.activeAssetReads.size, 0);
  const another = path.join(root, 'changed.mp4'); fs.writeFileSync(another, Buffer.alloc(bytes.length, 9));
  store.bindAsset(asset.id, another);
  await assert.rejects(mediaResponse(store, asset.id, 'bytes=0-99'), /完整性/);
  store.bindAsset(asset.id, file);
  fs.unlinkSync(file);
  await assert.rejects(mediaResponse(store, asset.id), /ENOENT/);
  assert.equal(store.activeAssetReads.size, 0);
});
