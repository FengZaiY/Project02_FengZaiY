import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/local-audit/business'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'case-')), port: 0 });
let browser, page, releaseSecret;
try {
  const service = app.service, store = service.store;
  const library = store.saveLibrary({ title: '业务关联' });
  const note = store.write({ type: 'note', data: { title: '关联笔记', domain: library.id, content: '关联原文' } });
  const file = path.join(root, '材料.txt'); fs.writeFileSync(file, '关联原件');
  const asset = await service.call('assetImport', { path: file, domain: '__materials__' });
  const cash = service.personal.save({ type: 'moneyAccount', data: { title: '现金', currency: 'CNY', kind: 'cash', opening: 100000, openingDate: '2026-01-01' } });
  const bank = service.personal.save({ type: 'moneyAccount', data: { title: '储蓄', currency: 'CNY', kind: 'cash', opening: 0, openingDate: '2026-01-01' } });
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  page = await browser.newPage({ viewport: { width: 1440, height: 950 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  await page.goto(app.url); await page.locator('[data-nav=tasks]').waitFor();
  async function create(view, type, data) {
    await page.locator(`[data-nav=${view}]`).click();
    await page.locator(`[data-personal-type=${type}]`).click();
    await page.locator(`[data-personal-type=${type}].selected`).waitFor();
    await page.locator('[data-personal=new]').click();
    for (const [name, value] of Object.entries(data)) {
      const field = page.locator(`#personal-form [name=${name}]`);
      if (await field.evaluate(el => el.tagName === 'SELECT')) await field.selectOption(value);
      else await field.fill(value);
    }
    await page.locator('#personal-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#personal-save-state')?.textContent === '已保存');
    const record = service.personal.list({ type }).find(r => r.data.title === data.title);
    assert.ok(record, `Saved ${type}: ${data.title}`); return record;
  }
  const project = await create('tasks', 'personalProject', { title: '年度整理', status: 'active' });
  const parent = await create('tasks', 'personalTask', { title: '整理资料', projectId: project.id });
  const child = await create('tasks', 'personalTask', { title: '核对附件', projectId: project.id, parentTaskId: parent.id, priority: 'high', startDate: '2026-10-01', dueDate: '2026-10-31', noteIds: [note.id], assetIds: [asset.id] });
  await page.locator('.personal-relations summary').click(); await page.locator(`[data-open-linked="${note.id}"]`).click();
  await page.locator('#note-title').waitFor(); assert.equal(await page.locator('#note-title').inputValue(), note.data.title);
  const expense = await create('finance', 'moneyEntry', { title: '书籍支出', kind: 'expense', accountId: cash.id, amount: '10.00', date: '2026-10-01', category: '学习', assetIds: [asset.id] });
  await create('finance', 'moneyEntry', { title: '储蓄转账', kind: 'transfer', accountId: cash.id, toAccountId: bank.id, amount: '20.00', toAmount: '20.00', date: '2026-10-01' });
  await create('finance', 'moneyEntry', { title: '退回书籍', kind: 'refund', accountId: cash.id, amount: '2.00', date: '2026-10-02', refundOf: expense.id });
  await create('finance', 'moneyBudget', { title: '学习预算', category: '学习', month: '2026-10', amount: '50.00' });
  const login = await create('accounts', 'loginAccount', { title: '资料账号', username: 'test-only' });
  const sub = await create('accounts', 'subscription', { title: '资料订阅', accountId: login.id, amount: '3.00', nextDate: '2026-10-01' });
  async function pay(amount) {
    await page.locator('[data-personal=pay]').click();
    await page.locator('#payment-form [name=accountId]').selectOption(cash.id);
    await page.locator('#payment-form [name=date]').fill('2026-10-01');
    await page.locator('#payment-form [name=amount]').fill(amount);
    await page.locator('#payment-form button').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#personal-form [name=nextDate]')?.value === '2026-11-01');
  }
  await pay('3.00');
  await page.locator('[data-nav=changes]').click();
  const payment = service.changes.list().rows.find(r => r.title === '记录订阅付款');
  await page.locator(`[data-change-id="${payment.id}"]`).click(); await page.locator('#change-undo').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(store.get(sub.id).data.nextDate, '2026-10-01');
  await page.locator('[data-nav=accounts]').click();
  await page.waitForFunction(() => document.querySelector('#personal-form [name=nextDate]')?.value === '2026-10-01');
  await pay('4.00');
  await page.locator('[data-nav=finance]').click(); await page.locator('[data-personal=csv]').click();
  const csv = `日期,名称,类型,账户,金额,原支出\n2026-10-03,CSV退款,refund,现金,1.00,${expense.id}`;
  await page.locator('#finance-file').setInputFiles({ name: '账目.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  for (const [field, column] of Object.entries({ date: '日期', title: '名称', kind: '类型', account: '账户', amount: '金额', refundOf: '原支出' })) await page.locator(`[data-csv-field=${field}]`).selectOption(column);
  await page.locator('#csv-preview').click(); await page.locator('#csv-import:not([disabled])').waitFor();
  await page.locator('#csv-import').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(service.personal.report({ month: '2026-10' }).expense, 1100);
  await page.locator('[data-personal-type=overview]').click(); await page.locator('#finance-month').fill('2026-10');
  await page.locator('#finance-month').dispatchEvent('change');
  await page.locator('.finance-cards', { hasText: '11.00' }).waitFor();
  await page.screenshot({ path: path.join(root, 'finance-workflow.png') });
  const download = page.waitForEvent('download'); await page.locator('[data-personal=export]').click();
  const exported = await download; await exported.saveAs(path.join(root, '账目.csv')); assert.match(fs.readFileSync(path.join(root, '账目.csv'), 'utf8'), /CSV退款/);
  await page.locator('[data-nav=tasks]').click(); await page.locator(`[data-personal-id="${child.id}"]`).click();
  await page.locator('[data-personal=delete]').click(); await page.locator('[data-confirm]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); assert.equal(store.get(child.id).deleted, true);
  await page.locator('[data-nav=trash]').click(); await page.locator(`[data-record="${child.id}"]`).click();
  await page.locator('[data-personal=restore]').waitFor();
  assert.equal(await page.locator('#personal-form button[type=submit]').isDisabled(), true);
  assert.equal(await page.locator('#personal-form [name=title]').isDisabled(), true);
  await page.locator('[data-personal=restore]').click();
  await page.locator('[data-personal=restore]').waitFor({ state: 'detached' }); assert.equal(store.get(child.id).deleted, false);
  const setup = await service.passwordVault.setup({ password: 'initial-audit-password' }); service.passwordVault.confirmSetup({ token: setup.token, confirmed: true }); service.passwordVault.lock();
  await page.locator('[data-nav=accounts]').click(); await page.locator('[data-personal=vault]').click();
  await page.locator('#vault-access [name=mode]').selectOption('recoveryKey');
  await page.locator('#vault-access [name=secret]').fill(setup.recoveryKey);
  await page.locator('#vault-access button').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('[data-personal=vault]').click(); await page.locator('#vault-reset [name=password]').fill('changed-audit-password');
  await page.locator('#vault-reset button').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('[data-personal=lock]').click(); await page.locator('[data-personal=vault]').click();
  await page.locator('#vault-access [name=secret]').fill('changed-audit-password'); await page.locator('#vault-access button').click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); assert.equal(service.passwordVault.status().unlocked, true);
  await page.locator('[data-personal-type=loginAccount]').click(); await page.locator(`[data-personal-id="${login.id}"]`).click();
  await page.locator('[data-personal=secret]').click(); await page.locator('#secret-form [name=password]').fill('saved-audit-secret');
  let reachedSecret; const secretStarted = new Promise(resolve => { reachedSecret = resolve; });
  const secretGate = new Promise(resolve => { releaseSecret = resolve; });
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'vaultSave') { reachedSecret(); await secretGate; }
    await route.continue();
  });
  await page.locator('#secret-form button[type=submit]').click(); await secretStarted;
  assert.equal(await page.locator('#secret-form [name=password]').isDisabled(), true);
  assert.equal(await page.locator('#secret-form button[type=submit]').isDisabled(), true);
  releaseSecret(); await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(service.passwordVault.read({ accountId: login.id }).value.password, 'saved-audit-secret');
  assert.deepEqual(errors, []);
  console.log('PASS: project/subtask links, transfer/refund/budget, subscription payment/undo/correction, mapped CSV refund/export, task recycle/restore and recovery-key master reset.');
} catch (error) { await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error; }
finally { releaseSecret?.(); await browser?.close(); await app.close(); }
