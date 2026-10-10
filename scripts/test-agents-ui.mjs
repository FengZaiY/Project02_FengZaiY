import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { call } from '../skills/studyself-organize/scripts/client.mjs';
import { uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/ui-agents');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '自主研究' });
const existingPreferences = app.service.agents.savePreferences({ content: '已有偏好：保留完整出处。', parents: [] });
let browser;
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
  await page.locator('#agent-enabled').check();
  await page.waitForFunction(() => document.querySelector('#agent-url')?.textContent.startsWith('http:'));
  const url = await page.locator('#agent-url').innerText();
  await page.locator('#agent-grant-form input[name=name]').fill('外部整理助手');
  await page.locator('#agent-grant-form input[name=domains]').check();
  await page.locator('#agent-grant-form button[type=submit]').click();
  await page.locator('#agent-token').waitFor();
  const token = await page.locator('#agent-token').inputValue();
  assert.equal(await page.locator('#agent-token').getAttribute('type'), 'password');
  const env = { STUDYSELF_AGENT_URL: url, STUDYSELF_AGENT_TOKEN: token };
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
  assert.match(boot.preferences.content, /适用条件/);
  const source = await call('sourceCreate', { preferencesVersion: boot.preferences.version,
    data: { title: '课程原文', domain: library.id, content: '原始课程资料', url: 'https://example.invalid/course' } }, uuid(), env);
  const proposal = await call('propose', { preferencesVersion: boot.preferences.version, title: '外部 Agent 整理方案', domain: library.id,
    content: '待补充：第二节课程截图',
    items: ['概念', '案例'].map(title => ({ data: { title, domain: library.id, content: `${title}的待确认正文`, sourceIds: [source.id] } })) }, uuid(), env);
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
    await page.locator('#main details summary').click();
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const save = await page.locator('#agent-preferences-form button[type=submit]').boundingBox();
    const footer = await page.locator('.statusbar').boundingBox();
    await page.screenshot({ path: path.join(root, `settings-bottom-${width}.png`), fullPage: true });
    assert.ok(save.y >= 0 && save.y + save.height <= footer.y, `settings save remains reachable below baseline: ${JSON.stringify({ width, save, footer })}`);
    assert.ok(footer.y + footer.height <= height + 1);
    await page.locator('#main details summary').click();
  }
  await page.setViewportSize({ width: 1165, height: 892 });
  const download = page.waitForEvent('download');
  await page.locator('[data-action="agent-export"]').click();
  await (await download).saveAs(path.join(root, 'studyself-organize.zip'));
  await page.locator('[data-nav="agents"]').click();
  await page.locator('[data-action="agent-revoke"]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('已撤销'));
  await assert.rejects(call('bootstrap', {}, undefined, env), /UNAUTHORIZED/);
  await page.locator('#agent-enabled').uncheck();
  await page.waitForFunction(() => document.querySelector('#agent-url')?.textContent === '未开启');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: ['system settings entry', 'preserve existing preferences', 'no settings in Agent page', 'enable', 'grant', 'preferences persistence', 'real local HTTP proposal', 'partial approval', 'settings skill ZIP', 'revoke', 'disable', 'scroll and resize'] }, null, 2));
  console.log('PASS: Agent authorization, external API to reviewed proposal, preferences, Skill export and revocation.');
} finally { await browser?.close(); await app.close(); }
