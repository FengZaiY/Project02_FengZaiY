import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { call } from '../skills/fengzaiy/scripts/client.mjs';
import { uuid } from '../src/core/util.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve('artifacts/ui-agents');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '自主研究' });
const existingPreferences = app.service.agents.savePreferences({ content: '已有偏好：保留完整出处。', parents: [] });
let browser, mcpClient;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1165, height: 892 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#agent-preferences-form').waitFor();
  assert.equal(await page.locator('#main .page-heading h1').innerText(), '系统设置');
  assert.equal(await page.locator('#agent-preferences-form textarea').inputValue(), existingPreferences.content);
  assert.equal(await page.locator('[data-action="agent-export"]').count(), 1);
  assert.equal(await page.locator('#agent-enabled,#agent-grant-form').count(), 0);
  assert.equal(app.service.agents.status().enabled, false);
  assert.deepEqual(app.service.agents.preferences().heads, existingPreferences.heads);
  await page.locator('[data-nav="agents"]').click();
  await page.locator('#agent-enabled').waitFor();
  assert.equal(await page.locator('#agent-preferences-form,[data-action="agent-export"]').count(), 0);
  assert.equal(await page.locator('#agent-enabled').isChecked(), false);
  assert.equal(await page.locator('#agent-mcp-copy-config').isDisabled(), true);
  await page.locator('#agent-enabled').check();
  await page.waitForFunction(() => document.querySelector('#agent-mcp-url')?.textContent.startsWith('http:'));
  const url = new URL(await page.locator('#agent-mcp-url').innerText()).origin;
  assert.equal(await page.locator('#agent-url').count(), 0);
  assert.equal(await page.getByRole('heading', { name: '连接', exact: true }).count(), 0);
  assert.equal(await page.locator('#agent-mcp-url').innerText(), `${url}/mcp`);
  assert.match(await page.locator('#agent-mcp-config').inputValue(), /bearer_token_env_var = "FENGZAIY_AGENT_TOKEN"/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#agent-mcp-copy-url').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${url}/mcp`);
  await page.locator('#agent-mcp-client').selectOption('http');
  await page.locator('#agent-mcp-copy-config').click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.mcpServers.FengZaiY.url, `${url}/mcp`);
  assert.match(copied.mcpServers.FengZaiY.headers.Authorization, /填写/);
  const copyTargets = [
    { button: '#agent-mcp-copy-url', target: '#agent-mcp-url', label: '地址' },
    { button: '#agent-mcp-copy-config', target: '#agent-mcp-config', label: '配置', client: 'codex' },
    { button: '#agent-mcp-copy-config', target: '#agent-mcp-config', label: '配置', client: 'http' }
  ];
  await page.evaluate(() => {
    window.clipboardTest = { writeText: navigator.clipboard.writeText, execCommand: document.execCommand };
  });
  try {
    for (const mode of ['denied', 'unavailable']) {
      await page.evaluate(mode => {
        navigator.clipboard.writeText = mode === 'unavailable' ? undefined : async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); };
      }, mode);
      for (const { button, target, client } of copyTargets) {
        if (client) await page.locator('#agent-mcp-client').selectOption(client);
        const expected = client ? await page.locator(target).inputValue() : `${url}/mcp`;
        await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
        await page.locator(button).click();
        await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制');
        // Native Windows copy may normalize line endings to CRLF.
        assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), expected, `${mode}: ${client || 'URL'}`);
        assert.equal(await page.locator('body > textarea').count(), 0);
        assert.equal(await page.locator(button).evaluate(element => element === document.activeElement), true);
      }
    }
    for (const mode of ['false', 'throw']) {
      await page.evaluate(mode => {
        navigator.clipboard.writeText = async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); };
        document.execCommand = () => {
          if (mode === 'throw') throw new DOMException('Copy blocked', 'NotAllowedError');
          return false;
        };
      }, mode);
      for (const { button, target, client, label } of copyTargets) {
        if (client) await page.locator('#agent-mcp-client').selectOption(client);
        const expected = client ? await page.locator(target).inputValue() : `${url}/mcp`;
        const previousClipboard = await page.evaluate(() => navigator.clipboard.readText());
        await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
        await page.locator(button).click();
        await page.waitForFunction(label => document.querySelector('#toast').textContent === `自动复制受限，已选中${label}，请按 Ctrl+C 复制`, label);
        assert.equal(await page.locator(target).evaluate(element => element instanceof HTMLTextAreaElement
          ? element.value.slice(element.selectionStart, element.selectionEnd) : window.getSelection().toString()), expected);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), previousClipboard, 'manual fallback does not claim or perform a copy');
        assert.equal(await page.locator('body > textarea').count(), 0, 'failed legacy copy cleans up temporary input');
        assert.equal(await page.locator(target).evaluate(element => element === document.activeElement), true);
      }
    }
    await page.screenshot({ path: path.join(root, 'mcp-copy-manual.png'), fullPage: true });
  } finally {
    await page.evaluate(() => {
      navigator.clipboard.writeText = window.clipboardTest.writeText;
      document.execCommand = window.clipboardTest.execCommand;
      delete window.clipboardTest;
    });
  }
  await page.locator('#agent-grant-form input[name=name]').fill('外部整理助手');
  assert.equal(await page.locator('#agent-grant-form input[name=domains],#agent-grant-form details').count(), 0);
  await page.locator('#agent-grant-form button[type=submit]').click();
  await page.locator('#agent-token').waitFor();
  const token = await page.locator('#agent-token').inputValue();
  assert.equal(await page.locator('#agent-token').getAttribute('type'), 'password');
  const env = { FENGZAIY_AGENT_URL: url, FENGZAIY_AGENT_TOKEN: token };
  await page.locator('#modal [data-modal-close]').click();
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#agent-preferences-form textarea').fill('每个案例附适用条件，不做默认优劣排名。');
  await page.locator('#agent-preferences-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('偏好版本已保存'));
  await page.reload();
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#agent-preferences-form').waitFor();
  assert.equal(await page.locator('#agent-preferences-form textarea').inputValue(), '每个案例附适用条件，不做默认优劣排名。');
  const boot = await call('bootstrap', {}, undefined, env);
  mcpClient = new Client({ name: 'fengzaiy-ui-test', version: '1.0.0' });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.ok((await mcpClient.listTools()).tools.some(tool => tool.name === 'FengZaiY_propose'));
  assert.match(boot.preferences.content, /适用条件/);
  const source = await call('sourceCreate', { preferencesVersion: boot.preferences.version,
    data: { title: '课程原文', domain: library.id, content: '原始课程资料', url: 'https://example.invalid/course' } }, uuid(), env);
  const proposed = await mcpClient.callTool({ name: 'FengZaiY_propose', arguments: { requestId: uuid(), preferencesVersion: boot.preferences.version, title: '外部 Agent 整理方案', domain: library.id,
    content: '待补充：第二节课程截图',
    items: ['概念', '案例'].map(title => ({ data: { title, domain: library.id, content: `${title}的待确认正文`, sourceIds: [source.id] } })) } });
  assert.ok(!proposed.isError, proposed.content[0].text);
  const proposal = proposed.structuredContent.value;
  await page.locator('[data-nav="notes"]').click();
  await page.locator('[data-nav="proposals"]').click();
  await page.locator(`[data-record="${proposal.id}"]`).click();
  await page.locator('.proposal-summary', { hasText: '第二节课程截图' }).waitFor();
  await page.locator('[data-action="toggle-source"]').click();
  await page.locator(`#source-pane [data-record="${source.id}"]`).waitFor();
  await page.screenshot({ path: path.join(root, 'proposal-sources.png'), fullPage: true });
  await page.locator(`#source-pane [data-record="${source.id}"]`).click();
  await page.locator('.source-url a').waitFor();
  assert.equal(await page.locator('.source-url a').getAttribute('href'), 'https://example.invalid/course');
  await page.locator('.work-tab', { hasText: '外部 Agent 整理方案' }).click();
  await page.locator('[data-proposal-item]').first().check();
  await page.locator('[data-action="approve"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-item]:disabled').length === 1);
  assert.equal(app.service.store.list({ type: 'note' }).length, 1);
  await page.locator('[data-nav="agents"]').click();
  for (const [width, height] of [[1480, 940], [1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#agent-enabled').waitFor();
    await page.locator('#main').evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    const footer = await page.locator('.statusbar').boundingBox();
    assert.ok(footer.y + footer.height <= height + 1);
    await page.screenshot({ path: path.join(root, `agents-${width}.png`), fullPage: true });
    await page.locator('#agent-mcp-client').selectOption('http');
    await page.locator('#agent-mcp-config').scrollIntoViewIfNeeded();
    const configBox = await page.locator('#agent-mcp-config').boundingBox();
    assert.ok(configBox.x >= 0 && configBox.x + configBox.width <= width, 'MCP configuration fits viewport');
    await page.screenshot({ path: path.join(root, `mcp-${width}.png`), fullPage: true });
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const audit = await page.locator('.settings-section').last().boundingBox();
    assert.ok(audit.y < height && audit.y + audit.height <= height + 1, 'audit is reachable');
    await page.screenshot({ path: path.join(root, `agents-bottom-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1165, height: 892 });
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#agent-preferences-form').waitFor();
  for (const [width, height] of [[1480, 940], [1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(root, `settings-${width}.png`), fullPage: true });
    await page.getByText('需求基线', { exact: true }).click();
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const save = await page.locator('#agent-preferences-form button[type=submit]').boundingBox();
    const footer = await page.locator('.statusbar').boundingBox();
    await page.screenshot({ path: path.join(root, `settings-bottom-${width}.png`), fullPage: true });
    assert.ok(save.y >= 0 && save.y + save.height <= footer.y, `settings save remains reachable below baseline: ${JSON.stringify({ width, save, footer })}`);
    assert.ok(footer.y + footer.height <= height + 1);
    await page.getByText('需求基线', { exact: true }).click();
  }
  await page.setViewportSize({ width: 1165, height: 892 });
  const download = page.waitForEvent('download');
  await page.locator('[data-action="agent-export"]').click();
  await (await download).saveAs(path.join(root, 'FengZaiY.zip'));
  await page.locator('[data-nav="agents"]').click();
  await page.locator('[data-action="agent-revoke"]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('尚无授权'));
  assert.equal(app.service.agents.grants().length, 0);
  assert.equal(app.service.agents.status().audit.length, 0);
  assert.equal(app.service.store.db.prepare('SELECT COUNT(*) AS n FROM agent_requests').get().n, 0);
  assert.equal(await page.locator('#main').innerText().then(text => text.includes('已撤销')), false);
  await assert.rejects(call('bootstrap', {}, undefined, env), /UNAUTHORIZED/);
  await assert.rejects(mcpClient.listTools(), /401|授权/);
  await page.locator('#agent-enabled').uncheck();
  await page.waitForFunction(() => document.querySelector('#agent-mcp-url')?.textContent === '未开启');
  assert.equal(await page.locator('#agent-mcp-url').innerText(), '未开启');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: ['system settings entry', 'preserve existing preferences', 'MCP-only connection panel', 'enable', 'all-library grant without permission checkboxes', 'preferences persistence', 'MCP script source and SDK proposal', 'MCP config and clipboard', 'clipboard denied/unavailable fallback for URL and both configurations', 'manual selection and cleanup on legacy false/throw', 'partial approval', 'settings skill ZIP', 'revoke deletes grant/audit/receipts', 'disable', 'scroll and resize'] }, null, 2));
  console.log('PASS: Agent authorization, external API to reviewed proposal, preferences, Skill export and revocation.');
} finally { await mcpClient?.close(); await browser?.close(); await app.close(); }
