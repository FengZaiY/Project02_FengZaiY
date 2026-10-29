import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/ui-note-hierarchy'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1480, height: 940 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('.breadcrumb [data-action="library-new"]').click();
  await page.locator('#library-form input[name="title"]').fill('研究手册');
  await page.locator('#library-form button[type="submit"]').click();
  await page.locator('.knowledge-browser').waitFor();
  assert.equal(await page.locator('.list-rows').count(), 0);
  assert.equal(await page.locator('.record-list [data-action="new"]').count(), 1);
  assert.equal(await page.locator('[data-mode="tree"]').getAttribute('aria-pressed'), 'true');
  const library = app.service.state().libraries[0], domain = library.data.domain;
  assert.ok(fs.existsSync(library.localDirectory));
  assert.equal(await page.locator('[data-action="folder-new"],[data-action="local-organize"]').count(), 0);
  const save = async (title, content) => {
    await page.locator('#note-title').fill(title);
    await page.locator('.tiptap').fill(content);
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="save"]')?.textContent.includes('已保存'));
    await page.locator('[data-action="tree-open"] span', { hasText: title }).waitFor();
    return app.service.store.list({ type: 'note' }).find(item => item.data.title === title);
  };
  await page.locator('.list-heading [data-action="new"]').click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '未命名笔记');
  const parent = await save('主题概览', '主题的核心问题、基础概念和实践路径。');
  await page.locator('.document-actions [data-action="note-child"]').click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '未命名笔记');
  const child = await save('基础概念', '概念的定义、适用条件与例子。');
  assert.equal(child.data.parentNoteId, parent.id);
  assert.match(await page.locator('.document-breadcrumb').innerText(), /主题概览/);
  await page.locator('[data-action="note-parent"]').click();
  assert.equal(await page.locator('#note-parent-form option', { hasText: '基础概念' }).count(), 0);
  await page.locator('#note-parent-form select').selectOption('');
  await page.locator('#note-parent-form button').click();
  await page.waitForFunction(() => !document.querySelector('#modal')?.open);
  assert.equal(app.service.store.get(child.id).data.parentNoteId, null);
  await page.locator('[data-action="note-parent"]').click();
  await page.locator('#note-parent-form select').selectOption(parent.id);
  await page.locator('#note-parent-form button').click();
  await page.waitForFunction(() => !document.querySelector('#modal')?.open);
  await page.locator(`[data-action="tree-open"][data-note="${parent.id}"]`).click();
  await page.locator('#note-title').waitFor();
  await page.locator('[data-action="delete"]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('下级笔记'));
  assert.equal(app.service.store.get(parent.id).deleted, false);

  const access = app.service.agents, issued = access.createGrant({ name: '知识体系助手', domains: [domain] });
  const grant = access.grants().find(item => item.id === issued.id);
  const proposal = access.dispatch(grant, { method: 'propose', requestId: uuid(), input: {
    preferencesVersion: access.preferences().version, domain, title: '补全实践知识体系', content: '将实践方法纳入主题概览，并补充案例。',
    items: [
      { key: 'case', parentKey: 'practice', reason: '用具体案例帮助理解方法', data: { title: '实践案例', domain, content: '案例背景、过程和结果。' } },
      { key: 'practice', reason: '方法连接概念与实际应用', data: { title: '实践方法', domain, parentNoteId: parent.id, content: '步骤、条件和注意事项。' } }
    ]
  } });
  await page.locator('[data-nav="proposals"]').click();
  await page.locator(`[data-record="${proposal.id}"]`).click();
  await page.locator('[data-action="approve"]').waitFor();
  assert.match(await page.locator('.proposal-item').first().innerText(), /主题概览.*实践方法/);
  assert.match(await page.locator('.proposal-item').first().innerText(), /用具体案例/);
  await page.locator(`[data-proposal-item="${proposal.data.items[0].id}"]`).check();
  await page.locator('[data-action="approve"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('同时选择'));
  assert.equal(app.service.store.get(proposal.data.items[0].targetId), null);
  await page.locator(`[data-proposal-item="${proposal.data.items[1].id}"]`).check();
  await page.screenshot({ path: path.join(root, 'proposal-preview.png'), fullPage: true });
  await page.locator('[data-action="approve"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-item]:disabled').length === 2);
  await page.locator('[data-nav="notes"]').click();
  await page.locator(`[data-action="tree-open"][data-note="${parent.id}"]`).click();
  await page.locator('.document-actions svg').first().waitFor();
  assert.match(await page.locator('.knowledge-browser').innerText(), /实践案例/);
  await app.service.organizeLocal();
  assert.deepEqual(app.service.localHierarchy.status().errors, []);
  const directories = app.service.store.local('readableDirectories');
  assert.equal(path.dirname(directories[`note:${child.id}`]), directories[`note:${parent.id}`]);
  assert.ok(fs.existsSync(path.join(app.service.store.directory, directories[`note:${child.id}`], '正文.md')));
  for (const [width, height] of [[1480, 940], [1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `knowledge-${width}.png`), fullPage: true });
  }
  await page.locator('[data-action="knowledge-browse"]').click();
  await page.locator('.record-list').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(root, 'knowledge-tree-600.png'), fullPage: true });
  await page.setViewportSize({ width: 1480, height: 940 });
  await page.locator(`[data-action="note-toggle"][data-note="${parent.id}"]`).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-action="tree-open"]')].some(el => el.textContent.includes('基础概念')));
  await page.reload();
  await page.locator('.knowledge-browser').waitFor();
  assert.equal(await page.locator(`[data-action="tree-open"][data-note="${child.id}"]`).count(), 0);
  await page.locator(`[data-action="note-toggle"][data-note="${parent.id}"]`).click();
  await page.locator(`[data-action="tree-open"][data-note="${child.id}"]`).waitFor();
  // View switches and search replace only navigation, preserving the live editor and undo history.
  await page.locator(`[data-record="${child.id}"]`).click();
  await page.waitForFunction(title => document.querySelector('#note-title')?.value === title, child.data.title);
  await page.evaluate(() => { window.editorBeforeViewSwitch = document.querySelector('.tiptap'); });
  await page.locator('.tiptap').press('Control+End');
  await page.keyboard.insertText(' 视图切换中的编辑');
  await page.locator('[data-mode="list"]').click();
  assert.equal(await page.locator('.knowledge-browser').count(), 0);
  assert.equal(await page.locator('.record-row').count(), 4);
  assert.equal(await page.evaluate(() => window.editorBeforeViewSwitch === document.querySelector('.tiptap')), true);
  assert.match(await page.locator('.tiptap').innerText(), /视图切换中的编辑/);
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /视图切换中的编辑/);
  await page.locator('.tiptap').press('Control+Shift+z');
  assert.match(await page.locator('.tiptap').innerText(), /视图切换中的编辑/);
  for (const [width, height] of [[1480, 940], [1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    if (width === 600) await page.locator('[data-action="knowledge-browse"]').click();
    await page.locator('.record-list').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `note-list-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1480, height: 940 });
  await page.reload();
  await page.locator('[data-mode="list"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator('.knowledge-browser').count(), 0);
  await page.locator('[data-mode="tree"]').click();
  await page.locator(`[data-action="note-toggle"][data-note="${parent.id}"]`).click();
  await page.locator('#search').fill('适用条件');
  await page.locator(`[data-record="${child.id}"]`).waitFor();
  assert.equal(await page.locator('[data-action="tree-open"]').count(), 2);
  assert.equal(await page.locator('.tree-context').count(), 1);
  await page.locator('[data-mode="list"]').click();
  assert.equal(await page.locator('.record-row').count(), 1);
  await page.locator('#search').fill('完全没有匹配的词');
  await page.locator('.list-empty', { hasText: '没有匹配的笔记' }).waitFor();
  await page.locator('[data-mode="tree"]').click();
  await page.locator('.list-empty', { hasText: '没有匹配的笔记' }).waitFor();
  await page.locator('#search').fill('');
  await page.locator(`[data-record="${parent.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-record="${child.id}"]`).count(), 0, 'Search must not overwrite collapsed state');
  await page.locator(`[data-action="note-toggle"][data-note="${parent.id}"]`).click();
  await page.locator('#domain-filter').selectOption('');
  await page.locator('.tree-library-label', { hasText: '研究手册' }).waitFor();
  // The final tree row must remain reachable in the constrained workspace.
  for (let i = 0; i < 45; i++) app.service.store.write({ type: 'note', data: { title: `滚动笔记 ${String(i).padStart(2, '0')}`, domain, content: '' } });
  await page.locator('[data-action="refresh-view"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-action="tree-open"]').length === 49);
  const lastNode = page.locator('[data-action="tree-open"]').last();
  await lastNode.scrollIntoViewIfNeeded();
  const lastBox = await lastNode.boundingBox(), footer = await page.locator('.statusbar').boundingBox();
  assert.ok(lastBox.y + lastBox.height <= footer.y);
  await page.screenshot({ path: path.join(root, 'tree-scroll-bottom.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: note hierarchy, proposals, exclusive views, view persistence, live editor preservation, scoped search with ancestors, collapse state and scroll reachability.');
} finally { await browser?.close(); await app.close(); }
