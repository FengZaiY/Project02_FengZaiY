import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { call } from '../skills/fengzaiy/scripts/client.mjs';
import { uuid } from '../src/core/util.mjs';
import { skillExportFiles } from '../web/skill-export.js';

const root = path.resolve('artifacts/ui-agent-operations');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const grant = app.service.agents.createGrant({ name: '本机审批测试 Agent' });
await app.service.agents.configure(true);
const env = { FENGZAIY_AGENT_URL: app.service.agents.status().mcpUrl, FENGZAIY_AGENT_TOKEN: grant.token };
const request = (operation, input = {}) => call('operation', { operation, input, preferencesVersion: app.service.agents.preferences().version }, uuid(), env);
const installation = path.join(fs.mkdtempSync(path.join(root, 'installed-')), 'fengzaiy');
for (const [name, content] of Object.entries(skillExportFiles(app.service.agents.skillPackage()))) {
  const file = path.join(installation, name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
const manager = app.service.skillInstallations;
manager.confirm({ token: manager.preview({ directory: installation }).token, confirmed: true });
let browser;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('[data-nav="agents"]').click();
  await page.locator('#agent-operation-requests').waitFor();
  await page.locator('#agent-grant-form input[name="name"]').fill('未提交的授权名称');
  const pending = await request('librarySave', { title: '隔离演示知识库' });
  await new Promise(resolve => setTimeout(resolve, 5));
  manager.nextCheck = 0; manager.tick();
  await page.locator('[data-refresh-requests]').click();
  await page.locator(`[data-review-request="${pending.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  assert.equal(app.service.store.libraries().length, 0);
  await page.locator('#modal [data-modal-close]').click();
  assert.equal(app.service.agentOperations.list()[0].state, 'pending');
  await page.locator(`[data-review-request="${pending.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const button = page.locator('#agent-request-approve'); await button.scrollIntoViewIfNeeded();
    assert.ok(await button.isVisible());
    await page.screenshot({ path: path.join(root, `approval-${width}.png`) });
  }
  await page.locator('#agent-request-approve').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  assert.equal(app.service.store.libraries().length, 1);
  assert.equal(await page.locator('#agent-grant-form input[name="name"]').inputValue(), '未提交的授权名称');
  const rejected = await request('librarySave', { title: '应拒绝' });
  await page.locator('[data-refresh-requests]').click();
  await page.locator(`[data-review-request="${rejected.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  await page.locator('#agent-request-reject').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  assert.equal(app.service.store.libraries().length, 1);
  await page.locator(`[data-request="${rejected.id}"]`).waitFor({ state: 'detached' });
  await page.locator('[data-refresh-requests]').click();
  assert.equal(await page.locator(`[data-request="${rejected.id}"]`).count(), 0);
  assert.equal((await call('operationResult', { id: rejected.id }, undefined, env)).state, 'rejected');
  const stale = await request('librarySave', { title: '旧请求' });
  app.service.store.saveLibrary({ title: '后续修改' });
  await page.locator('[data-refresh-requests]').click();
  await page.locator(`[data-review-request="${stale.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#agent-request-approve').isDisabled(), true);
  await page.locator('#agent-request-reject').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  const unlock = await request('vaultUnlock');
  await page.locator('[data-refresh-requests]').click();
  await page.locator(`[data-review-request="${unlock.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  await page.locator('#agent-request-approve').click();
  await page.locator('#vault-access').waitFor();
  assert.equal(app.service.passwordVault.status().unlocked, false);
  await page.locator('#vault-access input[name="secret"]').fill('isolated-ui-master-2026');
  await page.locator('#vault-access button').click();
  await page.locator('#vault-confirm').check();
  await page.locator('#vault-finish').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  assert.equal(app.service.passwordVault.status().unlocked, true);
  assert.equal((await call('operationResult', { id: unlock.id }, undefined, env)).state, 'completed');
  await page.locator('[data-refresh-requests]').click();
  await page.screenshot({ path: path.join(root, 'requests-600.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: approval after Skill checks, hidden rejected requests with retained receipts, stale review, preserved input, vault workflow and 1220/931/600 layouts.');
} finally { await browser?.close(); await app.close(); }
