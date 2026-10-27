import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { PersonalManager } from '../src/core/personal-manager.mjs';
import { PasswordVault } from '../src/core/password-vault.mjs';
import { ChangeHistory } from '../src/core/change-history.mjs';
import { minorUnits, convertMoney, decimalMoney } from '../src/core/personal-schema.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { makePairingKey, importAttachment } from '../src/core/transport.mjs';
import { MaterialCenter, isCentralAsset, userExportPath } from '../src/core/material-center.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { uuid, hashFile } from '../src/core/util.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { previewTrash, prepareRemoteErasure } from '../src/core/trash.mjs';
import { createErasure } from '../src/core/erasures.mjs';
import { SecretClipboard } from '../src/desktop/secret-clipboard.mjs';
import { Service } from '../src/core/service.mjs';
import { previewAssetMerge, mergeAssets } from '../src/core/asset-merge.mjs';

const root = path.resolve('artifacts/personal-tests'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'case-')), store = new Store(path.join(dir, 'A'));
  const manager = new PersonalManager(store), vault = new PasswordVault(store), changes = new ChangeHistory(store, vault);
  t.after(() => { vault.close(); store.close(); });
  const save = (type, data, extra = {}) => manager.save({ type, data, ...extra });
  const account = (title = '现金', currency = 'CNY', opening = 10000, rate) => save('moneyAccount', { title, currency, opening, rate, kind: 'cash', openingDate: '2026-01-01' });
  const entry = (account, kind, amount, extra = {}) => save('moneyEntry', { title: kind, kind, amount, accountId: account.id, currency: account.data.currency, date: '2026-10-27', ...extra });
  return { dir, store, manager, vault, changes, save, account, entry };
}

test('moving a task checks descendant depth and project ownership', t => {
  const f = fixture(t), task = (title, parentTaskId) => f.save('personalTask', { title, parentTaskId, status: 'todo', priority: 'normal' });
  let parent;
  for (let level = 1; level <= 15; level++) parent = task(`层 ${level}`, parent?.id);
  const subtree = task('父任务'), child = task('子任务', subtree.id);
  assert.throws(() => f.save('personalTask', { ...subtree.data, parentTaskId: parent.id }, { id: subtree.id, parents: subtree.heads }), /16 层/);
  assert.equal(f.store.get(child.id).data.parentTaskId, subtree.id);
  const last = task('第 16 层', parent.id);
  assert.throws(() => task('第 17 层', last.id), /16 层/);
});

test('account recycle, undo and restore keep encrypted secrets together and protect secret drafts', async t => {
  const service = new Service(fs.mkdtempSync(path.join(root, 'account-'))); t.after(() => service.close());
  const account = await service.call('personalSave', { type: 'loginAccount', data: { title: '回收账号' } });
  const setup = await service.call('vaultSetup', { password: 'account recovery password' });
  await service.call('vaultSetupConfirm', { token: setup.token, confirmed: true });
  const secret = await service.call('vaultSave', { accountId: account.id, value: { password: 'encrypted value' } });
  await service.call('vaultDraft', { accountId: account.id, parents: secret.parents, value: { password: 'unsaved value' } });
  await assert.rejects(service.call('personalDelete', { id: account.id, parents: account.heads }), /草稿/);
  await service.call('vaultDraft', { accountId: account.id, clear: true });
  await service.call('vaultLock');
  await assert.rejects(service.call('personalDelete', { id: account.id, parents: account.heads }), /解锁/);
  await service.call('vaultUnlock', { password: 'account recovery password' });
  await service.call('personalDelete', { id: account.id, parents: account.heads });
  assert.equal(service.store.get(secret.id).deleted, true);
  const batch = service.store.list({ type: 'changeBatch' }).find(r => r.data.title === '回收账号与密码');
  await service.call('changeUndo', { id: batch.id });
  assert.equal((await service.call('vaultRead', { accountId: account.id })).value.password, 'encrypted value');
  await service.call('personalDelete', { id: account.id, parents: service.store.headIds(account.id) });
  await service.call('personalRestore', { id: account.id, revision: account.heads[0], parents: service.store.headIds(account.id) });
  assert.equal(service.store.get(secret.id).deleted, false);
  assert.equal((await service.call('vaultRead', { accountId: account.id })).value.password, 'encrypted value');
});

test('duplicate materials preserve collection membership and rewrite business references', async t => {
  const f = fixture(t), domain = f.store.saveLibrary({ title: '资料库' }).data.domain;
  f.store.personalSystem = true;
  const file = path.join(f.dir, 'same.txt'); fs.writeFileSync(file, 'same original');
  const a = await importAttachment(f.store, file, { domain }), b = await importAttachment(f.store, file, { domain, duplicateMode: 'separate' });
  assert.notEqual(a.id, b.id);
  const center = new MaterialCenter(f.store, new LocalHierarchy(f.store));
  const ca = f.save('materialCollection', { title: '甲' }), cb = f.save('materialCollection', { title: '乙' });
  center.update({ id: a.id, parents: a.heads, changes: { collectionIds: [ca.id] } });
  center.update({ id: b.id, parents: b.heads, changes: { collectionIds: [cb.id] } });
  const task = f.save('personalTask', { title: '关联资料', status: 'todo', priority: 'normal', assetIds: [b.id] });
  const preview = previewAssetMerge(f.store, { ids: [a.id, b.id], targetId: a.id });
  await mergeAssets(f.store, { ids: [a.id, b.id], targetId: a.id, token: preview.token, confirmed: true });
  assert.deepEqual(new Set(f.store.get(a.id).data.collectionIds), new Set([ca.id, cb.id]));
  assert.deepEqual(f.store.get(task.id).data.assetIds, [a.id]);
});

test('integer amounts, exact exports and manual exchange rates', () => {
  assert.equal(minorUnits('0.29'), 29); assert.equal(minorUnits('1.005', 'KWD'), 1005);
  assert.equal(convertMoney(29, 'USD', '7.12345678'), 207); assert.equal(convertMoney(29, 'USD'), null);
  assert.equal(decimalMoney(-9007199254740991), '-90071992547409.91');
  assert.throws(() => minorUnits('0.001')); assert.throws(() => minorUnits('1.5', 'JPY'));
});

test('nested failures roll back records and change entries; batch undo protects later changes', t => {
  const f = fixture(t), before = f.store.allEvents().length;
  assert.throws(() => f.manager.batch({ items: [{ type: 'personalProject', data: { title: '项目', status: 'active' } }, { type: 'personalTask', data: { title: '无效' } }] }));
  assert.equal(f.store.allEvents().length, before);
  f.store.change('部分失败测试', '用户', () => {
    try { f.store.transaction(() => { f.save('personalProject', { title: '不会保存', status: 'active' }); throw new Error('rollback'); }); } catch {}
    f.save('personalProject', { title: '保存', status: 'active' });
  });
  assert.equal(f.changes.list().rows[0].count, 1); assert.equal(f.manager.list().length, 1);
  const batch = f.changes.list().rows[0]; f.changes.undo({ id: batch.id }); assert.equal(f.manager.list().length, 0);
  const project = f.save('personalProject', { title: '另一个项目', status: 'active' }), creation = f.changes.list().rows.find(r => r.title === '保存项目');
  f.save(project.type, { ...project.data, title: '后续修改' }, { id: project.id, parents: project.heads });
  assert.throws(() => f.changes.undo({ id: creation.id }), /后续修改/);
});

test('transfers, refunds, budgets, assets and missing FX derive from valid entries', t => {
  const f = fixture(t), a = f.account(), b = f.account('储蓄', 'CNY', 0);
  f.entry(a, 'transfer', 1000, { toAccountId: b.id, toAmount: 1000 });
  const expense = f.entry(a, 'expense', 3000, { category: '餐饮' });
  f.entry(a, 'refund', 1000, { refundOf: expense.id });
  assert.throws(() => f.entry(a, 'refund', 2100, { refundOf: expense.id }), /累计退款/);
  f.save('moneyBudget', { title: '餐饮预算', month: '2026-10', category: '餐饮', amount: 4000, currency: 'CNY' });
  const r = f.manager.report({ month: '2026-10' });
  assert.equal(r.income, 0); assert.equal(r.expense, 2000); assert.equal(r.assets, 8000); assert.equal(r.budgets[0].remaining, 2000);
  assert.throws(() => f.manager.remove({ id: a.id, parents: a.heads }), /引用/);
  const usd = f.account('美元', 'USD', 100); f.entry(usd, 'income', 10);
  assert.equal(f.manager.report({ month: '2026-10' }).complete, false);
});

test('CSV preview validates before commit, duplicate batches do not book twice; exports roundtrip', t => {
  const f = fixture(t); f.account();
  const csv = 'date,title,account,amount,category\n2026-10-27,午餐,现金,0.29,餐饮\n2026-10-27,午餐,现金,0.29,餐饮';
  const preview = f.manager.csvPreview({ csv }); assert.equal(preview.errors.length, 0); assert.equal(preview.rows[1].duplicate, true);
  assert.equal(f.manager.csvImport({ csv, token: preview.token }).count, 1);
  assert.equal(f.manager.csvImport({ csv, token: f.manager.csvPreview({ csv }).token }).count, 0);
  const exported = f.manager.csvPreview({ csv: f.manager.csvExport() });
  assert.equal(exported.errors.length, 0); assert.equal(exported.rows[0].duplicate, true); assert.equal(exported.rows[0].data.amount, 29);
  assert.equal(f.manager.csvPreview({ csv: csv.replaceAll('2026-10-27', '2026-02-30') }).errors.length, 2);
});

test('subscription payment is atomic and the whole payment can be undone', t => {
  const f = fixture(t), a = f.account(), subscription = f.save('subscription', { title: '工具', amount: 199, currency: 'CNY', nextDate: '2026-01-31', cycle: 'monthly', status: 'active' });
  const input = { id: subscription.id, parents: subscription.heads, accountId: a.id, date: '2026-01-31' };
  f.manager.paySubscription(input);
  assert.equal(f.store.get(subscription.id).data.nextDate, '2026-02-28');
  assert.throws(() => f.manager.paySubscription(input), /变化/);
  f.changes.undo({ id: f.changes.list().rows.find(r => r.title === '记录订阅付款').id });
  assert.equal(f.manager.list({ type: 'moneyEntry' }).length, 0); assert.equal(f.store.get(subscription.id).data.nextDate, '2026-01-31');
});

test('password setup confirmation, wrong password, recovery, ciphertext drafts and idle lock', async t => {
  const f = fixture(t), account = f.save('loginAccount', { title: '账号' });
  const setup = await f.vault.setup({ password: 'correct master password' });
  assert.equal(f.vault.status().initialized, false);
  f.vault.confirmSetup({ token: setup.token, confirmed: true });
  f.vault.save({ accountId: account.id, value: { password: 'only-secret-X-987654', recoveryCodes: 'recovery-secret' } });
  f.vault.draft({ accountId: account.id, value: { password: 'draft-secret-X-123' } });
  assert.equal(JSON.stringify(f.store.allEvents()).includes('only-secret'), false);
  assert.equal(JSON.stringify(f.store.local(`vaultDraft:${account.id}`)).includes('draft-secret'), false);
  assert.equal(f.manager.search({ query: 'only-secret' }).length, 0);
  f.vault.lock(); assert.throws(() => f.vault.read({ accountId: account.id }), /解锁/);
  await assert.rejects(f.vault.unlock({ password: 'incorrect master password' }));
  await f.vault.unlock({ recoveryKey: setup.recoveryKey }); assert.equal(f.vault.read({ accountId: account.id }).value.password, 'only-secret-X-987654');
  await f.vault.resetMaster({ password: 'new master password' }); f.vault.lock();
  await f.vault.unlock({ password: 'new master password' });
  f.vault.lastUsed = Date.now() - 600001; assert.equal(f.vault.status().unlocked, false);
});

test('format 7 carries independent records, encrypted vault and batches while locked', async t => {
  const f = fixture(t), b = new Store(path.join(f.dir, 'B')), vaultB = new PasswordVault(b);
  t.after(() => { vaultB.close(); b.close(); });
  const account = f.save('loginAccount', { title: '同步账号' }), setup = await f.vault.setup({ password: 'portable password' });
  f.vault.confirmSetup({ token: setup.token, confirmed: true }); f.vault.save({ accountId: account.id, value: { password: 'synced secret' } });
  const syncA = new CurrentSync(f.store), syncB = new CurrentSync(b), folder = path.join(f.dir, 'channel'), key = makePairingKey();
  f.store.personalSystem = true; b.personalSystem = true;
  const file = path.join(f.dir, 'synced.txt'); fs.writeFileSync(file, 'central received original');
  const asset = await importAttachment(f.store, file, { domain: '__materials__' });
  syncA.configure(folder, key); syncB.configure(folder, key);
  await syncA.plan(); assert.equal(f.store.local('v3:plan')?.manifest?.format || syncA.value('plan').manifest.format, 7);
  await syncA.publish(); await syncB.importLatest();
  assert.equal(vaultB.status().unlocked, false); await vaultB.unlock({ password: 'portable password' });
  assert.equal(vaultB.read({ accountId: account.id }).value.password, 'synced secret');
  assert.ok(isCentralAsset(b, b.assetLocation(asset.id).path));
  assert.equal(fs.readFileSync(b.assetLocation(asset.id).path, 'utf8'), 'central received original');
  assert.equal(fs.existsSync(path.join(b.directory, 'received-objects', `${asset.data.sha256}.v3.partial`)), false);
  assert.equal((await syncB.importLatest()).imported, 0); assert.ok(b.list({ type: 'changeBatch' }).length);
  const projectId = uuid(), added = f.manager.batch({ title: '待撤回的项目批次', items: [
    { id: projectId, type: 'personalProject', data: { title: '跨机项目', status: 'active' } },
    { type: 'personalTask', data: { title: '跨机任务', projectId, status: 'todo', priority: 'normal' } }
  ] });
  await syncA.plan(); await syncA.publish(); await syncB.importLatest();
  const batch = f.changes.list().rows.find(r => r.title === '待撤回的项目批次');
  f.changes.undo({ id: batch.id }); await syncA.plan(); await syncA.publish(); await syncB.importLatest();
  assert.ok(added.records.every(r => b.get(r.id).deleted));
  assert.ok(b.list({ type: 'changeBatch' }).some(r => r.data.reversalOf === batch.id));
});

test('materials preserve IDs and history, validate copies and retain external sources', async t => {
  const f = fixture(t), domain = f.store.saveLibrary({ title: '旧知识库' }).data.domain;
  const source = path.join(f.dir, 'source.txt'); fs.writeFileSync(source, 'original material');
  const asset = await importAttachment(f.store, source, { domain }), history = f.store.history(asset.id).map(e => e.id);
  const center = new MaterialCenter(f.store, new LocalHierarchy(f.store)), preview = center.preview();
  assert.equal(preview.rows.length, 1); const result = await center.migrate({ token: preview.token, confirmed: true });
  assert.equal(result.state, 'complete'); assert.equal(f.store.get(asset.id).id, asset.id);
  assert.ok(history.every(id => f.store.event(id))); assert.equal(fs.existsSync(source), true);
  assert.equal(isCentralAsset(f.store, f.store.assetLocation(asset.id).path), true);
  assert.equal(await hashFile(f.store.assetLocation(asset.id).path), asset.data.sha256);
});

test('explicit user exports have a separate owned directory and preserve existing files', t => {
  const f = fixture(t), target = userExportPath(f.store, '../../账目.csv');
  assert.equal(target, path.join(f.store.directory, '.fengzai-y', 'exports', '账目.csv'));
  fs.writeFileSync(target, 'previous export');
  assert.equal(userExportPath(f.store, '账目.csv'), target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous export');
  assert.equal(path.basename(userExportPath(f.store, 'CON.txt')), 'FengZaiY-CON.txt');
  const marker = path.join(f.store.directory, '.fengzai-y', 'owner.json');
  fs.writeFileSync(marker, JSON.stringify({ deviceId: 'different-workspace' }));
  assert.throws(() => userExportPath(f.store, 'new.csv'), /归属不符/);
  assert.equal(fs.existsSync(path.join(path.dirname(target), 'new.csv')), false);
});

test('Agent nonsecret batches remain idempotent, atomic and revocable; vault is unreachable', t => {
  const f = fixture(t), access = new AgentAccess(f.store); t.after(() => access.close());
  const issued = access.createGrant({ name: '个人助手' }), grant = access.grants().find(g => g.id === issued.id);
  const requestId = uuid(), input = { preferencesVersion: access.preferences().version, items: [{ id: uuid(), type: 'personalProject', parents: [], data: { title: '计划', status: 'active' } }] };
  input.items.push({ type: 'personalTask', parents: [], data: { title: '执行', projectId: input.items[0].id, status: 'todo', priority: 'high' } });
  const result = access.dispatch(grant, { method: 'personalBatch', requestId, input }), count = f.store.allEvents().length;
  assert.deepEqual(access.dispatch(grant, { method: 'personalBatch', requestId, input }), result); assert.equal(f.store.allEvents().length, count);
  assert.equal(f.changes.list().rows[0].actor, 'Agent：个人助手');
  assert.throws(() => access.dispatch(grant, { method: 'accountSave', requestId: uuid(), input: { preferencesVersion: access.preferences().version, parents: [], data: { title: '非法秘密', password: 'secret' } } }));
  for (const method of ['vaultRead', 'vaultUnlock', 'changeUndo', 'materialMigrate']) assert.throws(() => access.dispatch(grant, { method }), { code: 'FORBIDDEN' });
  f.changes.undo({ id: f.changes.list().rows[0].id }); assert.equal(f.manager.list().length, 0);
  access.revoke(grant.id); assert.throws(() => access.dispatch(grant, { method: 'personalList' }), { code: 'UNAUTHORIZED' });
  assert.equal(access.status().audit.length, 0);
});

test('business references and local drafts protect notes and originals against recycle and purge', async t => {
  const f = fixture(t), domain = f.store.saveLibrary({ title: '引用库' }).data.domain, note = f.store.write({ data: { title: '笔记', domain } });
  const task = f.save('personalTask', { title: '查阅', status: 'todo', priority: 'normal', noteIds: [note.id] });
  assert.throws(() => f.store.remove(note.id, note.heads), /引用/);
  const file = path.join(f.dir, 'invoice.txt'); fs.writeFileSync(file, 'invoice'); f.store.personalSystem = true;
  const asset = await importAttachment(f.store, file, { domain: '__materials__' });
  assert.ok(!f.store.libraries().some(r => r.data.domain === '__materials__'));
  f.manager.draft({ view: 'tasks', value: { type: 'personalTask', data: { title: '未提交', assetIds: [asset.id] } } });
  assert.throws(() => f.store.remove(asset.id, asset.heads), /引用/);
  const erased = createErasure(f.store, asset.id); assert.throws(() => prepareRemoteErasure(f.store, [erased]), /未提交/);
  f.manager.draft({ view: 'tasks', clear: true }); f.manager.remove({ id: task.id, parents: task.heads });
  assert.throws(() => f.store.remove(note.id, note.heads), /引用/);
});

test('concurrent vault secrets remain encrypted until explicit unlock and resolution', async t => {
  const f = fixture(t), b = new Store(path.join(f.dir, 'B')), vaultB = new PasswordVault(b); t.after(() => { vaultB.close(); b.close(); });
  const account = f.save('loginAccount', { title: '并发账号' }), setup = await f.vault.setup({ password: 'concurrent master' });
  f.vault.confirmSetup({ token: setup.token, confirmed: true }); const saved = f.vault.save({ accountId: account.id, value: { password: 'initial secret' } });
  b.importEvents(f.store.allEvents()); await vaultB.unlock({ password: 'concurrent master' });
  f.vault.save({ accountId: account.id, parents: saved.parents, value: { password: 'changed on A' } });
  vaultB.save({ accountId: account.id, parents: saved.parents, value: { password: 'changed on B' } });
  f.store.importEvents(b.allEvents()); assert.throws(() => f.vault.read({ accountId: account.id }), /并发/);
  const branches = f.store.get(saved.id); assert.equal(branches.heads.length, 2);
  const chosen = f.vault.read({ accountId: account.id, revision: branches.heads[0] });
  f.vault.save({ accountId: account.id, parents: chosen.parents, value: chosen.value });
  assert.equal(f.store.get(saved.id).conflict, false); assert.equal(f.store.history(saved.id).length, 4);
});

test('material migration validates tampering, retains progress and retries after space recovers', async t => {
  const f = fixture(t), domain = f.store.saveLibrary({ title: '迁移库' }).data.domain, file = path.join(f.dir, 'old.txt'); fs.writeFileSync(file, 'old file');
  const asset = await importAttachment(f.store, file, { domain }), original = f.store.assetLocation(asset.id).path;
  const center = new MaterialCenter(f.store, new LocalHierarchy(f.store)), preview = center.preview(), statfs = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ bavail: 0, bsize: 4096 });
    const failed = await center.migrate({ token: preview.token, confirmed: true }); assert.equal(failed.state, 'pending'); assert.equal(failed.done.length, 0);
    assert.equal(f.store.assetLocation(asset.id).path, original);
  } finally { fs.statfsSync = statfs; }
  assert.equal((await center.migrate({ resume: true })).state, 'complete');
  assert.equal(fs.existsSync(file), true);
});

test('material migration resumes after copy and binding failures without overwriting changed files', async t => {
  const f = fixture(t), domain = f.store.saveLibrary({ title: '故障迁移' }).data.domain;
  const file = path.join(f.dir, 'old-original.txt'); fs.writeFileSync(file, 'verified original');
  const asset = await importAttachment(f.store, file, { domain }), original = f.store.assetLocation(asset.id).path;
  const center = new MaterialCenter(f.store, new LocalHierarchy(f.store)), preview = center.preview();
  const copy = fs.promises.copyFile;
  try {
    fs.promises.copyFile = async () => { throw Object.assign(new Error('测试文件占用'), { code: 'EBUSY' }); };
    assert.equal((await center.migrate({ token: preview.token, confirmed: true })).state, 'pending');
  } finally { fs.promises.copyFile = copy; }
  assert.equal(f.store.assetLocation(asset.id).path, original);
  const bind = f.store.bindAsset;
  try {
    f.store.bindAsset = () => { throw new Error('测试绑定事务失败'); };
    assert.equal((await center.migrate({ resume: true })).done.length, 0);
  } finally { f.store.bindAsset = bind; }
  assert.deepEqual(f.store.headIds(asset.id), asset.heads);
  assert.equal(f.store.assetLocation(asset.id).path, original);
  fs.writeFileSync(preview.rows[0].target, 'manual modification');
  const restarted = new MaterialCenter(f.store, new LocalHierarchy(f.store));
  assert.equal((await restarted.migrate({ resume: true })).state, 'pending');
  assert.equal(fs.readFileSync(preview.rows[0].target, 'utf8'), 'manual modification');
  fs.writeFileSync(preview.rows[0].target, 'verified original');
  assert.equal((await restarted.migrate({ resume: true })).state, 'complete');
  assert.equal(fs.readFileSync(file, 'utf8'), 'verified original');
});

test('password clipboard expires only the copied value', async () => {
  let value = '', clears = 0;
  const clipboard = new SecretClipboard({ writeText: text => { value = text; }, readText: () => value, clear: () => { value = ''; clears++; } }, 10);
  clipboard.copy('secret'); value = 'new unrelated text'; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(value, 'new unrelated text'); assert.equal(clears, 0);
  clipboard.copy('secret'); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(value, ''); assert.equal(clears, 1);
});

test('independently initialized vaults merge with both credentials and retain all historical keys', async t => {
  const f = fixture(t), b = new Store(path.join(f.dir, 'B')), other = new PersonalManager(b), vaultB = new PasswordVault(b);
  t.after(() => { vaultB.close(); b.close(); });
  const a = f.save('loginAccount', { title: 'A 账号' }), bb = other.save({ type: 'loginAccount', data: { title: 'B 账号' } });
  const setupA = await f.vault.setup({ password: 'master password A' }), setupB = await vaultB.setup({ password: 'master password B' });
  f.vault.confirmSetup({ token: setupA.token, confirmed: true }); vaultB.confirmSetup({ token: setupB.token, confirmed: true });
  const beforeA = f.vault.save({ accountId: a.id, value: { password: 'secret from A' } });
  vaultB.save({ accountId: bb.id, value: { password: 'secret from B' } });
  f.store.importEvents(b.allEvents()); assert.equal(f.vault.status().conflict, true); assert.equal(f.vault.status().unlocked, false);
  const credentials = f.vault.status().configurations.map(c => ({ revision: c.id, recoveryKey: c.deviceId === f.store.deviceId ? setupA.recoveryKey : setupB.recoveryKey }));
  const merged = await f.vault.resolveSetup({ credentials, password: 'merged master password' });
  assert.equal(f.vault.status().conflict, true);
  f.vault.confirmSetup({ token: merged.token, confirmed: true }); assert.equal(f.vault.status().conflict, false);
  assert.equal(f.vault.read({ accountId: a.id }).value.password, 'secret from A');
  assert.equal(f.vault.read({ accountId: bb.id }).value.password, 'secret from B');
  f.vault.save({ accountId: a.id, parents: beforeA.parents, value: { password: 'new secret' } });
  assert.equal(f.vault.read({ accountId: a.id, revision: beforeA.parents[0] }).value.password, 'secret from A');
  f.vault.lock(); await f.vault.unlock({ recoveryKey: merged.recoveryKey }); assert.equal(f.vault.read({ accountId: bb.id }).value.password, 'secret from B');
});
