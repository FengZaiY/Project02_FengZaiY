import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/asset-storage-ui');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'case-'));
const app = await createServer({ directory: path.join(directory, 'workspace'), port: 0 });
let browser, page;
const errors = [];
try {
  clearInterval(app.service.timer);
  const store = app.service.store, library = store.saveLibrary({ title: '学习资料' }), other = store.saveLibrary({ title: '另一知识库' });
  const create = async (name, domain = library.id) => {
    const file = path.join(directory, name); fs.writeFileSync(file, name);
    return app.service.call('assetImport', { path: file, domain });
  };
  const own = await create('课程讲义.txt'), shared = await create('共享参考.txt'), free = await create('独立资料.txt');
  const missing = await create('缺失文件.txt'), unbound = await create('待下载.txt'), external = await create('外部绑定.txt'), trash = await create('已回收.txt');
  const otherAsset = await create('另一知识库资料.txt', other.id);
  const parent = store.write({ type: 'note', data: { title: '课程概览', domain: library.id, assetIds: [shared.id] } });
  store.write({ type: 'note', data: { title: '第一章与完整长名称用于核对实际目录换行', domain: library.id, parentNoteId: parent.id, assetIds: [own.id, shared.id] } });
  store.remove(trash.id, trash.heads);
  await app.service.organizeLocal();
  fs.unlinkSync(store.assetLocation(missing.id).path);
  store.db.prepare('DELETE FROM assets WHERE id=?').run(unbound.id);
  store.bindAsset(external.id, path.join(directory, '外部绑定.txt'));
  const before = JSON.stringify(store.db.prepare('SELECT id,json FROM events ORDER BY id').all());
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const context = await browser.newContext({ viewport: { width: 1220, height: 892 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#domain-filter').selectOption(library.id);
  await page.locator('[data-nav=assets]').click();
  await page.locator('#material-root-path').waitFor();
  await page.locator('#domain-filter').selectOption(library.id);
  await page.locator('.page-heading small', { hasText: library.data.title }).waitFor();
  assert.equal(await page.locator('#material-root-path').innerText(), store.directory);
  assert.equal(await page.locator('[data-material-row]').count(), 6);
  const tree = page.locator('.material-directory-tree');
  assert.match(await tree.innerText(), /materials/);
  assert.match(await tree.innerText(), /工作区外/);
  assert.match(await tree.innerText(), /尚未下载到本机/);
  assert.ok(!(await tree.innerText()).includes('另一知识库'));
  const row = asset => page.locator(`[data-material-row="${asset.id}"]`);
  assert.match(await row(own).innerText(), /materials/s);
  assert.match(await row(missing).innerText(), /文件缺失/);
  assert.match(await row(unbound).innerText(), /尚未下载到本机/);
  await page.getByRole('button', { name: '复制工作区根目录', exact: true }).click();
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, store.directory);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), store.directory);
  await row(own).getByRole('button', { name: '资料详情与引用', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.material-file-path').first().innerText(), store.assetLocation(own.id).path);
  await page.getByRole('button', { name: '复制附件完整路径', exact: true }).click();
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, store.assetLocation(own.id).path);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), store.assetLocation(own.id).path);
  await page.getByRole('button', { name: '复制附件所在文件夹', exact: true }).click();
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, path.dirname(store.assetLocation(own.id).path));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.dirname(store.assetLocation(own.id).path));
  await page.screenshot({ path: path.join(root, 'detail-1220.png') });
  await page.locator('[data-modal-close]').click();
  const filter = async name => {
    await tree.locator('.material-directory').filter({ hasText: name }).first().click();
    await page.locator('.material-directory-selection').waitFor();
  };
  await row(shared).locator('.material-location').click();
  await page.locator('.material-directory-selection').waitFor();
  assert.equal(await row(shared).count(), 1);
  for (const selected of await page.locator('[data-material-row]').all()) {
    const id = await selected.getAttribute('data-material-row');
    assert.equal(path.dirname(store.assetLocation(id).path), path.dirname(store.assetLocation(shared.id).path));
  }
  await page.locator('[data-action=material-directory-clear]').click();
  await row(own).waitFor();
  await row(own).locator('.material-location').click();
  await page.locator('.material-directory-selection').waitFor();
  assert.equal(await row(own).count(), 1);
  await page.locator('#domain-filter').selectOption(other.id);
  await row(otherAsset).waitFor();
  assert.equal(await page.locator('.material-directory-selection').count(), 0);
  assert.ok(!(await tree.innerText()).includes('课程概览'));
  await page.locator('#domain-filter').selectOption(library.id);
  await row(own).waitFor();
  await filter('尚未下载到本机');
  await row(unbound).waitFor();
  assert.equal(await page.locator('[data-material-row]').count(), 1);
  await page.locator('[data-action=material-clear]').click();
  await row(own).waitFor();
  await page.locator('[data-action=material-trash-view]').click();
  await row(trash).waitFor();
  assert.match(await tree.innerText(), /materials/);
  await page.locator('[data-action=material-active]').click();
  await row(own).waitFor();
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('#material-root-path').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.locator('.material-storage').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: path.join(root, `directories-${width}.png`) });
    await page.locator('#material-directories > summary').click();
    await page.locator('.material-directory-scroll').waitFor({ state: 'hidden' });
    await row(own).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `list-${width}.png`) });
    await page.locator('.material-pagination').scrollIntoViewIfNeeded();
    const bottom = await page.locator('.material-pagination').boundingBox();
    assert.ok(bottom.y + bottom.height <= 893);
    await row(own).getByRole('button', { name: '资料详情与引用', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.locator('.material-file-path').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `detail-${width}.png`) });
    await page.locator('[data-modal-close]').click();
    await page.locator('#material-directories > summary').click();
  }
  assert.equal(JSON.stringify(store.db.prepare('SELECT id,json FROM events ORDER BY id').all()), before);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: [
    'content-addressed paths', 'shared and recycled originals', 'missing and unbound', 'external binding',
    'copy file and folder paths', 'directory filtering', 'library isolation', 'collapse', 'responsive layout', 'no knowledge writes'
  ] }, null, 2));
  console.log('PASS: real local hierarchy, current bindings, missing/unbound/external files, path copy, scoped filtering, unchanged records and responsive screenshots.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app.close();
}
