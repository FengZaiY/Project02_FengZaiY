import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { sha } from '../src/core/util.mjs';

const root = path.resolve('artifacts/ui');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'profile-'));
const app = await createServer({ directory, port: 0 });
const errors = [];
let browser;
try {
  const first = app.service.store.write({ type: 'note', data: { title: '多电脑知识库：同步与版本',
    domain: 'AI', tags: ['系统设计', '工作流'], format: 'html',
    content: '<h2>把知识同步与模型运行分开</h2><p>每台电脑保留自己的本地知识库。同步传递内容和版本，不传递正在使用的数据库。</p><blockquote>同步用于保持一致，独立备份用于恢复错误。两者不能互相替代。</blockquote><h2>需要核对的状态</h2><table><tr><th>状态</th><th>含义</th></tr><tr><td>已本地保存</td><td>当前电脑已提交版本</td></tr><tr><td>等待客户端传输</td><td>已生成文件，云端状态未核验</td></tr><tr><td>另一台已接收</td><td>已收到另一设备的回执</td></tr></table><h2>处理冲突</h2><p>保留并发版本，人工对照融合。不按照上传时间覆盖修改。</p>' } });
  const second = app.service.store.write({ type: 'note', data: { title: '英语 · 表达积累', domain: '英语', tags: ['表达'],
    content: '## Notes\n\nA personal knowledge workspace.\n\n个人知识工作区。' } });
  const legacy = app.service.store.write({ type: 'conversation', data: { title: '退役对话', domain: 'AI',
    messages: [{ role: 'assistant', content: '旧消息不得自动恢复到界面。' }] } });
  const legacyTab = { id: crypto.randomUUID(), recordId: legacy.id, title: legacy.data.title, domain: 'AI', conversationId: legacy.id };
  const noteTab = { id: crypto.randomUUID(), recordId: first.id, title: first.data.title, domain: 'AI', scroll: 0 };
  await app.service.call('workspaceSave', { tabs: [noteTab, legacyTab], selectedTab: legacyTab.id, domain: 'AI' });
  app.service.store.write({ type: 'draft', data: { title: '待整理：课程截图与知识点', domain: 'AI', content: '先暂存资料，确认整理方案后再归档。' } });
  await app.service.call('propose', { title: '课程片段整理', domain: 'AI', items: [{ title: '同步与备份', content: '两者各自承担不同职责。' }, { title: '模型配置', content: '模型由当前设备决定可用性。' }] });
  const image = path.join(root, 'test-pixel.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2sAAAAASUVORK5CYII=', 'base64'));
  await app.service.call('assetImport', { path: image, domain: 'AI' });
  const missingBytes = Buffer.from('material pending transfer');
  const missingFile = path.join(directory, 'pending.txt'); fs.writeFileSync(missingFile, missingBytes);
  const missingAsset = app.service.store.write({ type: 'asset', data: { title: 'Pending material', filename: 'pending.txt',
    domain: 'AI', size: missingBytes.length, sha256: sha(missingBytes), mime: 'text/plain', priority: 'normal' } });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator(`[data-record="${first.id}"]`).waitFor();
  assert.equal(await page.locator('[data-nav="conversations"]').count(), 0);
  assert.equal(await page.getByText('历史对话归档', { exact: true }).count(), 0);
  assert.equal(await page.locator(`[data-tab="${legacyTab.id}"]`).count(), 0);
  assert.equal(await page.locator(`[data-tab="${noteTab.id}"]`).count(), 1);
  assert.equal(await page.locator('[data-action="conversation-to-draft"]').count(), 0);
  assert.deepEqual(app.service.store.get(legacy.id).heads, legacy.heads);
  await page.locator(`[data-record="${first.id}"]`).click();
  await page.locator('#note-title').waitFor();
  await page.locator('.tiptap').waitFor();
  await page.screenshot({ path: path.join(root, 'desktop-knowledge.png'), fullPage: true });
  assert.equal(await page.locator('#note-title').inputValue(), first.data.title);
  await page.locator('.tiptap p').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Verified edit.');
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('已本地保存'));
  assert.ok(app.service.store.get(first.id).data.content.includes('Verified edit.'));
  // A dirty tab survives a switch to another domain and returns with its original context.
  await page.locator('.tiptap p').last().click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Unsaved local.');
  await page.locator('#domain-filter').selectOption('英语');
  await page.locator(`[data-record="${second.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '英语 · 表达积累');
  assert.match(await page.locator('.work-tab.selected').innerText(), /英语/);
  await page.locator('.work-tab', { hasText: '多电脑知识库' }).click();
  await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('Unsaved local.'));
  assert.match(await page.locator('.work-tab.selected').innerText(), /AI/);
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  await page.reload();
  await page.locator('.tiptap').waitFor();
  assert.match(await page.locator('.tiptap').innerText(), /Unsaved local/);
  assert.equal(await page.locator('.work-tab').count(), 2);
  await page.locator('[data-nav="sync"]').first().click();
  await page.locator('#sync-folder').waitFor();
  await page.locator('#sync-folder').fill(path.join(root, 'fake-cloud'));
  await page.locator('[data-action="pairing-key"]').click();
  await page.waitForFunction(() => document.querySelector('#sync-key')?.value.length === 64);
  await page.locator('#sync-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('配置已保存'));
  await page.locator('.page-heading [data-action="sync-scan"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('最新内容清单'));
  assert.equal(await page.locator('[data-nav="backup"]').count(), 0);
  assert.equal(await page.locator('[data-action="version-commit"]').count(), 0);
  await page.locator('[data-nav="devices"]').click();
  await page.locator('[data-action="device-verify"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('原件校验通过'));
  assert.equal(await page.locator('#client-validation-form').count(), 0);
  assert.doesNotMatch(await page.locator('#main').innerText(), /客户端隔离验证|保存用户验证记录/);
  assert.match(await page.locator('#main').innerText(), /本机完整性/);
  assert.equal(await page.locator('[data-action="device-primary"]').count(), 1);
  await page.screenshot({ path: path.join(root, 'desktop-devices.png'), fullPage: true });
  for (const [width, height] of [[1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const last = await page.locator('.settings-section').last().boundingBox();
    const footer = await page.locator('.statusbar').boundingBox();
    assert.ok(last.y + last.height <= footer.y + 1);
    await page.screenshot({ path: path.join(root, `devices-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1480, height: 940 });
  await page.locator('[data-nav="sync"]').first().click();
  await page.locator('#sync-current').waitFor();
  assert.match(await page.locator('.sidebar-status').innerText(), /同步目录已配置/);
  assert.doesNotMatch(await page.locator('#main').innerText(), /待双机验证|尚待验证|客户端隔离验证/);
  assert.match(await page.locator('#main').innerText(), /无法直接核验/);
  assert.match(await page.locator('#sync-content-policy').innerText(), /大文件分块/);
  assert.match(await page.locator('#sync-file-completeness').innerText(), /1 \/ 2 已就绪.*1 个缺失或待接收/);
  await page.screenshot({ path: path.join(root, 'desktop-sync.png'), fullPage: true });
  for (const [width, height] of [[1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#main').evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `sync-files-${width}.png`), fullPage: true });
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: path.join(root, `sync-bottom-${width}.png`), fullPage: true });
    const last = await page.locator('.settings-section').last().boundingBox();
    const footer = await page.locator('.statusbar').boundingBox();
    assert.ok(last.y + last.height <= footer.y + 1);
  }
  await page.setViewportSize({ width: 1480, height: 940 });
  await page.locator('[data-nav="assets"]').click();
  await page.locator(`[data-action="bind-asset"][data-asset="${missingAsset.id}"]`).waitFor();
  assert.match(await page.locator('#main').innerText(), /缺失或等待完整接收/);
  assert.doesNotMatch(await page.locator('#main').innerText(), /按需获取|优先传输/);
  await app.service.call('assetImport', { path: missingFile, expectedId: missingAsset.id });
  await page.locator('[data-nav="sync"]').first().click();
  await page.locator('[data-action="sync-plan"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('空间预估已生成'));
  assert.match(await page.locator('#sync-task').innerText(), /预计新增占用/);
  const plannedId = app.service.transport.status().job.id;
  await page.locator('[data-action="sync-publish"]').click();
  await page.waitForFunction(() => document.querySelector('#sync-task')?.textContent.includes('最新内容已生成'));
  assert.equal(app.service.transport.value('latest').id, plannedId);
  assert.equal(app.service.transport.value('latest').format, 3);
  assert.doesNotMatch(await page.locator('#main').innerText(), /Git|保存版本|版本历史|独立备份/);
  await page.locator('[data-action="sync-upload-confirm"]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#sync-task')?.textContent.includes('用户已确认上传'));
  assert.equal(app.service.transport.config().cloudUploadVerified, false);
  await page.screenshot({ path: path.join(root, 'current-published.png'), fullPage: true });
  await page.locator('[data-nav="proposals"]').click();
  await page.locator('.record-row', { hasText: '课程片段整理' }).click();
  await page.locator('[data-proposal-item]').first().check();
  await page.locator('[data-action="approve"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-item]:disabled').length === 1);
  assert.equal(await page.locator('[data-proposal-item]:not(:disabled)').count(), 1);
  await page.locator('[data-nav="notes"]').click();
  await page.locator('#domain-filter').selectOption('AI');
  await page.locator(`[data-record="${first.id}"]`).click();
  for (const [width, height, name] of [[1100, 760, 'compact-desktop'], [600, 900, 'narrow-window']]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: path.join(root, `${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${name} has horizontal page overflow`);
  }
  await page.setViewportSize({ width: 1480, height: 940 });
  const bad = await page.evaluate(() => [...document.querySelectorAll('button')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && el.scrollWidth > el.clientWidth + 5 && !el.closest('.work-tabs');
  }).map(el => el.textContent));
  assert.deepEqual(bad, [], 'Button text overflow');
  const incoming = app.service.store.write({ type: 'workspace', data: { title: '含旧对话的其他电脑工作区',
    originDevice: crypto.randomUUID(), tabs: [{ ...legacyTab, id: crypto.randomUUID() }] } });
  const selectedBeforeAdopt = await page.locator('.work-tab.selected').getAttribute('data-tab');
  const tabCountBeforeAdopt = await page.locator('.work-tab').count();
  await page.locator('[data-action="adopt-workspace"]').click();
  await page.locator(`[data-adopt="${incoming.id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  await page.locator('.tiptap').waitFor();
  assert.equal(await page.locator('.work-tab').count(), tabCountBeforeAdopt);
  assert.equal(await page.locator('.work-tab.selected').getAttribute('data-tab'), selectedBeforeAdopt);
  assert.deepEqual(app.service.store.get(legacy.id).data, legacy.data);
  await page.setViewportSize({ width: 1165, height: 892 });
  await page.screenshot({ path: path.join(root, 'no-conversation-archive.png'), fullPage: true });
  // An arriving version must not silently become the base of an unsaved editor.
  await page.locator('.tiptap p').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Local concurrent text.');
  const beforeArrival = app.service.store.get(first.id);
  app.service.store.write({ id: first.id, type: 'note', parents: beforeArrival.heads,
    data: { ...beforeArrival.data, content: '<p>Arriving version from another edit.</p>' } });
  await page.locator('[data-action="save"]').click();
  await page.locator('#modal h2', { hasText: '保存期间出现新版本' }).waitFor();
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  const concurrent = app.service.store.get(first.id);
  assert.equal(concurrent.conflict, true);
  assert.ok(concurrent.versions.some(version => version.data.content.includes('Local concurrent text.')));
  assert.ok(concurrent.versions.some(version => version.data.content.includes('Arriving version')));
  assert.deepEqual(errors, [], 'Browser runtime errors');
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, url: app.url, screenshots: ['desktop-knowledge.png', 'desktop-sync.png', 'compact-desktop.png', 'narrow-window.png'], errors }, null, 2));
  console.log('PASS: editing, tab persistence, scope, current sync, space estimate, retired Git/backup controls, partial approval and stale-editor conflict.');
} finally {
  await browser?.close();
  await app.close();
}
