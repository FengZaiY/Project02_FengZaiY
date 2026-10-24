import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/ui-draft-workflow'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const store = app.service.store;
const library = store.saveLibrary({ title: '收集课程' }), target = store.saveLibrary({ title: '正式专题' });
const parent = store.write({ data: { title: '课程体系', domain: target.data.domain } });
const draft = store.write({ type: 'draft', data: { title: '可以直接归档的草稿', domain: library.data.domain,
  content: '<p><strong>已整理正文</strong></p><table><tr><th>条件</th></tr><tr><td>适用范围</td></tr></table>', format: 'html' } });
const todo = store.write({ type: 'draft', data: { title: '待拆解的课程草稿', domain: library.data.domain, content: '概念与实践' } });
const issued = app.service.agents.createGrant({ name: '隔离测试助手', domains: [library.data.domain, target.data.domain] });
const grant = app.service.agents.grants().find(item => item.id === issued.id);
const proposal = app.service.agents.dispatch(grant, { method: 'propose', requestId: uuid(), input: {
  preferencesVersion: app.service.agents.preferences().version, domain: library.data.domain, title: '课程整理方案',
  items: ['基础概念', '实践案例'].map(title => ({ draftRefs: [{ id: todo.id, versionId: todo.heads[0], complete: true }],
    data: { title, domain: target.data.domain, parentNoteId: parent.id, content: `${title}整理结果` } }))
} });
let browser, page; const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1304, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('[data-nav="drafts"]').click();
  await page.locator(`[data-record="${draft.id}"]`).click();
  await page.locator('.list-heading strong', { hasText: library.data.title }).waitFor();
  await page.locator('.tiptap').waitFor();
  assert.equal(await page.locator('.list-heading strong').innerText(), library.data.title);
  await page.evaluate(() => { window.draftEditor = document.querySelector('.tiptap').editor; });
  const sameEditor = async () => assert.equal(await page.evaluate(() => window.draftEditor === document.querySelector('.tiptap').editor), true);
  assert.ok(await page.locator('.compact-record').count());
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' navigation undo');
  await page.locator('[data-action="list-summary"]').click();
  assert.ok(await page.locator('.record-row.with-summary p').count());
  await page.locator('#draft-filter').selectOption('all');
  await page.locator('#search').fill('可以直接');
  await page.waitForFunction(() => document.querySelector('#draft-filter')?.disabled);
  await sameEditor();
  await page.locator('[data-action="toggle-navigation"]').click();
  assert.equal(await page.locator('.record-list').isVisible(), false);
  await page.locator('[data-action="toggle-navigation"]').click();
  await sameEditor();
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /navigation undo/);
  await page.locator('#search').fill('');
  await page.waitForFunction(() => !document.querySelector('#draft-filter')?.disabled);
  await page.locator('[data-action="list-summary"]').click();
  for (const width of [1304, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    if (width === 600) {
      await page.locator('[data-action="knowledge-browse"]').click();
      assert.equal(await page.locator('.record-list').isVisible(), true);
      assert.equal(await page.locator('[data-nav=drafts]').getAttribute('class'), 'nav-item active');
      await page.locator('[data-action="knowledge-browse"]').click();
      await sameEditor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `shared-navigation-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1304, height: 892 });
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  await page.reload();
  await page.locator('[data-nav="drafts"].active').waitFor();
  await page.locator('#draft-workflow').waitFor();
  await page.locator('[data-action="draft-archive"]').click();
  await page.locator('#draft-archive-form').waitFor();
  await page.screenshot({ path: path.join(root, 'archive-dialog.png'), fullPage: true });
  await page.locator('#modal [data-modal-close]').click();
  assert.equal(store.list({ type: 'note' }).length, 1, 'cancel does not archive');
  // Editing immediately before archiving must use the saved current body.
  await page.locator('.tiptap').press('Control+End');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type(' added before archive');
  await page.locator('[data-action="draft-archive"]').click();
  await page.locator('#draft-archive-form select[name="domain"]').selectOption(target.data.domain);
  await page.locator('#draft-archive-form select[name="parentNoteId"]').selectOption(parent.id);
  await page.locator('#draft-archive-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.document-type')?.textContent.includes('正式笔记'));
  const archived = store.list({ type: 'note' }).find(item => item.data.draftOrigin?.id === draft.id);
  assert.ok(archived); assert.equal(archived.data.parentNoteId, parent.id);
  assert.match(archived.data.content, /added before archive/); assert.match(archived.data.content, /<table/);
  assert.equal(archived.data.content, store.get(draft.id).data.content);
  await page.locator('[data-nav="drafts"]').click();
  await page.locator('#domain-filter').selectOption(library.data.domain);
  await page.locator(`[data-record="${todo.id}"]`).waitFor();
  assert.equal(await page.locator(`.record-row[data-record="${draft.id}"]`).count(), 0);
  await page.locator('#draft-filter').selectOption('processed');
  await page.locator(`.record-row[data-record="${draft.id}"]`).waitFor();
  await page.locator('#search').fill('待拆解');
  await page.locator(`.record-row[data-record="${todo.id}"]`).waitFor();
  assert.equal(await page.locator('#draft-filter').inputValue(), 'all');
  await page.locator('#search').fill('');
  await page.locator('#draft-filter').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#draft-filter')?.disabled);
  await page.locator('#draft-filter').selectOption('active');
  await page.locator(`.record-row[data-record="${todo.id}"]`).click();
  await page.locator('[data-action="draft-results"]').click();
  await page.locator(`[data-draft-open="${proposal.id}"]`).click();
  await page.locator('.proposal-operation', { hasText: '全部相关项确认后记为已处理' }).first().waitFor();
  await page.locator('[data-proposal-item]').first().check();
  await page.locator('[data-action="approve"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-item]:disabled').length === 1);
  assert.equal(await page.locator('[data-action="proposal-cleanup"]').count(), 0);
  await page.locator('[data-nav="drafts"]').click();
  await page.locator(`.record-row[data-record="${todo.id}"] .processing-status`, { hasText: '部分处理' }).waitFor();
  await page.locator(`.record-row[data-record="${todo.id}"]`).click();
  for (const width of [1304, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('[data-action="draft-results"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const footer = await page.locator('.statusbar').boundingBox(); assert.ok(footer.y + footer.height <= 893);
    await page.screenshot({ path: path.join(root, `partial-${width}.png`), fullPage: true });
    await page.locator('[data-action="draft-results"]').click();
    await page.locator('.draft-results').waitFor();
    await page.screenshot({ path: path.join(root, `results-${width}.png`), fullPage: true });
    await page.locator('#modal [data-modal-close]').click();
  }
  await page.setViewportSize({ width: 1304, height: 892 });
  await page.locator('[data-action="draft-results"]').click();
  await page.locator(`[data-draft-open="${proposal.id}"]`).click();
  await page.locator('[data-proposal-item]:not(:disabled)').check();
  await page.locator('[data-action="approve"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-item]:disabled').length === 2);
  assert.equal(await page.locator('[data-action="approve"]').count(), 0);
  assert.equal(await page.locator('[data-action="proposal-edit"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '查看入库笔记', exact: true }).count(), 2);
  await page.locator('#toast.show').waitFor({ state: 'detached' });
  for (const width of [1304, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('[data-action="proposal-cleanup"]').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `proposal-complete-${width}.png`), fullPage: true });
  }
  await page.locator('[data-action="proposal-cleanup"]').click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(store.get(proposal.id).deleted, false);
  await page.locator('[data-action="proposal-cleanup"]').click();
  await page.screenshot({ path: path.join(root, 'proposal-cleanup-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: '清理方案', exact: true }).click();
  await page.locator('[data-action="restore"]').waitFor();
  assert.equal(store.get(proposal.id).deleted, true);
  assert.equal(await page.locator('[data-action="proposal-cleanup"]').count(), 0);
  assert.equal(await page.locator('.record-row[data-record="' + proposal.id + '"]').count(), 0);
  const noteHeads = proposal.data.items.map(item => store.get(item.targetId).heads);
  await page.locator('[data-action="restore"]').click();
  await page.locator('[data-action="proposal-cleanup"]').waitFor();
  assert.equal(store.get(proposal.id).deleted, false);
  assert.deepEqual(proposal.data.items.map(item => store.get(item.targetId).heads), noteHeads);
  await page.locator('[data-action="proposal-cleanup"]').click();
  await page.getByRole('button', { name: '清理方案', exact: true }).click();
  await page.locator('[data-action="restore"]').waitFor();
  await page.setViewportSize({ width: 1304, height: 892 });
  await page.locator('[data-nav="drafts"]').click();
  await page.locator('#draft-filter').selectOption('processed');
  await page.locator(`.record-row[data-record="${todo.id}"]`).click();
  await page.locator('#draft-workflow .pill', { hasText: '已处理' }).waitFor();
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.type(' new material');
  await page.locator('[data-action="save"]').click();
  await page.locator('#draft-workflow .pill', { hasText: '待处理' }).waitFor();
  await page.reload();
  await page.locator('[data-nav="drafts"]').click();
  await page.locator(`.record-row[data-record="${todo.id}"] .processing-status`, { hasText: '待处理' }).waitFor();
  await page.locator(`.record-row[data-record="${todo.id}"]`).click();
  await page.locator('[data-action="draft-archive"]').click();
  await page.locator('#draft-archive-form').waitFor();
  const before = store.get(todo.id), noteCount = store.list({ type: 'note' }).length;
  store.write({ id: todo.id, type: 'draft', parents: before.heads, data: { ...before.data, content: '另一设备的新版本' } });
  await page.locator('#draft-archive-form button[type="submit"]').click();
  await page.locator('.draft-archive-error', { hasText: '草稿已修改' }).waitFor();
  assert.equal(store.list({ type: 'note' }).length, noteCount, 'stale dialog cannot archive');
  await page.locator('#modal [data-modal-close]').click();
  await page.locator('#domain-filter').selectOption('');
  await page.locator('.new-note').click();
  await page.locator('#new-record-form select').selectOption(library.data.domain);
  await page.locator('#new-record-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '未命名草稿');
  assert.equal(store.list({ type: 'draft' }).filter(item => item.data.title === '未命名草稿').length, 1);
  await page.locator('[data-nav="notes"]').click();
  await page.locator('#domain-filter').selectOption('');
  await page.locator('[data-action="note-view"][data-mode="list"]').click();
  await page.locator('[data-action="list-summary"]').click();
  assert.ok(await page.locator('.record-row.with-summary').count());
  await page.locator('[data-nav="drafts"]').click();
  assert.equal(await page.locator('[data-action="list-summary"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log('Draft archive UI passed: archive, filters, partial/full approval, proposal cleanup/cancel/restore, preserved results/status, source changes, restart and responsive screenshots.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  throw error;
} finally { await browser?.close(); await app.close(); }
