import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const draftMode = process.argv.includes('--draft');
const root = path.resolve(draftMode ? 'artifacts/ui-draft-attachments' : 'artifacts/ui-note-attachments');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser;
const errors = [];
try {
  clearInterval(app.service.timer);
  const store = app.service.store;
  const library = store.saveLibrary({ title: '附件管理验证' }), other = store.saveLibrary({ title: '其他知识库' });
  const create = async (name, domain = library.id) => {
    const file = path.join(store.directory, name); fs.writeFileSync(file, `独立测试原文件：${name}`);
    return app.service.call('assetImport', { path: file, domain });
  };
  const a = await create('课程讲义.txt'), b = await create('补充资料.txt'), inline = await create('正文资料.txt'), outside = await create('其他库私有资料.txt', other.id);
  const note = store.write({ type: draftMode ? 'draft' : 'note', data: { title: '原附件管理', domain: library.id, assetIds: [a.id],
    format: 'html', content: `<p>我的学习笔记</p><p><a href="fengzaiy://asset/${inline.id}">正文引用讲义</a></p>` } });
  const shared = store.write({ type: 'note', data: { title: '另一篇笔记', domain: library.id, assetIds: [a.id] } });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  if (draftMode) await page.locator('[data-nav=drafts]').click();
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.getByRole('button', { name: '原附件', exact: true }).click();
  const row = id => page.locator(`[data-source-asset="${id}"]`);
  const action = async (id, name) => {
    await row(id).getByRole('button', { name: '附件操作', exact: true }).click();
    await row(id).getByRole('button', { name, exact: true }).click();
  };
  await row(a.id).waitFor();
  await page.evaluate(() => { window.attachmentEditor = document.querySelector('.tiptap'); });
  const sameEditor = async () => assert.equal(await page.evaluate(() => window.attachmentEditor === document.querySelector('.tiptap')), true);
  const close = async () => { await page.locator('[data-modal-close]').click(); };
  const saved = async () => { await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved'); };
  // Metadata edits and details retain the current preview, text and undo stack.
  await row(a.id).locator('[data-preview-asset]').click();
  await page.locator('#source-preview .text-preview').waitFor();
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 新输入');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.equal(await page.locator('#source-preview').isVisible(), false);
  await sameEditor();
  assert.match(await page.locator('.tiptap').innerText(), /新输入/);
  await row(a.id).locator('[data-preview-asset]').click();
  await page.locator('#source-preview .text-preview').waitFor();
  await action(a.id, '编辑资料属性');
  await page.locator('#material-edit-form input[name=title]').fill('课程原附件');
  await page.locator('#material-edit-form input[name=tags]').fill('课程, 原文');
  await page.getByRole('button', { name: '保存属性', exact: true }).click();
  await row(a.id).locator('.source-item', { hasText: '课程原附件' }).waitFor();
  await sameEditor();
  assert.match(await page.locator('#source-preview').innerText(), /独立测试原文件/);
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /新输入/);
  await page.locator('.tiptap').press('Control+Shift+z');
  await action(a.id, '资料详情与引用');
  await page.locator('.material-references').getByText('另一篇笔记', { exact: true }).waitFor();
  await close(); await sameEditor();
  await action(inline.id, '解除与当前笔记的关联');
  await page.locator('#toast', { hasText: '请先移除相应引用' }).waitFor();
  assert.equal(await page.locator('#modal').isVisible(), false);
  assert.ok(store.get(note.id).data.assetIds.includes(inline.id));

  // Existing attachments can be selected only in the same library; no new asset is created.
  await page.getByRole('button', { name: '关联已有资料', exact: true }).click();
  assert.equal(await page.locator(`#source-link-form input[value="${a.id}"]`).count(), 0);
  assert.equal(await page.locator(`#source-link-form input[value="${outside.id}"]`).count(), 0);
  await page.locator('#source-link-form input[name=query]').fill('补充');
  await page.locator(`#source-link-form input[value="${b.id}"]`).check();
  await page.getByRole('button', { name: '关联所选资料', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await saved(); await row(b.id).waitFor();
  assert.deepEqual(store.get(note.id).data.assetIds, [a.id, inline.id, b.id]);
  assert.equal(store.list({ type: 'asset' }).length, 4);
  await sameEditor();
  await action(b.id, '解除与当前笔记的关联');
  await page.locator('[data-cancel]').click(); await row(b.id).waitFor();
  assert.deepEqual(store.get(note.id).data.assetIds, [a.id, inline.id, b.id]);

  // A second edit during an in-flight unlink remains queued against the new base version.
  let releaseSave, reachedSave;
  const gate = new Promise(resolve => { releaseSave = resolve; });
  const reached = new Promise(resolve => { reachedSave = resolve; });
  let held = false;
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === note.id && !held) {
      held = true; reachedSave(); await gate;
    }
    await route.continue();
  });
  await action(a.id, '解除与当前笔记的关联');
  await page.locator('[data-confirm]').click();
  await reached;
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 保存期间继续输入');
  releaseSave();
  await saved(); await page.unroute('**/api');
  assert.deepEqual(store.get(note.id).data.assetIds, [inline.id, b.id]);
  assert.match(store.get(note.id).data.content, /保存期间继续输入/);
  assert.match(store.get(note.id).data.content, new RegExp(`fengzaiy://asset/${inline.id}`));
  assert.deepEqual(store.get(shared.id).heads, shared.heads);
  assert.ok(fs.existsSync(store.assetLocation(a.id).path));
  assert.equal(store.get(a.id).deleted, false);
  assert.equal(await page.locator('#source-preview .text-preview').count(), 0);
  await sameEditor();

  // Local import uses the same writer and keeps the editor alive.
  const uploadPath = path.join(root, '本地导入.txt'); fs.writeFileSync(uploadPath, '本地原附件');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加本地附件', exact: true }).click();
  await (await chooser).setFiles(uploadPath);
  await page.locator('.source-item', { hasText: '本地导入.txt' }).waitFor(); await saved(); await sameEditor();
  const imported = store.list({ type: 'asset' }).find(a => a.data.filename === '本地导入.txt');
  assert.ok(store.get(note.id).data.assetIds.includes(imported.id));

  // Failed attachment writes preserve the pending change for explicit save/retry.
  const beforeFailure = store.get(note.id).heads;
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'save') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: { code: 'IO_ERROR', message: '模拟保存失败' } }) });
    } else await route.continue();
  });
  await action(b.id, '解除与当前笔记的关联');
  await page.locator('[data-confirm]').click();
  await page.locator('[data-action=save][data-status=error]').waitFor();
  assert.deepEqual(store.get(note.id).heads, beforeFailure);
  await page.unroute('**/api'); await page.locator('[data-action=save]').click(); await saved();
  assert.deepEqual(store.get(note.id).data.assetIds, [inline.id, imported.id]); await sameEditor();
  assert.ok(store.local('workspace').tabs.every(tab => !tab.dirty));

  for (const width of [1480, 1304, 1001, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await row(imported.id).scrollIntoViewIfNeeded();
    const rect = await row(imported.id).boundingBox();
    assert.ok(rect.height <= 52, `Compact attachment row at ${width}: ${rect.height}`);
    assert.equal(await row(imported.id).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    assert.match(await row(imported.id).locator('.source-item').getAttribute('title'), /本地导入.txt/);
    assert.ok(rect.y + rect.height < 892);
    await page.screenshot({ path: path.join(root, `attachments-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  const splitter = page.getByRole('separator', { name: '调整原附件宽度' });
  for (let i = 0; i < 5; i++) await splitter.press('ArrowLeft');
  assert.ok((await row(imported.id).locator('.source-filename').boundingBox()).width >= 90);
  await row(imported.id).getByRole('button', { name: '附件操作', exact: true }).click();
  const menuBox = await row(imported.id).locator('.source-attachment-menu').boundingBox();
  const paneBox = await page.locator('.source-pane-scroll').boundingBox();
  assert.ok(menuBox.x >= paneBox.x && menuBox.x + menuBox.width <= paneBox.x + paneBox.width + 1);
  await page.screenshot({ path: path.join(root, 'attachments-narrow-menu.png') });
  await page.keyboard.press('Escape');
  assert.equal(await row(imported.id).locator('details').getAttribute('open'), null);
  await row(imported.id).getByRole('button', { name: '附件操作', exact: true }).click();
  await page.locator('#note-title').click();
  assert.equal(await row(imported.id).locator('details').getAttribute('open'), null);
  for (let i = 0; i < 5; i++) await splitter.press('ArrowRight');
  // A remote update must not be silently overwritten or turned into a branch.
  const remoteBase = store.get(note.id);
  const remote = store.write({ id: note.id, type: note.type, parents: remoteBase.heads, data: { ...remoteBase.data, content: '<p>另一端的新正文</p>' } });
  await action(imported.id, '解除与当前笔记的关联');
  await page.locator('[data-confirm]').click();
  await page.locator('[data-action=save][data-status=conflict]').waitFor();
  assert.deepEqual(store.get(note.id).heads, remote.heads);
  assert.equal(store.get(note.id).conflict, false);
  assert.match(await page.locator('.tiptap').innerText(), /保存期间继续输入/);
  assert.equal(await page.locator('#modal').isVisible(), false);
  await sameEditor();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: [
    'rename and metadata', 'preview and editor preservation', 'same-library existing links', 'cancel',
    'unlink with body and shared references retained', 'in-flight input', 'local import',
    'failed save retry', 'conflict pause', 'responsive screenshots'
  ] }, null, 2));
  console.log('PASS: original attachment management, editor/undo, imports, links, failures, in-flight input, conflicts and responsive screenshots.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
    console.error(await page.locator('#modal').textContent(), await page.locator('#toast').textContent());
  }
  throw error;
} finally {
  await browser?.close();
  await app.close();
}
