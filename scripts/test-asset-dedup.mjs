import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/asset-dedup-ui');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'workspace-')), port: 0 });
let browser, page;
const errors = [];
try {
  clearInterval(app.service.timer);
  const store = app.service.store, library = store.saveLibrary({ title: '重复资料整理' });
  const file = path.join(root, '学习讲义.txt'); fs.writeFileSync(file, '同一份学习资料');
  const a = await app.service.call('assetImport', { path: file, domain: library.id });
  const renamed = path.join(root, '讲义副本.txt'); fs.copyFileSync(file, renamed);
  const b = await app.service.call('assetImport', { path: renamed, domain: library.id, duplicateMode: 'separate' });
  const note = store.write({ type: 'note', data: { title: '学习笔记', domain: library.id, format: 'html',
    content: `<p>保留正文与<a href="studyself://asset/${b.id}">原始讲义</a></p>`, assetIds: [a.id, b.id] } });
  await app.service.call('assetUpdate', { id: b.id, parents: b.heads, changes: { tags: ['课程'], sensitive: true } });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#domain-filter').selectOption(library.id);
  await page.locator('[data-nav=assets]').click();
  await page.locator('.material-manager').waitFor();
  await page.locator('#domain-filter').selectOption(library.id);
  await page.locator('.page-heading small', { hasText: library.data.title }).waitFor();
  const row = id => page.locator(`[data-material-row="${id}"]`);
  const open = async () => {
    await row(a.id).getByRole('button', { name: '合并相同内容', exact: true }).click();
    await page.locator('#material-merge-preview h4').waitFor();
  };
  await open();
  assert.match(await page.locator('#material-merge-preview').innerText(), /学习笔记/);
  assert.match(await page.locator('#material-merge-preview').innerText(), /敏感资料/);
  const before = store.get(note.id).heads;
  await page.locator('#material-merge-cancel').click();
  assert.deepEqual(store.get(note.id).heads, before);
  assert.equal(store.get(b.id).deleted, false);

  // Normal file upload reuses an ID, while the explicit separate action creates another record.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入文件', exact: true }).click();
  await (await chooser).setFiles(renamed);
  await page.locator('#toast', { hasText: '已复用原资料' }).waitFor();
  assert.equal(store.list({ type: 'asset' }).length, 2);
  await page.getByRole('button', { name: '导入为独立资料（允许相同内容）', exact: true }).click();
  const separateChooser = page.waitForEvent('filechooser');
  await page.locator('[data-confirm]').click(); await (await separateChooser).setFiles(file);
  await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 3);
  const third = store.list({ type: 'asset' }).find(item => ![a.id, b.id].includes(item.id));
  assert.ok(third);
  await open();
  await page.locator(`#material-merge-form input[value="${b.id}"]`).check();
  await page.waitForFunction(id => document.querySelector('#material-merge-form input:checked')?.value === id
    && document.querySelector('#material-merge-form [type=submit]')?.disabled === false, b.id);
  await page.locator(`#material-merge-form input[value="${a.id}"]`).check();
  await page.waitForFunction(() => document.querySelector('#material-merge-form [type=submit]')?.disabled === false);
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#material-merge-form [type=submit]').scrollIntoViewIfNeeded();
    const box = await page.locator('#material-merge-form [type=submit]').boundingBox();
    assert.ok(box.y + box.height < 892, 'Confirmation must be reachable in the dialog');
    await page.screenshot({ path: path.join(root, `merge-preview-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  // A new reference after preview invalidates confirmation, without partial writes.
  const added = store.write({ type: 'source', data: { title: '新关联来源', domain: library.id, assetIds: [b.id] } });
  await page.getByRole('button', { name: '确认合并', exact: true }).click();
  await page.locator('#material-merge-form [role=alert]', { hasText: '重新预览' }).waitFor();
  assert.equal(store.get(b.id).deleted, false);
  assert.deepEqual(store.get(note.id).heads, before);
  await page.locator('#material-merge-refresh').click();
  await page.locator('#material-merge-preview', { hasText: '新关联来源' }).waitFor();
  // Local drafts block merging; the UI persists its own workspace before every preview.
  await page.locator('#material-merge-cancel').click();
  await page.locator(`[data-nav="notes"]`).click();
  await page.locator(`[data-record="${note.id}"]`).click(); await page.locator('.tiptap').waitFor();
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'save') await route.fulfill({ json: { error: { message: '测试保留未保存输入' } } });
    else await route.continue();
  });
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 未保存输入');
  await page.locator('[data-action=save]').click();
  await page.locator('[data-action=save][data-status=error]').waitFor();
  await page.locator('[data-nav=assets]').click(); await open();
  await page.locator('#material-merge-preview', { hasText: '未保存编辑' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认合并', exact: true }).isDisabled(), true);
  await page.locator('#material-merge-cancel').click();
  await page.unroute('**/api');
  await page.locator(`[data-nav="notes"]`).click(); await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('[data-action=save]').click();
  await page.locator('[data-action=save][data-status=saved]').waitFor();
  await page.locator('[data-nav=assets]').click(); await open();
  await page.getByRole('button', { name: '确认合并', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('[data-material-row]').length === 1);
  assert.deepEqual(store.get(note.id).data.assetIds, [a.id]);
  assert.match(store.get(note.id).data.content, /未保存输入/);
  assert.ok(store.get(note.id).data.content.includes(`studyself://asset/${a.id}`));
  assert.equal(store.get(b.id).deleted, true); assert.equal(store.get(third.id).deleted, true);
  assert.equal(store.get(a.id).data.sensitive, true);
  assert.deepEqual(store.get(added.id).data.assetIds, [a.id]);
  assert.ok(fs.existsSync(store.assetLocation(b.id).path));
  await page.locator('[data-action=material-trash-view]').click();
  await row(b.id).waitFor(); await row(third.id).waitFor();
  await row(b.id).getByRole('button', { name: '恢复资料', exact: true }).click();
  await page.locator('[data-confirm]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(store.get(b.id).deleted, false);
  await page.reload(); await page.locator('[data-nav=assets]').click(); await row(a.id).waitFor();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: [
    'default reuse upload', 'explicit separate import', 'select survivor', 'preview references and metadata', 'cancel',
    'stale confirmation', 'dirty draft blocked', 'saved input preserved', 'atomic merge', 'recycle and restore', 'responsive screenshots'
  ] }, null, 2));
  console.log('PASS: deduplicated imports, explicit separate records, merge preview/cancel/stale/dirty safeguards, references, restore and screenshots.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
    console.error(await page.locator('#modal').textContent(), await page.locator('#toast').textContent());
  }
  throw error;
} finally {
  await browser?.close(); await app.close();
}
