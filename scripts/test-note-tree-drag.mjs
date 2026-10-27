import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../src/server.mjs';
import { hashFile } from '../src/core/util.mjs';

const root = path.resolve('artifacts/note-tree-drag'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser, page;
const releaseGates = [];
const errors = [];
async function until(check) {
  const start = Date.now();
  while (!check()) { assert.ok(Date.now() - start < 15000, 'Timed out waiting for saved hierarchy or directory maintenance'); await delay(50); }
}
try {
  clearInterval(app.service.timer); app.service.timer = null;
  const store = app.service.store, library = store.saveLibrary({ title: '知识体系拖动验证' });
  const foreignLibrary = store.saveLibrary({ title: '其他知识库' });
  const makeNote = (title, parentNoteId = null, domain = library.id, extra = {}) => store.write({
    type: 'note', data: { title, parentNoteId, domain, format: 'html', content: `<p>${title}的原正文</p>`, ...extra }
  });
  const parent = makeNote('主题概览'), child = makeNote('原理笔记'), leaf = makeNote('实践案例', child.id);
  const closed = makeNote('独立笔记'), foreign = makeNote('跨库目标', null, foreignLibrary.id);
  const original = path.join(root, '独立资料.txt'), sharedOriginal = path.join(root, '共用资料.txt');
  fs.writeFileSync(original, '原件内容不可损坏'); fs.writeFileSync(sharedOriginal, '多个笔记共享的原件');
  const asset = await app.service.call('assetImport', { path: original, domain: library.id });
  const shared = await app.service.call('assetImport', { path: sharedOriginal, domain: library.id });
  store.write({ id: child.id, type: 'note', parents: child.heads, data: { ...child.data, assetIds: [asset.id, shared.id] } });
  store.write({ id: parent.id, type: 'note', parents: parent.heads, data: { ...parent.data, assetIds: [shared.id] } });
  await app.service.organizeLocal();
  const oldPath = store.assetLocation(asset.id).path, sharedPath = store.assetLocation(shared.id).path;
  const extra = path.join(path.dirname(path.dirname(oldPath)), '用户额外文件.txt');
  fs.writeFileSync(extra, '不属于系统生成内容');
  const leafHistory = store.history(leaf.id).length, assetHeads = store.get(asset.id).heads;
  app.service.startTimer();
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1304, height: 892 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  const node = id => page.locator(`[data-note-drag][data-note="${id}"]`);
  const startDrag = async id => {
    // Autosave can replace the navigation between locator resolution and scrolling.
    for (let attempt = 0; ; attempt++) {
      try { await node(id).scrollIntoViewIfNeeded(); break; }
      catch (error) { if (attempt >= 2 || !error.message.includes('not attached')) throw error; }
    }
    const box = await node(id).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 14, box.y + box.height / 2, { steps: 4 });
    await page.locator('body.note-tree-dragging').waitFor();
  };
  const hover = async (target, ratio = 0.5) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * ratio, { steps: 12 });
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height * ratio);
  };
  const drag = async (id, target, ratio) => { await startDrag(id); await hover(target, ratio); await page.mouse.up(); };
  const sameEditor = async () => assert.equal(await page.evaluate(() => window.treeDragEditor === document.querySelector('.tiptap').editor), true);
  const saved = () => page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  await node(child.id).click();
  await page.getByRole('button', { name: '原附件', exact: true }).click();
  await page.locator(`[data-preview-asset="${asset.id}"]`).click();
  await page.locator('#source-preview .text-preview').waitFor();
  await page.evaluate(() => { window.treeDragEditor = document.querySelector('.tiptap').editor; });
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 拖动前输入');
  let release, reached;
  const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => reached = resolve);
  releaseGates.push(release);
  let held = false;
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === child.id && body.input.data.parentNoteId === parent.id && !held) {
      held = true; reached(); await gate;
    }
    await route.continue();
  });
  await startDrag(child.id); await hover(node(parent.id));
  await page.locator('.note-tree-drop-hint', { hasText: '主题概览' }).waitFor();
  await page.screenshot({ path: path.join(root, 'drop-target-1304.png') });
  await page.mouse.up();
  await Promise.race([started, delay(15000).then(() => { throw new Error('Drag did not queue the requested parent change'); })]);
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 保存期间的新输入');
  release(); await saved(); await page.unrouteAll({ behavior: 'wait' });
  await until(() => store.get(child.id).data.parentNoteId === parent.id);
  await page.waitForFunction(id => document.querySelector(`[data-note="${id}"][data-note-drag]`)?.getAttribute('aria-level') === '2', child.id);
  await sameEditor();
  assert.match(store.get(child.id).data.content, /拖动前输入.*保存期间的新输入/);
  assert.match(await page.locator('.document-breadcrumb').innerText(), /主题概览/);
  assert.match(await page.locator('#source-preview').innerText(), /原件内容不可损坏/);
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /保存期间的新输入/);
  await page.locator('.tiptap').press('Control+Shift+z'); await saved();
  await until(() => !app.service.localHierarchy.status().pending && !app.service.localHierarchy.status().busy);
  const movedPath = store.assetLocation(asset.id).path;
  assert.equal(movedPath, oldPath, 'Central originals keep their stable path when note hierarchy changes');
  assert.equal(await hashFile(movedPath), asset.data.sha256);
  assert.equal(fs.existsSync(oldPath), true);
  assert.equal(fs.existsSync(extra), true);
  assert.equal(fs.existsSync(original), true);
  assert.equal(store.assetLocation(shared.id).path, sharedPath);
  assert.ok(Object.keys(store.local('hierarchyFiles')).some(file => file.includes(parent.id) && file.includes(child.id) && file.endsWith(`${leaf.id}.md`)));
  assert.equal(store.history(leaf.id).length, leafHistory);
  assert.deepEqual(store.get(asset.id).heads, assetHeads);
  await page.screenshot({ path: path.join(root, 'moved-1304.png') });

  await drag(child.id, page.locator(`[data-note-drop-root="${library.id}"]`));
  await until(() => store.get(child.id).data.parentNoteId === null);
  await saved(); await sameEditor();
  await until(() => store.assetLocation(asset.id).path === oldPath && !app.service.localHierarchy.status().pending);
  assert.equal(store.get(leaf.id).data.parentNoteId, child.id);
  assert.equal(fs.existsSync(movedPath), true);
  // Invalid targets, Escape and forged drag payloads do not create history.
  const historyBefore = store.history(child.id).length;
  await startDrag(child.id); await hover(node(leaf.id));
  await page.locator('.note-tree-drop-hint.invalid', { hasText: '自身或下级' }).waitFor();
  await page.mouse.up();
  await startDrag(child.id); await hover(node(child.id)); await page.mouse.up();
  await startDrag(child.id); await hover(node(parent.id)); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.note-tree-drop-hint').count(), 0);
  assert.equal(store.history(child.id).length, historyBefore);
  await node(parent.id).evaluate(el => {
    const transfer = new DataTransfer(); transfer.setData('application/x-studyself-note-tree', 'forged');
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  assert.equal(store.history(child.id).length, historyBefore);
  // A failed save preserves text while undoing the uncommitted placement.
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === child.id) await route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'IO_ERROR', message: '模拟层级保存失败' } }) });
    else await route.continue();
  });
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 失败也保留的输入');
  await drag(child.id, node(parent.id));
  await page.locator('[data-action=save][data-status=error]').waitFor();
  assert.equal(store.get(child.id).data.parentNoteId, null);
  assert.match(await page.locator('.tiptap').innerText(), /失败也保留的输入/);
  await page.unrouteAll({ behavior: 'wait' });
  await page.locator('[data-action=save]').click(); await saved();
  assert.equal(store.get(child.id).data.parentNoteId, null);
  assert.match(store.get(child.id).data.content, /失败也保留的输入/);
  // Moving a background tab must join its in-flight writer and keep the foreground editor.
  let releaseBackground, enteredBackground;
  const backgroundGate = new Promise(resolve => releaseBackground = resolve);
  const backgroundStarted = new Promise(resolve => enteredBackground = resolve);
  releaseGates.push(releaseBackground);
  let backgroundHeld = false;
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === child.id && !backgroundHeld) {
      backgroundHeld = true; enteredBackground(); await backgroundGate;
    }
    await route.continue();
  });
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 后台标签输入');
  await node(parent.id).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '主题概览');
  await Promise.race([backgroundStarted, delay(15000).then(() => { throw new Error('Background autosave did not start'); })]);
  await page.evaluate(() => { window.foregroundEditor = document.querySelector('.tiptap').editor; });
  await drag(child.id, node(parent.id));
  releaseBackground(); await page.unrouteAll({ behavior: 'wait' });
  await until(() => store.get(child.id).data.parentNoteId === parent.id && /后台标签输入/.test(store.get(child.id).data.content));
  assert.equal(await page.evaluate(() => window.foregroundEditor === document.querySelector('.tiptap').editor), true);
  assert.equal(await page.locator('#note-title').inputValue(), '主题概览');
  await page.waitForFunction(id => document.querySelector(`[data-note="${id}"][data-note-drag]`)?.getAttribute('aria-level') === '2', child.id);
  await drag(child.id, page.locator(`[data-note-drop-root="${library.id}"]`));
  await until(() => store.get(child.id).data.parentNoteId === null);
  await page.waitForFunction(id => document.querySelector(`[data-note="${id}"][data-note-drag]`)?.getAttribute('aria-level') === '1', child.id);
  // A closed note uses its observed base version, not an unseen remote revision.
  await startDrag(closed.id); await hover(node(parent.id));
  const current = store.get(closed.id);
  const remote = store.write({ id: closed.id, type: 'note', parents: current.heads, data: { ...current.data, content: '<p>另一端的新内容</p>' } });
  await page.mouse.up();
  await page.locator('#toast', { hasText: '笔记已变化' }).waitFor();
  assert.deepEqual(store.get(closed.id).heads, remote.heads);
  assert.equal(store.get(closed.id).data.parentNoteId, null);
  await page.evaluate(() => { window.beforeRefresh = document.querySelector('.tiptap'); });
  await page.locator('[data-action=refresh-view]').click();
  await page.waitForFunction(() => document.querySelector('.tiptap') && document.querySelector('.tiptap') !== window.beforeRefresh);
  await node(closed.id).waitFor();
  await drag(closed.id, node(parent.id));
  await until(() => store.get(closed.id).data.parentNoteId === parent.id);
  assert.match(store.get(closed.id).data.content, /另一端的新内容/);
  await page.reload(); await node(child.id).waitFor();
  assert.equal(await node(closed.id).getAttribute('aria-level'), '2');
  // Top/bottom zones reorder siblings and lift nested notes to the target's level.
  await node(parent.id).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '主题概览' && document.querySelector('.tiptap')?.editor);
  await page.evaluate(() => { window.orderEditor = document.querySelector('.tiptap').editor; });
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 排序期间的父笔记输入');
  const rootIds = () => store.noteTree(library.id).filter(item => item.parentNoteId === null).map(item => item.id);
  const beforeOrderFile = store.assetLocation(asset.id).path;
  await startDrag(child.id); await hover(node(parent.id), 0.9);
  await page.locator('.note-drop-after').waitFor();
  await page.screenshot({ path: path.join(root, 'sibling-after-1304.png') });
  await page.mouse.up();
  await until(() => rootIds().indexOf(child.id) === rootIds().indexOf(parent.id) + 1);
  await saved();
  assert.match(store.get(parent.id).data.content, /排序期间的父笔记输入/);
  assert.equal(await page.evaluate(() => window.orderEditor === document.querySelector('.tiptap').editor), true);
  await until(() => !app.service.localHierarchy.status().pending && !app.service.localHierarchy.status().busy);
  assert.equal(store.assetLocation(asset.id).path, beforeOrderFile, 'Reordering must not relocate originals');
  await startDrag(child.id); await hover(node(parent.id), 0.1);
  await page.locator('.note-drop-before').waitFor();
  await page.screenshot({ path: path.join(root, 'sibling-before-1304.png') });
  await page.mouse.up();
  await until(() => rootIds().indexOf(child.id) + 1 === rootIds().indexOf(parent.id));
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('[data-note-drag][aria-level="1"]')].map(item => item.dataset.note)) === JSON.stringify(ids), rootIds());
  await drag(closed.id, node(child.id), 0.9);
  await until(() => store.get(closed.id).data.parentNoteId === null && rootIds().indexOf(closed.id) === rootIds().indexOf(child.id) + 1);
  await page.waitForFunction(id => document.querySelector(`[data-note="${id}"][data-note-drag]`)?.getAttribute('aria-level') === '1', closed.id);
  assert.equal(store.get(leaf.id).data.parentNoteId, child.id);
  const beforeNoop = store.allEvents().length;
  await startDrag(closed.id); await hover(node(child.id), 0.9);
  await page.locator('.note-tree-drop-hint.invalid', { hasText: '已在此位置' }).waitFor();
  await page.mouse.up();
  assert.equal(store.allEvents().length, beforeNoop);
  // The sorted note itself can keep typing while its ordering save is in flight.
  await node(child.id).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '原理笔记' && document.querySelector('.tiptap')?.editor);
  await page.evaluate(() => { window.orderEditor = document.querySelector('.tiptap').editor; });
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 排序中的正文');
  let releaseOrder, enteredOrder;
  const orderGate = new Promise(resolve => releaseOrder = resolve), orderStarted = new Promise(resolve => enteredOrder = resolve);
  releaseGates.push(releaseOrder);
  let heldOrder = false;
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === child.id && body.input.notePlacement && !heldOrder) {
      heldOrder = true; enteredOrder(); await orderGate;
    }
    await route.continue();
  });
  await drag(child.id, node(parent.id), 0.9);
  await Promise.race([orderStarted, delay(15000).then(() => { throw new Error('Ordering save did not start'); })]);
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 排序保存期间的新输入');
  releaseOrder(); await saved(); await page.unrouteAll({ behavior: 'wait' });
  await until(() => rootIds().indexOf(child.id) === rootIds().indexOf(parent.id) + 1);
  assert.match(store.get(child.id).data.content, /排序中的正文.*排序保存期间的新输入/);
  assert.equal(await page.evaluate(() => window.orderEditor === document.querySelector('.tiptap').editor), true);
  const savedOrder = store.get(child.id).data.noteOrder;
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 再次编辑'); await saved();
  assert.equal(store.get(child.id).data.noteOrder, savedOrder);
  // A destination changed after hovering cannot silently receive an outdated ordering request.
  await startDrag(closed.id); await hover(node(parent.id), 0.9);
  const parentNow = store.get(parent.id);
  store.write({ id: parent.id, parents: parentNow.heads, data: { ...parentNow.data, content: `${parentNow.data.content}<p>目标远端修改</p>` } });
  const beforeStaleDrop = store.allEvents().length;
  await page.mouse.up(); await page.locator('#toast', { hasText: '笔记已变化' }).waitFor();
  assert.equal(store.allEvents().length, beforeStaleDrop);
  const expectedOrder = rootIds();
  await page.reload(); await node(child.id).waitFor();
  assert.deepEqual(await page.locator('[data-note-drag][aria-level="1"]').evaluateAll(items => items.map(item => item.dataset.note)), expectedOrder);
  assert.equal(store.assetLocation(asset.id).path, beforeOrderFile);
  await page.locator('#domain-filter').selectOption('');
  await node(foreign.id).waitFor();
  await startDrag(child.id); await hover(node(foreign.id));
  await page.locator('.note-tree-drop-hint.invalid', { hasText: '其他知识库' }).waitFor();
  await page.mouse.up();
  assert.equal(store.get(child.id).data.domain, library.id);
  for (const width of [1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    if (width === 600 && !await node(child.id).isVisible()) await page.locator('[data-action=knowledge-browse]').click();
    await node(child.id).waitFor({ state: 'visible' });
    await startDrag(child.id); await hover(node(parent.id));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `drop-target-${width}.png`) });
    await page.keyboard.press('Escape'); await page.mouse.up();
    await startDrag(child.id); await hover(node(parent.id), 0.1);
    await page.locator('.note-drop-before').waitFor();
    await page.screenshot({ path: path.join(root, `sibling-before-${width}.png`) });
    await page.keyboard.press('Escape'); await page.mouse.up();
  }
  // Scroll a long tree while holding the source; cancelling must leave every note intact.
  const scrollSource = makeNote('000 起点');
  for (let i = 0; i < 40; i++) makeNote(`100 滚动资料 ${String(i).padStart(2, '0')}`);
  await page.setViewportSize({ width: 1304, height: 892 });
  await page.locator('#domain-filter').selectOption(library.id);
  await node(scrollSource.id).waitFor();
  await startDrag(scrollSource.id);
  const treeBox = await page.locator('.folder-tree').boundingBox();
  await page.mouse.move(treeBox.x + 80, treeBox.y + treeBox.height - 8, { steps: 20 });
  await page.mouse.move(treeBox.x + 81, treeBox.y + treeBox.height - 8);
  await page.waitForFunction(() => document.querySelector('.folder-tree').scrollTop > 100);
  await page.screenshot({ path: path.join(root, 'edge-scroll.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(store.get(scrollSource.id).data.parentNoteId, null);
  assert.equal(store.history(scrollSource.id).length, 1);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, oldPath, movedPath, sharedPath }, null, 2));
  console.log('PASS: real note-tree drag, same-level placement and sorting, subtree/root moves, live editor/preview/undo, in-flight edits, directories/originals/shared files, failure recovery, stale source/destination, cancellation, cross-library guards and responsive screenshots.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error;
} finally { releaseGates.forEach(release => release()); await browser?.close(); await app.close(); }
