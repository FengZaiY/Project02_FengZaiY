import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { mergeControl, EMPTY_CONTROL } from '../src/core/sync-state.mjs';
import { managementRevision } from '../src/core/device-management.mjs';
import { makePairingKey, importAttachment } from '../src/core/transport.mjs';
import { uuid, now, canonical, sha } from '../src/core/util.mjs';

const root = path.resolve('artifacts/device-management-tests'); fs.mkdirSync(root, { recursive: true });
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), key = makePairingKey(), owners = [];
  const open = name => {
    const store = new Store(path.join(directory, name), { deviceName: name });
    const sync = new CurrentSync(store, { reserveBytes: 0 }); sync.configure(path.join(directory, `cloud-${name}`), key);
    const owner = { store, sync }; owners.push(owner); return owner;
  };
  const a = open('A'), b = open('B');
  t.after(() => owners.forEach(owner => owner.store.close()));
  const publish = async owner => { await owner.sync.publish(); return owner.sync.value('latest'); };
  const deliver = (from, to) => {
    fs.mkdirSync(to.sync.channel().root, { recursive: true });
    for (const name of fs.readdirSync(from.sync.channel().root)) fs.copyFileSync(from.sync.channel().file(name), to.sync.channel().file(name));
  };
  const pull = async (from, to) => { await publish(from); deliver(from, to); return to.sync.importLatest(); };
  await a.sync.setPrimary({ deviceId: a.store.deviceId, parents: [], confirmed: true });
  await pull(a, b); await pull(b, a);
  const manage = (owner, action, target = b, extra = {}) => owner.sync.manageDevice({ action, deviceId: target.store.deviceId,
    revision: owner.sync.devices().revision, requestId: uuid(), confirmed: true, ...extra });
  return { a, b, open, directory, publish, deliver, pull, manage };
}

test('only primary manages devices; stale, malformed and duplicate requests are checked transactionally', async t => {
  const f = await fixture(t), original = f.a.sync.devices().revision;
  await assert.rejects(f.manage(f.b, 'rename', f.a, { name: '越权' }), /唯一主力机/);
  await assert.rejects(f.manage(f.a, 'suspend', f.a), /不能停用/);
  await assert.rejects(f.manage(f.a, 'rename', f.b, { name: ' ' }), /设备名称/);
  await assert.rejects(f.manage(f.a, 'suspend', f.b, { confirmed: false }), /明确确认/);
  assert.equal(f.a.sync.devices().revision, original);
  const requestId = uuid(); await f.manage(f.a, 'rename', f.b, { name: '公司电脑', requestId });
  const changed = f.a.sync.devices().revision;
  await f.manage(f.a, 'rename', f.b, { name: '公司电脑', requestId, revision: original });
  assert.equal(f.a.sync.devices().revision, changed);
  await assert.rejects(f.manage(f.a, 'rename', f.b, { name: '其他内容', requestId }), /重复请求/);
  await assert.rejects(f.manage(f.a, 'suspend', f.b, { revision: original }), /状态已变化/);
  const setMeta = f.a.store.setMeta.bind(f.a.store);
  f.a.store.setMeta = () => { throw new Error('injected failure'); };
  await assert.rejects(f.manage(f.a, 'rename', f.a, { name: '新名称' }), /injected failure/);
  f.a.store.setMeta = setMeta;
  assert.equal(f.a.sync.devices().revision, changed);
  assert.equal(f.a.store.getMeta('deviceName'), 'A');
});

test('suspension and restoration propagate through two directories without deleting local knowledge', async t => {
  const f = await fixture(t), library = f.a.store.saveLibrary({ title: '资料' });
  const note = f.a.store.write({ type: 'note', data: { title: '正文', domain: library.data.domain, content: '保留' } });
  const file = path.join(f.directory, 'original.txt'); fs.writeFileSync(file, '原件');
  const asset = await importAttachment(f.a.store, file, { domain: library.data.domain });
  await f.pull(f.a, f.b);
  const original = f.b.store.assetLocation(asset.id).path;
  const local = f.b.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '离线改动' } });
  await f.manage(f.a, 'rename', f.b, { name: '办公电脑' });
  await f.manage(f.a, 'suspend');
  const manifest = await f.publish(f.a); assert.equal(manifest.format, 5);
  f.deliver(f.a, f.b);
  assert.equal((await f.b.sync.importLatest()).managementOnly, true);
  assert.equal(f.b.store.getMeta('deviceName'), '办公电脑');
  assert.equal(f.b.store.get(note.id).data.content, '离线改动'); assert.ok(fs.existsSync(original));
  await assert.rejects(f.b.sync.plan(), /本机已停用/);
  await assert.rejects(f.b.sync.publish(), /本机已停用/);
  await assert.rejects(f.b.sync.setPrimary({ deviceId: f.b.store.deviceId, parents: f.b.sync.devices().heads.map(item => item.id),
    revision: f.b.sync.devices().revision, confirmed: true }), /本机已停用/);
  const fresh = f.open('C'); f.deliver(f.a, fresh); await fresh.sync.importLatest();
  assert.equal(fresh.sync.devices().devices.find(item => item.deviceId === f.b.store.deviceId).suspended, true);
  await f.manage(f.a, 'resume'); await f.pull(f.a, f.b);
  assert.equal(f.b.sync.devices().devices.find(item => item.local).suspended, false);
  await f.pull(f.b, f.a); await f.pull(f.b, f.a);
  assert.deepEqual(f.a.store.get(note.id).heads, local.heads); assert.ok(fs.existsSync(original));
});

test('suspended source publication is ignored while its already imported history remains', async t => {
  const f = await fixture(t), library = f.b.store.saveLibrary({ title: '离线知识' });
  const record = f.b.store.write({ type: 'note', data: { title: '离线笔记', domain: library.data.domain, content: '未接收内容' } });
  await f.publish(f.b);
  await f.manage(f.a, 'suspend'); f.deliver(f.b, f.a);
  const result = await f.a.sync.importLatest();
  assert.equal(result.skippedDevices, 1); assert.equal(f.a.store.get(record.id), null);
  await f.manage(f.a, 'resume'); await f.a.sync.importLatest();
  assert.equal(f.a.store.get(record.id).data.content, '未接收内容');
});

test('transferring primary requires request, target confirmation and complete originals', async t => {
  const f = await fixture(t), initial = f.b.sync.devices();
  await assert.rejects(f.b.sync.setPrimary({ deviceId: f.b.store.deviceId, parents: initial.heads.map(item => item.id), confirmed: true }), /发起转移/);
  const file = path.join(f.directory, 'missing.txt'); fs.writeFileSync(file, '待接收');
  const asset = await importAttachment(f.a.store, file, { domain: '测试' });
  await f.pull(f.a, f.b);
  fs.unlinkSync(f.b.store.assetLocation(asset.id).path);
  await f.manage(f.a, 'transfer');
  assert.equal(f.a.sync.devices().primary, f.a.store.deviceId);
  await assert.rejects(f.manage(f.a, 'suspend'), /待接管设备/);
  await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest({ metadataOnly: true });
  const status = f.b.sync.devices();
  const input = { deviceId: f.b.store.deviceId, parents: status.heads.map(item => item.id), revision: status.revision,
    transferId: status.transfer.id, confirmed: true };
  await assert.rejects(f.a.sync.setPrimary(input), /目标主力机/);
  await assert.rejects(f.b.sync.setPrimary(input), /资料未齐全/);
  await f.b.sync.hydrate({ id: asset.id });
  await f.b.sync.setPrimary(input);
  assert.equal(f.b.sync.devices().primary, f.b.store.deviceId);
  assert.equal(f.b.sync.devices().transfer, null);
  await f.pull(f.b, f.a);
  assert.equal(f.a.sync.devices().canManage, false);
  assert.equal(f.b.sync.devices().canManage, true);
  assert.ok(fs.existsSync(f.a.store.assetLocation(asset.id).path));
  await assert.rejects(f.manage(f.a, 'rename', f.b, { name: '失效权限' }), /唯一主力机/);
});

test('cancelled or stale transfers and stale frozen publications cannot bypass review', async t => {
  const f = await fixture(t);
  await f.manage(f.a, 'transfer'); await f.pull(f.a, f.b);
  const status = f.b.sync.devices(), input = { deviceId: f.b.store.deviceId, parents: status.heads.map(item => item.id),
    revision: status.revision, transferId: status.transfer.id, confirmed: true };
  await f.manage(f.a, 'cancel-transfer', f.a); await f.pull(f.a, f.b);
  await assert.rejects(f.b.sync.setPrimary(input), /状态已变化/);
  await assert.rejects(f.b.sync.setPrimary({ ...input, revision: f.b.sync.devices().revision }), /发起转移/);
  await f.manage(f.a, 'rename', f.b, { name: '名称一' }); await f.a.sync.plan();
  await f.manage(f.a, 'rename', f.b, { name: '名称二' });
  await assert.rejects(f.a.sync.publish(), /取消旧发布任务/);
  f.a.sync.cancel(); await f.pull(f.a, f.b);
  assert.equal(f.b.store.getMeta('deviceName'), '名称二');
});

test('concurrent administration preserves conflicts until primary explicitly resolves each field', async t => {
  const f = await fixture(t), base = f.a.sync.control(), epoch = f.a.sync.devices().epoch;
  const event = (action, extra = {}) => ({ id: uuid(), at: now(), actor: f.a.store.deviceId, epoch,
    parents: [], deviceId: f.b.store.deviceId, action, ...extra });
  const concurrent = [event('rename', { name: '名字一' }), event('rename', { name: '名字二' }), event('suspend'), event('resume')];
  const merged = mergeControl(base, { ...EMPTY_CONTROL, management: concurrent }); f.a.sync.applyControl(merged);
  const row = f.a.sync.devices().devices.find(item => !item.local);
  assert.equal(row.nameConflict, true); assert.equal(row.statusConflict, true); assert.equal(row.suspended, true);
  assert.deepEqual(new Set(row.names), new Set(['名字一', '名字二']));
  await f.manage(f.a, 'rename', f.b, { name: '最终名称' }); await f.manage(f.a, 'resume');
  const resolved = f.a.sync.devices().devices.find(item => !item.local);
  assert.equal(resolved.nameConflict, false); assert.equal(resolved.statusConflict, false); assert.equal(resolved.suspended, false);
  assert.equal(f.a.sync.control().management.length, 6);
  assert.deepEqual(mergeControl(f.a.sync.control(), merged), mergeControl(merged, f.a.sync.control()));
});

test('malformed authority, cycles, collisions and downgraded manifests are rejected', async t => {
  const f = await fixture(t); await f.manage(f.a, 'rename', f.b, { name: '受控名称' });
  const control = f.a.sync.control(), entry = control.management[0];
  assert.throws(() => mergeControl({ ...control, management: [{ ...entry, actor: f.b.store.deviceId }] }), /主力机发起/);
  assert.throws(() => mergeControl({ ...control, management: [{ ...entry, parents: [entry.id] }] }), /循环/);
  assert.throws(() => mergeControl(control, { ...EMPTY_CONTROL, management: [{ ...entry, name: '身份碰撞' }] }), /标识冲突/);
  assert.throws(() => mergeControl({ ...control, roles: [...control.roles, { id: uuid(), at: now(), primary: f.b.store.deviceId,
    parents: [f.a.sync.devices().epoch] }] }), /转移必须/);
  const manifest = await f.publish(f.a), downgraded = { ...manifest, format: 4 };
  downgraded.digest = sha(canonical({ parts: downgraded.parts, control: downgraded.control, assets: downgraded.assets, erasures: downgraded.erasures }));
  assert.throws(() => f.b.sync.validateManifest(downgraded, f.a.store.deviceId), /format 5/);
  assert.equal(managementRevision(control), managementRevision(f.a.sync.control()));
});

test('offline acceptance concurrent with cancellation stays conflicted until participant confirms recovery', async t => {
  const f = await fixture(t); await f.manage(f.a, 'transfer'); await f.pull(f.a, f.b);
  const status = f.b.sync.devices();
  await f.b.sync.setPrimary({ deviceId: f.b.store.deviceId, parents: status.heads.map(item => item.id),
    revision: status.revision, transferId: status.transfer.id, confirmed: true });
  await f.manage(f.a, 'cancel-transfer', f.a);
  await f.publish(f.a); await f.publish(f.b); f.deliver(f.b, f.a);
  await f.a.sync.importLatest();
  const conflicted = f.a.sync.devices();
  assert.equal(conflicted.handoverConflict, true); assert.equal(conflicted.canManage, false); assert.equal(conflicted.primary, null);
  await assert.rejects(f.manage(f.a, 'rename', f.b, { name: '冲突时不能管理' }), /唯一主力机/);
  await f.a.sync.setPrimary({ deviceId: f.a.store.deviceId, parents: conflicted.heads.map(item => item.id),
    revision: conflicted.revision, confirmed: true });
  assert.equal(f.a.sync.devices().primary, f.a.store.deviceId);
  await f.pull(f.a, f.b);
  assert.equal(f.b.sync.devices().conflict, false); assert.equal(f.b.sync.devices().primary, f.a.store.deviceId);
});
