import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

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
  app.service.store.write({ type: 'draft', data: { title: '待整理：课程截图与知识点', domain: 'AI', content: '先暂存资料，确认整理方案后再归档。' } });
  await app.service.call('propose', { title: '课程片段整理', domain: 'AI', items: [{ title: '同步与备份', content: '两者各自承担不同职责。' }, { title: '模型配置', content: '模型由当前设备决定可用性。' }] });
  const image = path.join(root, 'test-pixel.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2sAAAAASUVORK5CYII=', 'base64'));
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator(`[data-record="${first.id}"]`).waitFor();
  await page.locator(`[data-record="${first.id}"]`).click();
  await page.locator('#note-title').waitFor();
  await page.locator('.tiptap').waitFor();
  await page.screenshot({ path: path.join(root, 'desktop-knowledge.png'), fullPage: true });
  assert.equal(await page.locator('#note-title').inputValue(), first.data.title);
  await page.locator('.tiptap p').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Verified edit.');
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('已保存本地版本'));
  assert.ok(app.service.store.get(first.id).data.content.includes('Verified edit.'));
  // A dirty tab survives a switch to another domain and returns with its original context.
  await page.locator('.tiptap p').last().click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Unsaved local.');
  await page.locator('#domain-filter').selectOption('英语');
  await page.locator(`[data-record="${second.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '英语 · 表达积累');
  assert.match(await page.locator('.scope-label').innerText(), /英语/);
  await page.locator('.work-tab', { hasText: '多电脑知识库' }).click();
  await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('Unsaved local.'));
  assert.match(await page.locator('.scope-label').innerText(), /AI/);
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  await page.reload();
  await page.locator('.tiptap').waitFor();
  assert.match(await page.locator('.tiptap').innerText(), /Unsaved local/);
  assert.equal(await page.locator('.work-tab').count(), 2);
  await page.locator('[data-nav="models"]').click();
  await page.locator('h1', { hasText: '模型管理中心' }).waitFor();
  assert.equal(await page.locator('.provider-item').count(), 10);
  await page.screenshot({ path: path.join(root, 'desktop-models.png'), fullPage: true });
  await page.locator('[data-action="model-new"]').click();
  await page.locator('#model-form input[name=title]').fill('本地候选');
  await page.locator('#model-form input[name=modelName]').fill('qwen:local-test');
  await page.locator('#model-form button[type=submit]').click();
  await page.locator('.data-table', { hasText: '本地候选' }).waitFor();
  assert.match(await page.locator('.data-table').first().innerText(), /不可用/);
  await page.locator('[data-nav="sync"]').first().click();
  await page.locator('#sync-folder').waitFor();
  await page.locator('#sync-folder').fill(path.join(root, 'fake-cloud'));
  await page.locator('[data-action="pairing-key"]').click();
  await page.waitForFunction(() => document.querySelector('#sync-key')?.value.length === 64);
  await page.locator('#sync-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('配置已保存'));
  await page.locator('.page-heading [data-action="sync-now"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('已生成'));
  assert.match(await page.locator('#main').innerText(), /无法直接核验/);
  await page.screenshot({ path: path.join(root, 'desktop-sync.png'), fullPage: true });
  await page.locator('[data-nav="backup"]').click();
  await page.locator('#backup-folder').fill(path.join(root, 'backups'));
  await page.locator('#backup-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.data-table')?.textContent.includes('本地文件完整'));
  assert.match(await page.locator('.data-table').innerText(), /未核验/);
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
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, url: app.url, screenshots: ['desktop-knowledge.png', 'desktop-models.png', 'desktop-sync.png', 'compact-desktop.png', 'narrow-window.png'], errors }, null, 2));
  console.log('PASS: editing, tab persistence, domain scope, model availability, sync states, backup, partial approval and stale-editor conflict.');
} finally {
  await browser?.close();
  await app.close();
}
