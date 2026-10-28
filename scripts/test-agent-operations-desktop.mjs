import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { call } from '../skills/fengzaiy/scripts/client.mjs';
import { uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/desktop-agent-operations');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'profile-'));
const app = await electron.launch({ executablePath: electronPath, args: [path.resolve('.'), '--smoke-test', `--data-dir=${profile}`], timeout: 40000 });
try {
  const page = await app.firstWindow();
  await page.locator('[data-nav=agents]').waitFor();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const bootstrap = await page.evaluate(async () => {
    await window.desktop.call('agentConfigure', { enabled: true });
    const grant = await window.desktop.call('agentGrant', { name: '隔离桌面 MCP' });
    const status = await window.desktop.call('agentStatus');
    return { url: status.mcpUrl, token: grant.token, preferencesVersion: status.preferences.version };
  });
  const env = { FENGZAIY_AGENT_URL: bootstrap.url, FENGZAIY_AGENT_TOKEN: bootstrap.token };
  const request = operation => call('operation', { operation, input: {}, preferencesVersion: bootstrap.preferencesVersion }, uuid(), env);
  const status = await request('updateStatus');
  await page.locator('[data-nav=agents]').click();
  await page.locator(`[data-review-request="${status.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  await page.locator('#agent-request-approve').click();
  await page.waitForFunction(id => document.querySelector(`[data-request="${id}"]`)?.textContent.includes('已完成'), status.id);
  const result = await call('operationResult', { id: status.id }, undefined, env);
  assert.equal(result.state, 'completed'); assert.equal(result.value.phase, 'development');
  const install = await request('updateInstall');
  await page.locator('[data-refresh-requests]').click();
  await page.locator(`[data-review-request="${install.id}"]`).click();
  await page.locator('.agent-review').waitFor({ state: 'visible' });
  await page.locator('#agent-request-approve').click();
  await page.locator('#upgrade-settings').waitFor();
  assert.equal((await call('operationResult', { id: install.id }, undefined, env)).state, 'local_action_required');
  assert.equal(await page.locator('[data-update=install]').count(), 0);
  await page.screenshot({ path: path.join(root, 'native-request-settings.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: actual Electron MCP -> native update status result; install request enters local settings without executing installation.');
} finally { await app.close(); }
