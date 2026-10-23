import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createServer } from '../src/server.mjs';
import { skillExportFiles } from '../web/skill-export.js';

const root = path.resolve('artifacts/ui-skill-manager'); fs.mkdirSync(root, { recursive: true });
let chosenDirectory = null;
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0, chooseDirectory: async () => chosenDirectory });
const first = app.service.agents.savePreferences({ content: '最早规则：保留出处。', parents: [] });
app.service.agents.savePreferences({ content: '当前规则：区分观点。', parents: first.heads });
let browser, page; const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1304, height: 892 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator('[data-nav=settings]').click();
  await page.locator('[data-action=skill-manage]').click();
  await page.locator('#skill-management').waitFor();
  const input = page.locator('#agent-preferences-form textarea');
  assert.equal(await input.inputValue(), '当前规则：区分观点。');
  await page.locator('[data-skill-tab=files]').click();
  await page.locator('[data-skill-file="scripts/client.mjs"]').click();
  assert.equal(await page.locator('#skill-file-body').innerText(), app.service.agents.skillFiles()['scripts/client.mjs']);
  assert.equal(await page.locator('#skill-file-body [contenteditable]').count(), 0);
  await page.locator('[data-skill-tab=preferences]').click();
  await input.fill('待保存规则 <script>alert(1)</script>');
  await page.locator('[data-action=agent-export]').click();
  await page.locator('#toast', { hasText: '请先保存' }).waitFor();
  assert.equal(app.service.agents.skillPackage().lastGenerated, null);
  await page.locator('[data-nav=agents]').click();
  await page.locator('#agent-enabled').waitFor();
  assert.equal(await page.locator('#skill-management').count(), 0);
  await page.locator('[data-nav=settings]').click();
  await input.waitFor();
  assert.equal(await input.inputValue(), '待保存规则 <script>alert(1)</script>');
  await page.locator('#agent-preferences-form [type=submit]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();
  const download = page.waitForEvent('download'); await page.locator('[data-action=agent-export]').click();
  const file = await download; await file.saveAs(path.join(root, 'studyself-organize.zip'));
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'studyself-organize.zip')));
  assert.match(await zip.file('studyself-organize/references/preferences.md').async('string'), /待保存规则 <script>/);
  assert.equal(JSON.parse(await zip.file('studyself-organize/manifest.json').async('string')).exportVersion, app.service.agents.skillPackage().exportVersion);
  await page.locator('.skill-versions', { hasText: '与当前一致' }).waitFor();
  await page.locator('[data-skill-tab=history]').click();
  const historical = page.locator('.skill-history').filter({ has: page.locator(`[data-skill-restore="${first.heads[0]}"]`) });
  await historical.locator('summary').click();
  await historical.locator('[data-skill-restore]').click();
  assert.equal(await input.inputValue(), first.content);
  assert.equal(app.service.agents.preferences().content, '待保存规则 <script>alert(1)</script>');
  await page.locator('#agent-preferences-form [type=submit]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();
  assert.equal(app.service.store.history(first.id).length, 4);
  await page.locator('.skill-versions', { hasText: '需重新导出' }).waitFor();

  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'agentPreferencesSave') { reached(); await gate; }
    await route.continue();
  });
  await input.fill('提交中的规则'); await page.locator('#agent-preferences-form [type=submit]').click(); await arrived;
  await input.fill('提交期间继续输入'); release();
  await page.waitForFunction(() => !document.querySelector('#agent-preferences-form [type=submit]')?.disabled);
  await page.unroute('**/api');
  assert.equal(await input.inputValue(), '提交期间继续输入');
  assert.equal(await page.locator('#skill-edit-status').innerText(), '尚未保存');
  await page.locator('#agent-preferences-form [type=submit]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();
  const previous = app.service.agents.preferences();
  app.service.agents.savePreferences({ content: '另一设备规则', parents: previous.heads });
  await input.fill('对照后的规则'); await page.locator('#agent-preferences-form [type=submit]').click();
  await page.locator('#skill-rebase').waitFor({ state: 'visible' });
  assert.equal(app.service.agents.preferences().content, '另一设备规则');
  await page.locator('#skill-rebase').click();
  await page.locator('#modal [data-cancel]').click();
  assert.equal(await input.inputValue(), '对照后的规则');
  await page.locator('#skill-rebase').click();
  await page.locator('#modal [data-confirm]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();
  assert.equal(app.service.agents.preferences().content, '对照后的规则');
  const installation = path.join(fs.mkdtempSync(path.join(root, 'installed-')), 'studyself-organize');
  for (const [name, content] of Object.entries(skillExportFiles(app.service.agents.skillPackage()))) {
    fs.mkdirSync(path.dirname(path.join(installation, name)), { recursive: true }); fs.writeFileSync(path.join(installation, name), content);
  }
  fs.writeFileSync(path.join(installation, 'extra.txt'), 'keep');
  await page.locator('[data-skill-tab=installs]').click();
  await page.locator('[data-install-add]').click();
  assert.equal(app.service.skillInstallations.list().length, 0);
  chosenDirectory = installation;
  await page.locator('[data-install-add]').click();
  await page.locator('#modal [data-cancel]').click();
  assert.equal(app.service.skillInstallations.list().length, 0);
  await page.locator('[data-install-add]').click(); await page.locator('#modal [data-confirm]').click();
  await page.locator('.skill-install-row').waitFor();
  assert.equal(app.service.skillInstallations.list()[0].mode, 'manual');
  app.service.agents.savePreferences({ content: '安装更新的新规则', parents: app.service.agents.preferences().heads });
  await page.locator('[data-install-check]').click(); await page.locator('.skill-install-row .pill', { hasText: '有更新' }).waitFor();
  await page.locator('[data-install-update]').click(); await page.locator('#modal [data-confirm]').click();
  await page.locator('.skill-install-row .pill', { hasText: '与当前一致' }).waitFor();
  assert.match(fs.readFileSync(path.join(installation, 'references/preferences.md'), 'utf8'), /安装更新的新规则/);
  await page.locator('[data-install-restore]').click(); await page.locator('#modal [data-confirm]').click();
  await page.locator('.skill-install-row .pill', { hasText: '有更新' }).waitFor();
  assert.doesNotMatch(fs.readFileSync(path.join(installation, 'references/preferences.md'), 'utf8'), /安装更新的新规则/);
  await page.locator('[data-install-mode]').selectOption('auto'); await page.locator('#modal [data-cancel]').click();
  assert.equal(app.service.skillInstallations.list()[0].mode, 'manual');
  await page.locator('[data-install-mode]').selectOption('auto'); await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(async () => {
    const token = document.querySelector('meta[name=local-token]').content;
    const result = await (await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StudySelf-Token': token }, body: JSON.stringify({ method: 'skillInstallList', input: {} }) })).json();
    return result.value?.[0]?.status === 'current';
  });
  fs.appendFileSync(path.join(installation, 'references/api.md'), '\nmanual addition');
  await page.locator('[data-install-check]').click(); await page.locator('.skill-install-row .pill', { hasText: '手工修改' }).waitFor();
  await page.locator('[data-install-update]').click(); await page.locator('#modal .skill-install-warning').waitFor();
  await page.locator('#modal [data-cancel]').click();
  assert.match(fs.readFileSync(path.join(installation, 'references/api.md'), 'utf8'), /manual addition/);
  fs.unlinkSync(path.join(installation, 'SKILL.md'));
  fs.unlinkSync(path.join(installation, 'manifest.json'));
  await page.locator('[data-install-check]').click();
  await page.locator('.skill-install-row .pill', { hasText: '安装文件缺失' }).waitFor();
  await page.getByRole('button', { name: '补全并更新', exact: true }).click();
  await page.locator('#modal .skill-install-warning', { hasText: '将补齐：SKILL.md、manifest.json' }).waitFor();
  await page.locator('#modal .skill-install-warning', { hasText: '以下手工修改' }).waitFor();
  await page.screenshot({ path: path.join(root, 'repair-confirm.png'), fullPage: true });
  await page.locator('#modal [data-cancel]').click();
  assert.ok(!fs.existsSync(path.join(installation, 'SKILL.md')));
  for (const width of [1304, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    for (const tab of ['preferences', 'installs', 'files', 'history']) {
      await page.locator(`[data-skill-tab=${tab}]`).click();
      await page.locator('#skill-management').evaluate(el => el.scrollIntoView({ block: 'start' }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(root, `${tab}-${width}.png`), fullPage: true });
      const footer = await page.locator('.statusbar').boundingBox(); assert.ok(footer.y + footer.height <= 893);
    }
  }
  await page.locator('[data-skill-tab=installs]').click();
  await page.getByRole('button', { name: '补全并更新', exact: true }).click();
  await page.getByRole('button', { name: '确认补全并更新', exact: true }).click();
  await page.locator('.skill-install-row .pill', { hasText: '与当前一致' }).waitFor();
  for (const [name, content] of Object.entries(skillExportFiles(app.service.agents.skillPackage()))) {
    assert.equal(fs.readFileSync(path.join(installation, name), 'utf8'), content);
  }
  await page.locator('[data-install-unlink]').click(); await page.locator('#modal [data-confirm]').click();
  await page.locator('#skill-panel-installs .muted', { hasText: '尚未关联' }).waitFor();
  assert.equal(fs.readFileSync(path.join(installation, 'extra.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(installation, 'SKILL.md')));
  await page.reload(); await page.locator('[data-nav=settings]').click(); await input.waitFor();
  assert.equal(await input.inputValue(), '安装更新的新规则');
  assert.deepEqual(errors, []);
  console.log('PASS: Skill preview/export, retained edits, history, stale versions; installation picker/cancel, update/restore, automatic timer, modified-file protection, missing-file repair/cancel, unlink, restart and responsive screenshots.');
} catch (error) { await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); throw error; }
finally { await browser?.close(); await app.close(); }
