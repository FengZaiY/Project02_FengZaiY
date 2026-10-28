import { _electron as electron, chromium } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.mjs';

const desktop = process.argv.includes('--desktop');
const root = path.resolve('artifacts/edit-shortcuts');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, desktop ? 'desktop-' : 'browser-'));
let application, browser, server, page, pid;
const errors = [];
try {
  if (desktop) {
    application = await electron.launch({ executablePath: electronPath,
      args: [path.resolve('.'), '--smoke-test', '--test-exit', `--data-dir=${profile}`], timeout: 40000 });
    pid = application.process().pid;
    console.log(`Isolated desktop PID: ${pid}`);
    page = await application.firstWindow();
    await application.evaluate(({ clipboard }) => {
      globalThis.shortcutClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
    });
  } else {
    server = await createServer({ directory: profile, port: 0 });
    try { browser = await chromium.launch({ headless: true }); }
    catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1220, height: 892 } });
    page = await context.newPage(); await page.goto(server.url);
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-nav=notes]').waitFor();
  const call = async (method, input = {}) => desktop
    ? page.evaluate(({ method, input }) => window.desktop.call(method, input), { method, input })
    : server.service.call(method, input);
  const library = await call('librarySave', { title: '快捷键验证' });
  const original = '<h2>快捷键正文</h2><p>第一段<strong>加粗内容</strong></p><p>第二段</p>';
  const note = await call('save', { type: 'note', data: { title: '快捷键笔记', domain: library.id, format: 'html', content: original } });
  await page.reload();
  await page.locator(`[data-record="${note.id}"]`).click();
  const editor = page.locator('.tiptap'); await editor.waitFor();
  const html = () => editor.evaluate(el => el.editor.getHTML());
  const readClipboard = () => desktop ? application.evaluate(({ clipboard }) => clipboard.readText()) : page.evaluate(() => navigator.clipboard.readText());
  const writeClipboard = text => desktop ? application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text) : page.evaluate(value => navigator.clipboard.writeText(value), text);
  const baseline = await html();
  assert.equal(await editor.evaluate(el => {
    el.focus();
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  }), true, 'Empty editor history must not fall back to native DOM undo');
  assert.equal(await html(), baseline);
  await editor.click(); await page.keyboard.press('Control+a');
  assert.match(await page.evaluate(() => window.getSelection().toString()), /快捷键正文[\s\S]*第一段[\s\S]*第二段/);
  await page.keyboard.press('Control+c');
  assert.match(await readClipboard(), /快捷键正文[\s\S]*加粗内容[\s\S]*第二段/);
  console.log('PASS: select all and native copy');
  await editor.evaluate(el => el.editor.commands.focus('end'));
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => document.querySelectorAll('.tiptap strong').length === 2);
  await page.keyboard.press('Control+z');
  assert.equal(await html(), baseline, 'Rich paste preserves formatting and undoes in one step');
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+x');
  assert.equal(await editor.textContent(), '');
  await page.keyboard.press('Control+z'); assert.equal(await html(), baseline);
  await page.keyboard.press('Control+a');
  await writeClipboard('快捷键粘贴验证');
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent === '快捷键粘贴验证');
  await page.keyboard.press('Control+z');
  assert.equal(await html(), baseline, 'Undo restores the entire rich document');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await editor.textContent(), '快捷键粘贴验证');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y');
  assert.equal(await editor.textContent(), '快捷键粘贴验证');
  console.log('PASS: paste, undo and both redo shortcuts');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  assert.match((await call('record', { id: note.id })).data.content, /快捷键粘贴验证/);
  const title = page.locator('#note-title');
  await title.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
  assert.equal(await readClipboard(), '快捷键笔记');
  await writeClipboard('标题粘贴验证'); await page.keyboard.press('Control+v');
  assert.equal(await title.inputValue(), '标题粘贴验证');
  await page.keyboard.press('Control+z');
  assert.equal(await title.inputValue(), '快捷键笔记');
  assert.equal(await editor.textContent(), '快捷键粘贴验证', 'Title shortcuts must not modify note body');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  console.log('PASS: title focus and persisted content');
  for (const type of ['note', 'draft']) {
    const mixed = await call('save', { type, data: { title: `${type}代码快捷键`, domain: library.id, format: 'html',
      content: '<p>代码前</p><pre><code class="language-text">root/\n  child</code></pre><p>代码后</p>' } });
    await page.reload();
    if (type === 'draft') await page.locator('[data-nav=drafts]').click();
    await page.locator(`[data-record="${mixed.id}"]`).click(); await editor.waitFor();
    const mixedHtml = await html();
    await page.locator('.tiptap pre code').click(); await page.keyboard.press('Control+a');
    const selected = await editor.evaluate(el => el.editor.state.doc.textBetween(el.editor.state.selection.from, el.editor.state.selection.to, '\n'));
    assert.match(selected, /代码前[\s\S]*root\/[\s\S]*child[\s\S]*代码后/);
    await writeClipboard('快捷键草稿代码验证'); await page.keyboard.press('Control+v');
    await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent === '快捷键草稿代码验证');
    await page.keyboard.press('Control+z'); assert.equal(await html(), mixedHtml);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
    assert.equal((await call('record', { id: mixed.id })).data.content, mixedHtml);
    console.log(`PASS: ${type} code focus, full selection, undo and save`);
  }
  await page.locator('.editor-shortcuts summary').click();
  assert.equal(await page.locator('.editor-shortcuts[open]').count(), 1);
  await page.screenshot({ path: path.join(root, desktop ? 'desktop.png' : 'browser.png') });
  await page.locator('.editor-shortcuts summary').press('Escape');
  assert.equal(await page.locator('.editor-shortcuts[open]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${desktop ? 'desktop' : 'browser'} edit shortcuts`);
} finally {
  if (application) {
    await application.evaluate(({ clipboard }) => {
      if (/快捷键|标题粘贴验证/.test(clipboard.readText()) && globalThis.shortcutClipboard) {
        clipboard.clear(); for (const [format, bytes] of globalThis.shortcutClipboard) clipboard.writeBuffer(format, bytes);
      }
      delete globalThis.shortcutClipboard;
    }).catch(() => {});
    try { await Promise.race([application.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 8000).unref())]); }
    catch { if (pid && application.process().exitCode === null) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } }
  }
  await browser?.close(); await server?.close();
}
