import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { FolderTransport, makePairingKey, importAttachment } from '../src/core/transport.mjs';
import { ASSET_CHUNK_SIZE } from '../src/core/asset-transfer.mjs';
import { hashFile, sha } from '../src/core/util.mjs';

const root = path.resolve('artifacts/asset-transfer-tests');
fs.mkdirSync(root, { recursive: true });
function setup(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), stores = [];
  const key = makePairingKey();
  const open = name => {
    const store = new Store(path.join(directory, name)); stores.push(store);
    const transport = new FolderTransport(store);
    transport.configure(path.join(directory, `cloud-${name}`), key);
    return { store, transport };
  };
  const a = open('A'), b = open('B');
  const names = transport => fs.readdirSync(transport.root()).filter(name => name.endsWith('.ssync'));
  const deliver = (from, to, filter = () => true) => {
    for (const name of names(from).filter(filter)) fs.copyFileSync(path.join(from.root(), name), path.join(to.root(), name));
  };
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    assert.equal(path.dirname(path.resolve(directory)), root);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const large = async () => {
    const file = path.join(directory, 'course.mp4');
    fs.writeFileSync(file, Buffer.alloc(ASSET_CHUNK_SIZE * 4 + 123, 37));
    const asset = await importAttachment(a.store, file, { domain: 'Research' });
    const note = a.store.write({ type: 'note', data: { title: 'Course', domain: 'Research', content: 'Readable notes', assetIds: [asset.id] } });
    return { file, asset, note };
  };
  return { directory, a, b, open, deliver, names, large };
}

test('out-of-order large chunks remain unavailable until complete; replay and a later computer are safe', async t => {
  const { a, b, open, deliver, names, large } = setup(t);
  const { asset, note } = await large();
  const sent = await a.transport.cycle();
  assert.equal(sent.assetsPublished, 1); assert.equal(sent.assetChunksPublished, 5);
  const chunks = names(a.transport).filter(name => name.startsWith('asset-chunk-'));
  for (const name of chunks.slice(1).reverse()) deliver(a.transport, b.transport, candidate => candidate === name);
  await b.transport.cycle();
  assert.equal(b.store.assetLocation(asset.id), undefined);
  deliver(a.transport, b.transport, name => name.startsWith('events-'));
  let report = await b.transport.cycle();
  assert.equal(b.store.get(note.id).data.content, 'Readable notes');
  assert.equal(report.assetsMissing, 1); assert.equal(report.assetsAvailable, 0);
  assert.equal(b.store.assetLocation(asset.id), undefined);
  deliver(a.transport, b.transport);
  report = await b.transport.cycle();
  assert.equal(report.assetsMissing, 0); assert.equal(report.assetsAvailable, 1);
  assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.ok(b.store.assetLocation(asset.id).path.startsWith(b.store.directory));
  const count = names(b.transport).length;
  await b.transport.cycle(); assert.equal(names(b.transport).length, count);
  const decode = b.transport.open.bind(b.transport); let decoded = 0;
  b.transport.open = text => { decoded++; return decode(text); };
  await b.transport.cycle(); assert.equal(decoded, 0, 'Unchanged packets are not decrypted on every timer tick');
  fs.unlinkSync(b.store.assetLocation(asset.id).path);
  const repaired = await b.transport.cycle();
  assert.equal(repaired.assetsMissing, 0); assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
  const c = open('C'); deliver(a.transport, c.transport); await c.transport.cycle();
  assert.equal(await hashFile(c.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal(names(a.transport).filter(name => name.startsWith('asset-chunk-')).length, 5);
});

test('interrupted publication and receipt resume after reopening the databases', async t => {
  const { a, b, open, deliver, names, large } = setup(t);
  const { asset } = await large();
  const write = a.transport.writePacket.bind(a.transport); let writes = 0;
  a.transport.writePacket = (kind, ...args) => {
    if (kind === 'asset-chunk' && ++writes === 3) throw new Error('Simulated full disk');
    return write(kind, ...args);
  };
  const failed = await a.transport.cycle();
  assert.match(failed.errors[0].message, /full disk/); assert.equal(failed.assetsPublished, 0);
  deliver(a.transport, b.transport); await b.transport.cycle();
  assert.equal(b.store.assetLocation(asset.id), undefined);
  a.store.close(); b.store.close();
  const resumedA = open('A'), resumedB = open('B');
  const sent = await resumedA.transport.cycle(); assert.equal(sent.assetChunksPublished, 3);
  assert.equal(names(resumedA.transport).filter(name => name.startsWith('asset-chunk-')).length, 5);
  deliver(resumedA.transport, resumedB.transport); await resumedB.transport.cycle();
  assert.equal(await hashFile(resumedB.store.assetLocation(asset.id).path), asset.data.sha256);
});

test('truncated packets and bad chunk hashes never expose a partial file', async t => {
  const { a, b, deliver, names, large } = setup(t);
  const { asset } = await large(); await a.transport.cycle(); deliver(a.transport, b.transport);
  const name = names(a.transport).find(name => name.startsWith('asset-chunk-'));
  const input = path.join(a.transport.root(), name), file = path.join(b.transport.root(), name);
  const original = fs.readFileSync(input, 'utf8');
  fs.writeFileSync(file, original.slice(0, 80));
  let report = await b.transport.cycle(); assert.ok(report.errors.length); assert.equal(report.assetsMissing, 1);
  assert.equal(b.store.assetLocation(asset.id), undefined);
  const payload = a.transport.open(original).payload;
  const bad = { ...payload, chunkSha256: '0'.repeat(64) };
  fs.writeFileSync(file, a.transport.seal('asset-chunk', bad, a.transport.open(original).id));
  report = await b.transport.cycle(); assert.ok(report.errors.some(error => /integrity/.test(error.message)));
  assert.equal(b.store.assetLocation(asset.id), undefined);
  fs.writeFileSync(file, original); report = await b.transport.cycle();
  assert.equal(report.assetsMissing, 0); assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
});

test('valid individual chunks with a wrong complete hash are not committed; corrected chunks can finish', async t => {
  const { a, b, deliver, names, large } = setup(t);
  const { asset } = await large(); await a.transport.cycle();
  const name = names(a.transport).find(name => name.startsWith('asset-chunk-'));
  const payload = a.transport.open(fs.readFileSync(path.join(a.transport.root(), name), 'utf8')).payload;
  const bytes = Buffer.from(payload.data, 'base64'); bytes[0] ^= 1;
  const replacement = a.transport.writePacket('asset-chunk', { ...payload, data: bytes.toString('base64'), chunkSha256: sha(bytes) });
  deliver(a.transport, b.transport, candidate => candidate !== name);
  let report = await b.transport.cycle();
  assert.ok(report.errors.some(error => /Complete attachment/.test(error.message)));
  assert.equal(b.store.assetLocation(asset.id), undefined);
  deliver(a.transport, b.transport, candidate => candidate === name);
  report = await b.transport.cycle(); assert.equal(report.assetsMissing, 0);
  assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.ok(fs.existsSync(replacement), 'No automatic deletion of already published packets');
});

test('all imported file types, standalone files, trash and empty files transfer without leaking local settings', async t => {
  const { directory, a, b, deliver, names } = setup(t);
  a.store.local('private-device-setting', 'DO-NOT-SYNC');
  const assets = [];
  for (const name of ['image.png', 'document.pdf', 'material.zip', 'empty.txt']) {
    const file = path.join(directory, name); fs.writeFileSync(file, name === 'empty.txt' ? '' : name);
    assets.push(await importAttachment(a.store, file));
  }
  a.store.remove(assets[0].id, assets[0].heads);
  await a.transport.cycle(); deliver(a.transport, b.transport); const report = await b.transport.cycle();
  assert.equal(report.assetsAvailable, 4); assert.equal(report.assetsMissing, 0);
  for (const asset of assets) assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
  fs.unlinkSync(b.store.assetLocation(assets[0].id).path);
  const repaired = await b.transport.cycle(); assert.equal(repaired.assetsMissing, 0);
  assert.equal(await hashFile(b.store.assetLocation(assets[0].id).path), assets[0].data.sha256);
  fs.writeFileSync(b.store.assetLocation(assets[1].id).path, Buffer.alloc(assets[1].data.size, 0));
  const rechecked = await b.transport.cycle(); assert.equal(rechecked.assetsMissing, 0);
  assert.equal(await hashFile(b.store.assetLocation(assets[1].id).path), assets[1].data.sha256, 'Same-size changes invalidate the verification cache');
  assert.equal(b.store.local('private-device-setting'), null);
  for (const name of names(a.transport)) {
    const packet = a.transport.open(fs.readFileSync(path.join(a.transport.root(), name), 'utf8'));
    assert.ok(!JSON.stringify(packet.payload).includes(a.store.directory));
    assert.ok(!JSON.stringify(packet.payload).includes('DO-NOT-SYNC'));
  }
});

test('missing or altered source files do not block unrelated notes and are reported as incomplete', async t => {
  const { directory, a, b, deliver } = setup(t);
  const assets = [];
  for (const name of ['missing.txt', 'changed.txt']) {
    const file = path.join(directory, name); fs.writeFileSync(file, 'old'); assets.push(await importAttachment(a.store, file));
  }
  fs.unlinkSync(a.store.assetLocation(assets[0].id).path);
  fs.writeFileSync(a.store.assetLocation(assets[1].id).path, 'new');
  const note = a.store.write({ type: 'note', data: { title: 'Unaffected', content: 'still syncs', assetIds: assets.map(asset => asset.id) } });
  const sent = await a.transport.cycle(); assert.equal(sent.assetsMissing, 2); assert.equal(sent.assetsPublished, 0);
  deliver(a.transport, b.transport); const received = await b.transport.cycle();
  assert.equal(b.store.get(note.id).data.content, 'still syncs'); assert.equal(received.assetsMissing, 2);
  assert.ok(assets.every(asset => !b.store.get(asset.id).deleted));
});

test('a 16 MiB attachment uses bounded packets instead of exceeding the encrypted packet limit', async t => {
  const { directory, a, b, deliver, names } = setup(t);
  const file = path.join(directory, 'material.pdf'); fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 9));
  const asset = await importAttachment(a.store, file);
  const report = await a.transport.cycle();
  assert.deepEqual(report.errors, []); assert.equal(report.assetChunksPublished, 4);
  for (const name of names(a.transport)) assert.ok(fs.statSync(path.join(a.transport.root(), name)).size < 26 * 1024 * 1024);
  deliver(a.transport, b.transport); await b.transport.cycle();
  assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
});

test('a modified processed packet invalidates the file scan cache', async t => {
  const { a, b, deliver, names } = setup(t);
  a.store.write({ type: 'note', data: { title: 'Cache check', content: 'original' } });
  await a.transport.cycle(); deliver(a.transport, b.transport); await b.transport.cycle(); await b.transport.cycle();
  const name = names(b.transport).find(name => name.startsWith('events-'));
  const file = path.join(b.transport.root(), name), original = fs.readFileSync(file, 'utf8');
  const envelope = JSON.parse(original); envelope.box.data = 'A'.repeat(envelope.box.data.length);
  fs.writeFileSync(file, JSON.stringify(envelope));
  const failed = await b.transport.cycle(); assert.ok(failed.errors.length);
  fs.writeFileSync(file, original); const repaired = await b.transport.cycle(); assert.deepEqual(repaired.errors, []);
});
