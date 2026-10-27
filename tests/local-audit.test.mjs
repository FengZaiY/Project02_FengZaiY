import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';

const root = path.resolve('artifacts/local-audit/regressions');
fs.mkdirSync(root, { recursive: true });
function setup(t) {
  const service = new Service(fs.mkdtempSync(path.join(root, 'case-')));
  t.after(() => service.close());
  const manager = service.personal;
  const account = manager.save({ type: 'moneyAccount', data: { title: '现金', kind: 'cash', currency: 'CNY', opening: 10000, openingDate: '2026-01-01' } });
  return { service, manager, account, store: service.store };
}

test('subscription payment can be corrected after whole-batch undo without duplicating its period', t => {
  const { service, manager, account, store } = setup(t);
  const sub = manager.save({ type: 'subscription', data: { title: '订阅', amount: 100, currency: 'CNY', nextDate: '2026-10-01', cycle: 'monthly', status: 'active' } });
  const input = { id: sub.id, parents: sub.heads, accountId: account.id, date: '2026-10-01' };
  const paid = manager.paySubscription(input);
  service.changes.undo({ id: service.changes.list().rows.find(r => r.title === '记录订阅付款').id });
  const corrected = manager.paySubscription({ ...input, parents: store.headIds(sub.id), amount: 200 });
  assert.equal(corrected.id, paid.id);
  assert.equal(manager.report({ month: '2026-10' }).expense, 200);
  assert.equal(store.get(sub.id).data.nextDate, '2026-11-01');
  assert.throws(() => manager.paySubscription(input), { code: 'CONFLICT' });
  assert.equal(manager.list({ type: 'moneyEntry' }).length, 1);
});

test('CSV import can be repeated after undo while retaining record identity and rejecting stale previews', t => {
  const { service, manager } = setup(t);
  const csv = 'date,title,account,amount\n2026-10-01,购买资料,现金,0.29';
  const preview = manager.csvPreview({ csv });
  const first = manager.csvImport({ csv, token: preview.token });
  service.changes.undo({ id: service.changes.list().rows.find(r => r.title === 'CSV 导入账目').id });
  assert.throws(() => manager.csvImport({ csv, token: preview.token }), { code: 'CONFLICT' });
  const second = manager.csvImport({ csv, token: manager.csvPreview({ csv }).token });
  assert.deepEqual(second.ids, first.ids);
  assert.equal(manager.report({ month: '2026-10' }).expense, 29);
});

test('undoing the first secret save leaves a usable empty editor and recoverable encrypted history', async t => {
  const { service, manager, store } = setup(t), vault = service.passwordVault;
  const account = manager.save({ type: 'loginAccount', data: { title: '账号' } });
  const prepared = await vault.setup({ password: 'audit-master-password' });
  vault.confirmSetup({ token: prepared.token, confirmed: true });
  const first = vault.save({ accountId: account.id, value: { password: 'audit-secret-before' } });
  service.changes.undo({ id: service.changes.list().rows.find(r => r.title === '保存密码').id });
  const empty = vault.read({ accountId: account.id });
  assert.equal(empty.value.password, '');
  assert.deepEqual(empty.parents, store.headIds(first.id));
  assert.equal(vault.read({ accountId: account.id, revision: first.parents[0] }).value.password, 'audit-secret-before');
  vault.save({ accountId: account.id, parents: empty.parents, value: { password: 'audit-secret-after' } });
  assert.equal(vault.read({ accountId: account.id }).value.password, 'audit-secret-after');
  assert.ok(!JSON.stringify(store.allEvents()).includes('audit-secret'));
});

test('moving an account opening date cannot silently exclude existing ledger entries', t => {
  const { manager, account } = setup(t);
  manager.save({ type: 'moneyEntry', data: { title: '支出', accountId: account.id, currency: 'CNY', kind: 'expense', amount: 500, date: '2026-02-01' } });
  assert.throws(() => manager.save({ id: account.id, parents: account.heads, type: account.type, data: { ...account.data, openingDate: '2026-03-01' } }));
  assert.equal(manager.report({ month: '2026-02' }).expense, 500);
  assert.equal(manager.report({ month: '2026-02' }).complete, true);
});
