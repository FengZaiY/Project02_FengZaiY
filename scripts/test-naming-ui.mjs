import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createServer } from '../src/server.mjs';
import { skillExportFiles } from '../web/skill-export.js';

const root = path.resolve('artifacts/fengzaiy-naming'); fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'ui-'));
const app = await createServer({ directory: path.join(profile, 'workspace'), port: 0 });
let browser, page; const errors = [];
try {
  const library = app.service.store.saveLibrary({ title: '命名兼容验证' });
  const target = app.service.store.write({ type: 'note', data: { title: '旧链接目标', domain: library.id, content: '原正文保留' } });
  const note = app.service.store.write({ type: 'note', data: { title: '旧链接笔记', domain: library.id, format: 'html', content: `<p><a href="studyself://note/${target.id}">打开原笔记</a></p>` } });
  const before = app.service.store.allEvents();
  const installed = path.join(profile, 'studyself-organize');
  for (const [name, content] of Object.entries(skillExportFiles(app.service.agents.skillPackage()))) {
    const file = path.join(installed, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === 'SKILL.md' ? content.replace('name: fengzaiy', 'name: studyself-organize') : content);
  }
  const preview = app.service.skillInstallations.preview({ directory: installed });
  app.service.skillInstallations.confirm({ token: preview.token, confirmed: true });
  await app.service.agents.configure(true);
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  page = await browser.newPage({ viewport: { width: 1304, height: 892 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('studyself-reading', JSON.stringify({ size: 20, width: 'wide' })));
  await page.goto(app.url);
  assert.equal(await page.title(), 'FengZaiY · 个人管理系统');
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('.tiptap a').waitFor();
  assert.equal(await page.locator('.tiptap a').getAttribute('href'), `studyself://note/${target.id}`);
  assert.equal(await page.getByLabel('正文字号', { exact: true }).inputValue(), '20');
  await page.locator('.tiptap a').click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '旧链接目标');
  assert.deepEqual(app.service.store.allEvents(), before);
  await page.locator('[data-nav=agents]').click();
  await page.locator('#agent-mcp-config').waitFor();
  const config = await page.locator('#agent-mcp-config').inputValue();
  assert.match(config, /\[mcp_servers.FengZaiY\]/); assert.match(config, /FENGZAIY_AGENT_TOKEN/); assert.ok(!/studyself/i.test(config));
  await page.screenshot({ path: path.join(root, 'mcp-configuration.png') });
  await page.locator('[data-nav=settings]').click(); await page.locator('[data-action=skill-manage]').click();
  await page.locator('[data-skill-tab=installs]').click();
  await page.getByText('需更换安装名称', { exact: true }).waitFor();
  assert.match(await page.locator('.skill-install-row').innerText(), /导出 FengZaiY.zip/);
  const download = page.waitForEvent('download'); await page.locator('[data-action=agent-export]').click();
  const exported = await download; assert.equal(exported.suggestedFilename(), 'FengZaiY.zip');
  const file = path.join(root, 'FengZaiY.zip'); await exported.saveAs(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  assert.match(await zip.file('fengzaiy/SKILL.md').async('string'), /name: fengzaiy/);
  await page.screenshot({ path: path.join(root, 'skill-management.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: new MCP configuration, portable Skill export, legacy installation guidance, old links and reading preferences.');
} finally { await browser?.close(); await app.close(); }
