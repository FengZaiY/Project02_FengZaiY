import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/trash-ui');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const store = app.service.store;
const a = store.saveLibrary({ title: '个人学习资料与项目实践' }), b = store.saveLibrary({ title: '其他知识库' });
const make = (title, domain = a.id) => {
  const note = store.write({ type: 'note', data: { title, domain, content: '隔离测试内容' } });
  return store.remove(note.id, note.heads);
};
const removable = make('可以清空的笔记'), protectedNote = make('仍被引用的笔记'), other = make('其他范围保留', b.id);
store.write({ type: 'note', data: { title: '引用者', domain: b.id, content: `[原文](fengzaiy://note/${protectedNote.id})` } });
let browser, page;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('[data-nav=trash]').click();
  await page.getByLabel('选择知识库').selectOption(a.id);
  await page.locator('.list-heading strong', { hasText: `${a.data.title} · 回收站` }).waitFor();
  await page.locator(`[data-record="${removable.id}"]`).waitFor();
  await page.getByLabel('搜索当前板块').fill('没有匹配的标题');
  await page.locator('.list-empty', { hasText: '没有匹配' }).waitFor();
  await page.getByRole('button', { name: '清空回收站', exact: true }).click();
  await page.getByRole('button', { name: '确认清空 1 项', exact: true }).waitFor();
  assert.match(await page.locator('.trash-confirm').innerText(), /不受搜索或分页限制/);
  assert.match(await page.locator('.trash-confirm').innerText(), /引用者/);
  assert.match(await page.locator('.trash-confirm').innerText(), /预计释放/);
  assert.match(await page.locator('.trash-confirm').innerText(), /百度云端历史/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(store.get(removable.id)?.deleted);
  await page.getByLabel('搜索当前板块').fill('');
  await page.locator(`[data-record="${removable.id}"]`).click();
  await page.locator('.document-heading h1', { hasText: removable.data.title }).waitFor();
  await page.getByRole('button', { name: '清空回收站', exact: true }).click();
  await page.getByRole('button', { name: '确认清空 1 项', exact: true }).waitFor();
  const added = make('确认后新增的回收内容');
  await page.getByRole('button', { name: '确认清空 1 项', exact: true }).click();
  await page.locator('#trash-clear-error', { hasText: '已变化' }).waitFor();
  assert.ok(store.get(removable.id));
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await app.service.organizeLocal();
  await page.getByRole('button', { name: '清空回收站', exact: true }).click();
  await page.getByRole('button', { name: '确认清空 2 项', exact: true }).waitFor();
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.screenshot({ path: path.join(root, `confirm-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.getByRole('button', { name: '确认清空 2 项', exact: true }).isVisible());
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  if (app.service.localTask) await app.service.localTask;
  await page.getByRole('button', { name: '确认清空 2 项', exact: true }).click();
  await page.locator('#toast', { hasText: '已永久删除 2 项' }).waitFor();
  assert.equal(store.get(removable.id), null); assert.equal(store.get(added.id), null);
  assert.ok(store.get(other.id)?.deleted); assert.ok(store.get(protectedNote.id)?.deleted);
  assert.equal(await page.locator(`[data-record="${removable.id}"]`).count(), 0);
  assert.equal((store.local('workspace')?.tabs || []).some(tab => tab.recordId === removable.id), false);
  await page.screenshot({ path: path.join(root, 'after.png') });
  await page.getByRole('button', { name: '清空回收站', exact: true }).click();
  await page.getByRole('button', { name: '确认清空 0 项', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认清空 0 项', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-storage-scan]').click();
  await page.waitForFunction(() => document.querySelector('[data-storage-results]') && !document.querySelector('[data-storage-results]').hasAttribute('aria-busy'));
  assert.equal(await page.getByRole('button', { name: '重试永久删除清理', exact: true }).count(), 0);
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('[data-storage-results]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `cleanup-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  const legacy = make('旧版隐藏残留', '旧领域');
  await app.service.organizeLocal();
  store.transaction(() => store.purgeRaw(legacy.id, legacy.heads));
  await app.service.organizeLocal();
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.locator('[data-nav=trash]').click();
  await page.getByRole('button', { name: '检查旧版残留', exact: true }).click();
  await page.getByRole('heading', { name: '清理旧版残留', exact: true }).waitFor();
  assert.match(await page.locator('.trash-confirm').innerText(), /全部知识库/);
  assert.match(await page.locator('.trash-confirm').innerText(), /旧领域/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(store.allEvents().filter(event => event.entityId === legacy.id).length, 3);
  await page.getByRole('button', { name: '检查旧版残留', exact: true }).click();
  await page.getByRole('heading', { name: '清理旧版残留', exact: true }).waitFor();
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.screenshot({ path: path.join(root, `legacy-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.getByRole('button', { name: '确认清空 1 项', exact: true }).click();
  await page.locator('#toast', { hasText: '已永久删除 1 项' }).waitFor();
  assert.equal(store.allEvents().some(event => event.entityId === legacy.id), false);
  assert.ok(store.get(other.id)?.deleted);
  assert.equal(await page.getByRole('button', { name: '检查旧版残留', exact: true }).count(), 0);
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-storage-scan]').click();
  await page.getByRole('button', { name: '检查废弃空目录', exact: true }).click();
  await page.getByRole('button', { name: '确认清理空目录', exact: true }).waitFor();
  assert.equal(await page.locator('#empty-directories-root').innerText(), store.directory);
  assert.match(await page.locator('#modal').innerText(), /可清理目录.*保留目录/s);
  assert.match(await page.locator('#modal').innerText(), /旧领域/);
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.screenshot({ path: path.join(root, `directories-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(fs.existsSync(path.join(store.directory, '旧领域')));
  await page.getByRole('button', { name: '检查废弃空目录', exact: true }).click();
  await page.getByRole('button', { name: '确认清理空目录', exact: true }).click();
  await page.locator('#toast', { hasText: '已清理 1 个废弃空目录' }).waitFor();
  assert.equal(fs.existsSync(path.join(store.directory, '旧领域')), false);
  assert.ok(fs.existsSync(store.directories.ensure(a)));
  assert.deepEqual(errors, []);
  console.log('PASS: trash scope, search independence, cancel, stale confirmation, protected references, tab cleanup and responsive confirmation.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally { await browser?.close(); await app.close(); }
