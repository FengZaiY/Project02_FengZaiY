import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const draftMode = process.argv.includes('--draft');
const recordType = draftMode ? 'draft' : 'note';
const root = path.resolve(draftMode ? 'artifacts/draft-editor-experience' : 'artifacts/editor-experience');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '学习资料' });
const otherLibrary = app.service.store.saveLibrary({ title: '其他领域' });
const target = app.service.store.write({ type: 'note', data: { title: '参考概念', domain: library.id, content: '参考内容摘要', format: 'markdown' } });
const other = app.service.store.write({ type: 'note', data: { title: '跨库参考', domain: otherLibrary.id, content: '其他领域' } });
const original = app.service.store.write({ type: recordType, data: { title: '交互验证', domain: library.id, format: 'html', content: '<h2>基础概念</h2><p>旧版需要取回的说明</p><p>重复原文</p><p>重复原文</p><h2>实践步骤</h2><p>结尾</p>' } });
const oldRevision = original.heads[0];
app.service.store.write({ id: original.id, type: recordType, parents: original.heads, data: { ...original.data, content: original.data.content.replace('旧版需要取回的说明', '新版说明') } });
app.service.store.write({ type: 'annotation', data: { title: '重复备注', domain: library.id, noteId: original.id, quote: '重复原文', content: '测试定位' } });
app.service.store.write({ type: 'annotation', data: { title: '失配备注', domain: library.id, noteId: original.id, quote: '已经被改掉的原句', content: '保留的心得' } });
let browser, page;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  if (draftMode) await page.locator('[data-nav=drafts]').click();
  await page.locator(`[data-record="${original.id}"]`).click(); await page.locator('.tiptap').waitFor();
  await page.evaluate(() => {
    window.initialEditor = document.querySelector('.tiptap').editor;
    window.copiedText = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text; } } });
  });
  const select = async (text, collapsed = false) => {
    await page.locator('.tiptap').evaluate((el, { text, collapsed }) => {
      const editor = el.editor; let found;
      editor.state.doc.descendants((node, pos) => {
        if (found || !node.isText) return;
        const index = node.text.indexOf(text);
        if (index >= 0) found = { from: pos + index, to: pos + index + text.length };
      });
      if (!found) throw new Error(`Text missing: ${text}`);
      if (collapsed) found.from = found.to;
      editor.chain().focus().setTextSelection(found).scrollIntoView().run();
    }, { text, collapsed });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const end = async () => {
    await page.locator('.tiptap').evaluate(el => el.editor.chain().focus('end').insertContent({ type: 'paragraph' }).run());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const saved = () => page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  await select('新版说明');
  await page.locator('.selection-tools:not([hidden])').waitFor();
  await page.screenshot({ path: path.join(root, 'selection.png') });
  await page.getByRole('button', { name: '加粗选中文字', exact: true }).click();
  assert.equal(await page.locator('.tiptap strong').innerText(), '新版说明');
  await page.getByRole('button', { name: '复制选中文字', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText), '新版说明');

  await end(); await page.keyboard.insertText('/标题 3');
  await page.locator('.editor-command-menu:not([hidden]) [role=option]').first().click();
  await page.keyboard.insertText('快捷创建章节');
  assert.equal(await page.locator('.tiptap h3').innerText(), '快捷创建章节');
  await page.getByRole('button', { name: '展开或收起正文目录' }).click();
  await page.locator('.document-outline button', { hasText: '快捷创建章节' }).waitFor();
  await page.locator('.document-outline button', { hasText: '实践步骤' }).click();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.state.selection.$from.parent.textContent), '实践步骤');
  await page.getByRole('button', { name: '收起正文目录', exact: true }).click();
  assert.equal(await page.locator('.document-outline').isVisible(), false);
  await page.getByRole('button', { name: '展开或收起正文目录' }).click();
  await page.getByLabel('正文字号', { exact: true }).selectOption('18');
  await page.getByLabel('正文宽度', { exact: true }).selectOption('wide');
  await page.getByRole('button', { name: '专注编辑', exact: true }).click();
  assert.equal(await page.locator('.record-list').isVisible(), false);
  assert.equal(await page.locator('.tiptap').evaluate(el => getComputedStyle(el).fontSize), '18px');
  assert.equal(await page.evaluate(() => window.initialEditor === document.querySelector('.tiptap').editor), true);
  await page.getByRole('button', { name: '专注编辑', exact: true }).click();
  await page.getByRole('button', { name: '展开或收起正文目录' }).click();
  await page.locator('[data-action=toggle-source]').click();
  const splitter = page.getByRole('separator', { name: '调整原附件宽度' });
  await splitter.waitFor();
  const initialWidth = Number(await splitter.getAttribute('aria-valuenow'));
  await splitter.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(Number(await splitter.getAttribute('aria-valuenow')), initialWidth + 20);
  const splitBox = await splitter.boundingBox();
  await page.mouse.move(splitBox.x + 3, splitBox.y + 30); await page.mouse.down();
  await page.mouse.move(splitBox.x + 23, splitBox.y + 30); await page.mouse.up();
  assert.ok(Number(await splitter.getAttribute('aria-valuenow')) > initialWidth + 20);
  await page.locator('[data-action=toggle-source]').click();
  assert.equal(await page.evaluate(() => window.initialEditor === document.querySelector('.tiptap').editor), true);
  await select('新版说明');
  await page.getByRole('button', { name: '在光标处插入', exact: true }).click();
  await page.locator('.editor-command-menu:not([hidden])').waitFor();
  await select('实践步骤', true);
  assert.equal(await page.locator('.editor-command-menu').isVisible(), false);
  assert.match(await page.locator('.tiptap').innerText(), /新版说明/);

  await end(); await page.keyboard.insertText('[[参考');
  await page.locator('.editor-command-menu [role=option]', { hasText: '参考概念' }).click();
  assert.equal(await page.locator(`.tiptap a[href="studyself://note/${target.id}"]`).count(), 1);
  await end(); await page.keyboard.insertText('[[跨库');
  await page.locator('.reference-scope').waitFor();
  assert.equal(await page.locator('.editor-command-menu [role=option]').count(), 0);
  await page.locator('.reference-scope input').check();
  await page.locator('.editor-command-menu [role=option]', { hasText: '跨库参考' }).click();
  assert.equal(await page.locator(`.tiptap a[href="studyself://note/${other.id}"]`).count(), 1);
  await page.locator(`.tiptap a[href="studyself://note/${target.id}"]`).hover();
  await page.locator('.note-link-preview:not([hidden])').waitFor();
  assert.match(await page.locator('.note-link-preview').innerText(), /参考内容摘要/);

  await end(); await page.locator('#insert-content').selectOption('table');
  await page.getByRole('button', { name: '2 行 3 列', exact: true }).click();
  assert.equal(await page.locator('.tiptap table tr').count(), 2);
  await page.locator('.tiptap td').first().click(); await page.keyboard.insertText('单元格内容');
  await page.getByRole('button', { name: '在下方插入行', exact: true }).click();
  assert.equal(await page.locator('.tiptap table tr').count(), 3);
  await page.getByRole('button', { name: '复制整张表格', exact: true }).click();
  assert.match(await page.evaluate(() => window.copiedText), /单元格内容/);
  await end();
  const paste = (text, html = '') => page.locator('.tiptap').evaluate((el, { text, html }) => {
    const data = new DataTransfer(); data.setData('text/plain', text); if (html) data.setData('text/html', html);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, { text, html });
  await paste('名称\t说明\n第一项\t"多行\n说明"');
  assert.equal(await page.locator('.tiptap table').count(), 2);
  assert.match(await page.locator('.tiptap table').last().innerText(), /多行/);
  await end();
  await paste('网页段落', '<p><strong>网页段落</strong></p><img src="https://example.invalid/private.png"><script>alert(1)</script>');
  assert.match(await page.locator('#toast').innerText(), /另行导入/);
  assert.equal(await page.locator('.tiptap img[src^="https"]').count(), 0);
  assert.equal(await page.locator('.tiptap script').count(), 0);
  await end();
  await page.locator('.tiptap').evaluate(el => {
    const editor = el.editor;
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    editor.commands.insertContent('/表');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('.editor-command-menu').isVisible(), false);
  await page.locator('.tiptap').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.keyboard.press('Escape'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');

  await end(); await page.locator('[data-action=fmt-code]').click();
  await page.waitForFunction(() => document.querySelector('.tiptap').editor.isActive('codeBlock') && window.getSelection()?.anchorNode?.parentElement?.closest('.code-surface'));
  await page.keyboard.insertText('print("hello")');
  await page.getByLabel('代码语言', { exact: true }).selectOption('python');
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText), 'print("hello")');
  await page.getByRole('button', { name: '代码自动换行', exact: true }).click();
  assert.equal(await page.locator('.code-wrap').count(), 1);
  await page.locator('.tiptap').evaluate(el => el.editor.chain().focus('end').exitCode().run());

  // Clipboard image ingestion maps its destination while the user continues typing.
  let releaseUpload, announceUpload;
  const entered = new Promise(resolve => { announceUpload = resolve; }), gate = new Promise(resolve => { releaseUpload = resolve; });
  await page.route('**/upload?*', async route => { announceUpload(); await gate; await route.continue(); });
  await page.locator('.tiptap').evaluate(el => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 50;
    const context = canvas.getContext('2d'); context.fillStyle = '#477f9a'; context.fillRect(0, 0, 80, 50);
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0))], '截图.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await entered; await page.keyboard.insertText('上传期间继续输入'); releaseUpload();
  await page.waitForFunction(() => document.querySelector('.tiptap img')?.naturalWidth === 80);
  assert.match(await page.locator('.tiptap').innerText(), /上传期间继续输入/);
  await page.unroute('**/upload?*');

  await select('新版说明');
  await page.getByRole('button', { name: '为选中文字添加备注', exact: true }).click();
  await page.locator('#modal textarea').fill('与这句话对应的心得');
  await page.locator('#modal [data-confirm]').click();
  await page.locator('.annotation', { hasText: '与这句话对应的心得' }).waitFor();
  assert.equal(await page.evaluate(() => window.initialEditor === document.querySelector('.tiptap').editor), true);
  await page.locator('.annotation', { hasText: '与这句话对应的心得' }).getByRole('button', { name: '定位原文' }).click();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.state.doc.textBetween(el.editor.state.selection.from, el.editor.state.selection.to)), '新版说明');
  const beforeLocate = await page.locator('.tiptap').evaluate(el => el.editor.getHTML());
  await page.locator('.annotation', { hasText: '测试定位' }).getByRole('button', { name: '定位原文' }).click();
  await page.locator('.editor-command-menu [role=option]').nth(1).click();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.getHTML()), beforeLocate);
  await page.locator('.annotation', { hasText: '保留的心得' }).getByRole('button', { name: '定位原文' }).click();
  assert.match(await page.locator('#toast').innerText(), /原文已修改/);
  await page.getByRole('button', { name: '查找与替换', exact: true }).click();
  await page.getByLabel('文内查找', { exact: true }).fill('新版说明');
  await page.getByRole('button', { name: '下一个匹配', exact: true }).click();
  await page.getByLabel('替换为', { exact: true }).fill('更新后的说明');
  await page.getByRole('button', { name: '替换当前', exact: true }).click();
  assert.match(await page.locator('.tiptap').innerText(), /更新后的说明/);
  await page.getByRole('button', { name: '关闭文内查找', exact: true }).click();
  await page.locator('[data-action=fmt-undo]').click();
  assert.match(await page.locator('.tiptap').innerText(), /新版说明/);
  await saved();

  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await page.locator(`[data-history-revision="${oldRevision}"]`).click();
  await page.getByLabel('历史对比基准', { exact: true }).selectOption('current');
  await page.locator('.history-block', { hasText: '旧版需要取回的说明' }).locator('input').check();
  await page.screenshot({ path: path.join(root, 'history.png') });
  await page.getByRole('button', { name: '将勾选内容插入正文', exact: true }).click();
  assert.match(await page.locator('.tiptap').innerText(), /旧版需要取回的说明/);
  assert.match(await page.locator('.tiptap').innerText(), /新版说明/);
  await page.locator('[data-action=fmt-undo]').click();
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /旧版需要取回的说明/);
  await saved();
  assert.ok(app.service.store.history(original.id).some(event => event.id === oldRevision));
  assert.doesNotMatch(app.service.store.get(original.id).data.content, /editor-match|selection-tools|editor-command-menu/);
  assert.match(app.service.store.get(original.id).data.content, new RegExp(`studyself://note/${target.id}`));
  if (draftMode) await page.locator('[data-nav=notes]').click();
  await page.locator(`[data-record="${target.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '参考概念');
  await page.locator('.backlinks summary').click();
  await page.locator('.backlinks button', { hasText: '交互验证' }).waitFor();
  await page.locator('.backlinks button', { hasText: '交互验证' }).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '交互验证');

  await page.getByRole('button', { name: '展开或收起正文目录' }).click();
  for (const width of [1480, 1220, 980, 600]) {
    await page.setViewportSize({ width, height: 940 });
    await page.locator('.editor-scroll').evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: path.join(root, `editor-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow at ${width}`);
    await page.locator('.editor-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
    assert.ok(await page.locator('.editor-scroll').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3));
  }
  await page.locator('[data-nav=assets]').click();
  assert.equal(await page.locator('.selection-tools,.editor-command-menu,.note-link-preview').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: bubble/IME/slash/outline/reading/table/clipboard/copy/references/annotations/find/history/recovery and responsive screenshots.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally { await browser?.close(); await app.close(); }
