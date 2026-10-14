import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/ui-assets');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'profile-'));
const app = await createServer({ directory, port: 0 });
let browser;
const errors = [];
try {
  // Keep background file organization out of metadata assertions.
  clearInterval(app.service.timer);
  const store = app.service.store;
  const library = store.saveLibrary({ title: '学习资料' }), other = store.saveLibrary({ title: '项目资料' });
  const create = async (filename, data = filename) => {
    const file = path.join(directory, 'fixtures', filename);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
    return app.service.call('assetImport', { path: file, domain: library.id, duplicateMode: 'separate' });
  };
  const a = await create('课程讲义.txt', '课程原始内容'), b = await create('第二讲.txt', '另一个文件');
  const duplicate = await create('课程副本.txt', '课程原始内容');
  const image = await create('示意图.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2sAAAAASUVORK5CYII=', 'base64'));
  const missing = await create('缺失资料.pdf'); fs.unlinkSync(store.assetLocation(missing.id).path);
  const long = await create('这是一个很长的课程资料文件名用于确认表格换行及文字不会遮挡相邻操作列.txt');
  const note = store.write({ type: 'note', data: { title: '引用课程的笔记', domain: library.id, content: `[课程](studyself://asset/${a.id})` } });
  const originalLocation = store.assetLocation(a.id).path;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('[data-nav="assets"]').click();
  const row = asset => page.locator(`[data-material-row="${asset.id}"]`);
  const close = async () => { await page.locator('[data-modal-close]').click(); await page.locator('#modal').waitFor({ state: 'hidden' }); };
  const waitName = async (asset, name) => { await row(asset).locator('.material-name', { hasText: name }).waitFor(); };
  const choose = async (name, value) => {
    const response = page.waitForResponse(r => r.url().endsWith('/api') && r.request().postDataJSON()?.method === 'assetCatalog');
    await page.getByRole('combobox', { name, exact: true }).selectOption(value);
    await response;
  };
  // Use visible UI for editing, with original identity retained.
  await row(a).getByRole('button', { name: '编辑资料属性', exact: true }).click();
  assert.equal(await page.locator('#material-edit-form select[name=domain]').isDisabled(), true);
  await page.locator('#material-edit-form input[name=title]').fill('入门课程');
  await page.locator('#material-edit-form input[name=tags]').fill('基础, 实操');
  await page.locator('#material-edit-form input[name=sensitive]').check();
  await page.getByRole('button', { name: '保存属性', exact: true }).click();
  await waitName(a, '入门课程');
  assert.equal(store.get(a.id).data.filename, '课程讲义.txt');
  assert.equal(store.assetLocation(a.id).path, originalLocation);
  assert.equal(store.get(a.id).data.sha256, a.data.sha256);
  assert.equal(store.get(a.id).data.sensitive, true);
  assert.deepEqual(store.get(note.id).heads, note.heads);
  for (const query of ['入门课程', '课程讲义', '实操']) {
    await page.getByRole('textbox', { name: '搜索资料', exact: true }).fill(query);
    await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 1);
    assert.equal(await row(a).count(), 1);
  }
  await page.locator('[data-action="material-clear"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 6);
  await choose('资料类型', 'image');
  await row(image).waitFor(); assert.equal(await page.locator('[data-material-row]').count(), 1);
  await page.locator('[data-action="material-clear"]').click();
  await row(a).waitFor();
  await choose('本机文件状态', 'missing'); await row(missing).waitFor();
  assert.equal(await page.locator('[data-material-row]').count(), 1);
  await page.locator('[data-action="material-clear"]').click(); await row(a).waitFor();
  await choose('资料使用情况', 'duplicates');
  await row(duplicate).waitFor(); assert.equal(await page.locator('[data-material-row]').count(), 2);
  await page.locator('[data-action="material-clear"]').click(); await row(b).waitFor();

  await row(a).getByRole('button', { name: '资料详情与引用', exact: true }).click();
  assert.equal(await page.locator('#material-trash').isDisabled(), true);
  await page.locator(`[data-material-reference="${note.id}"]`).waitFor();
  await page.locator('#material-history summary').click();
  await page.locator('.material-history-row').first().waitFor();
  await page.screenshot({ path: path.join(root, 'detail-1220.png'), fullPage: true });
  await page.locator('[data-action="pin-asset"]').click();
  await page.getByRole('button', { name: '取消长期保留', exact: true }).waitFor();
  assert.equal(store.assetLocation(a.id).pinned, 1);
  await close();

  const select = async asset => { await row(asset).locator('[data-material-check]').check(); };
  const batchTags = async (action, tags) => {
    await page.locator('[data-action="material-batch-tags"]').click();
    await page.locator('#material-batch-form select[name=action]').selectOption(action);
    await page.locator('#material-batch-form input[name=tags]').fill(tags);
    await page.locator('#material-batch-form [type=submit]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
  };
  await select(b); await select(long); await batchTags('addTags', '批量标签');
  await page.waitForFunction(() => document.querySelector('#material-selection-count')?.textContent === '已选 0 项');
  assert.deepEqual(store.get(b.id).data.tags, ['批量标签']);
  assert.deepEqual(store.get(long.id).data.tags, ['批量标签']);
  await select(b); await select(long); await batchTags('removeTags', '批量标签');
  await page.waitForFunction(() => document.querySelector('#material-selection-count')?.textContent === '已选 0 项');
  assert.deepEqual(store.get(b.id).data.tags, []);

  // A reference created after selection must block the whole batch, preserving both records.
  await select(b); await select(duplicate);
  const before = store.get(b.id).heads;
  store.write({ type: 'note', data: { title: '刚刚添加的引用', domain: library.id, assetIds: [duplicate.id] } });
  await page.locator('[data-action="material-batch-trash"]').click();
  await page.locator('[data-confirm]').click();
  await page.locator('#toast.show', { hasText: '引用' }).waitFor();
  assert.deepEqual(store.get(b.id).heads, before); assert.equal(store.get(duplicate.id).deleted, false);
  assert.equal(await page.locator('#material-selection-count').innerText(), '已选 2 项');
  await page.locator('[data-action="material-deselect"]').click();
  await select(b);
  await page.locator('[data-action="material-batch-move"]').click();
  await page.locator('#material-batch-form select[name=domain]').selectOption(other.id);
  await page.locator('#material-batch-form [type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await row(b).getByRole('cell', { name: '项目资料', exact: true }).waitFor();
  assert.equal(store.get(b.id).data.domain, other.id);
  await select(b); await page.locator('[data-action="material-batch-trash"]').click();
  await page.locator('[data-confirm]').click();
  await row(b).waitFor({ state: 'detached' });
  assert.ok(fs.existsSync(store.assetLocation(b.id).path));
  await page.locator('[data-action="material-trash-view"]').click(); await row(b).waitFor();
  await select(b); await page.locator('[data-action="material-batch-restore"]').click();
  await page.locator('[data-confirm]').click(); await row(b).waitFor({ state: 'detached' });
  assert.equal(store.get(b.id).deleted, false);
  await page.locator('[data-action="material-active"]').click(); await row(b).waitFor();

  // Restore metadata creates a new revision, while stale edits leave the form intact.
  await row(a).getByRole('button', { name: '资料详情与引用', exact: true }).click();
  await page.locator('#material-history summary').click();
  await page.locator(`[data-material-version="${a.heads[0]}"]`).click();
  await page.locator('[data-confirm]').click(); await waitName(a, '课程讲义.txt');
  assert.equal(store.history(a.id).length, 3);
  await row(b).getByRole('button', { name: '编辑资料属性', exact: true }).click();
  const latest = store.get(b.id);
  await app.service.call('assetUpdate', { id: b.id, parents: latest.heads, changes: { title: '另一处修改' } });
  await page.locator('#material-edit-form input[name=title]').fill('不能覆盖的新名称');
  await page.getByRole('button', { name: '保存属性', exact: true }).click();
  await page.locator('#material-edit-form [role=alert]', { hasText: '发生变化' }).waitFor();
  assert.equal(await page.locator('#material-edit-form input[name=title]').inputValue(), '不能覆盖的新名称');
  assert.equal(store.get(b.id).data.title, '另一处修改');
  await close();

  const base = store.get(b.id);
  const chosen = store.write({ id: b.id, type: 'asset', parents: base.heads, data: { ...base.data, title: '保留的资料属性' } });
  store.write({ id: b.id, type: 'asset', parents: base.heads, allowBranch: true, data: { ...base.data, title: '另一电脑的属性' } });
  await page.locator('[data-action="refresh-view"]').click();
  await row(b).getByRole('button', { name: '资料详情与引用', exact: true }).click();
  await page.locator('#material-history summary').click();
  await page.locator(`[data-material-version="${chosen.heads[0]}"]`).click();
  await page.locator('[data-confirm]').click();
  await waitName(b, '保留的资料属性');
  assert.equal(store.get(b.id).conflict, false);
  await row(b).getByRole('button', { name: '预览资料', exact: true }).click();
  await page.locator('.text-preview', { hasText: '另一个文件' }).waitFor();
  await close();
  await row(b).getByRole('button', { name: '资料详情与引用', exact: true }).click();
  await page.locator('#material-trash').click(); await page.locator('[data-confirm]').click();
  await row(b).waitFor({ state: 'detached' });
  await page.locator('[data-nav="trash"]').click();
  await page.locator(`[data-record="${b.id}"]`).click();
  await page.locator('#material-restore').click(); await page.locator('[data-confirm]').click();
  await page.waitForFunction(id => !document.querySelector(`[data-record="${id}"]`), b.id);
  assert.equal(store.get(b.id).deleted, false);
  await page.locator('[data-nav="assets"]').click();
  await row(b).waitFor();

  await page.locator('[data-action="refresh-view"]').click();
  for (const width of [1480, 1220, 1165, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.screenshot({ path: path.join(root, `catalog-${width}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `page overflow at ${width}`);
    await page.locator('.material-pagination').scrollIntoViewIfNeeded();
    const box = await page.locator('.material-pagination').boundingBox();
    assert.ok(box.y + box.height <= 892, `bottom controls unreachable at ${width}`);
    await row(a).getByRole('button', { name: '资料详情与引用', exact: true }).click();
    assert.ok(await page.locator('#modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await close();
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  // Metadata-only fixture records exercise paging without duplicating original files.
  store.transaction(() => {
    for (let i = 0; i < 102; i++) store.writeRaw({ type: 'asset', data: { ...a.data, title: `分页资料 ${i}`, sha256: String(i).padStart(64, '0') } });
  });
  await page.locator('[data-action="refresh-view"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 100);
  await page.locator('[data-material-check]').first().check();
  await page.locator('[data-action="material-next"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 8);
  assert.equal(await page.locator('#material-selection-count').innerText(), '已选 1 项');
  await page.locator('#domain-filter').selectOption(other.id);
  await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 1);
  assert.equal(await page.locator('#material-selection-count').innerText(), '已选 0 项');
  assert.equal(await row(b).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: material metadata, identity, search/filters, references, batch rollback, tags/move/recycle/restore, stale edits, history, paging and responsive screenshots.');
} finally {
  await browser?.close();
  await app.close();
}
