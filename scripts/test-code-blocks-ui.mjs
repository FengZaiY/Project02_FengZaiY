import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/ui-code-blocks');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const tree = '工作区/\n├─ 资料/\n│  └─ 装修/\n│     ├─ 01_封面.jpg\n│     └─ 合同模板.docx\n│\n├─ 装修知识库/\n│  └─ 合同审核/\n│     ├─ 正文.md\n│     └─ 付款条款/\n│        └─ 正文.md\n└─ 导出/\n\n\t保留制表符  和连续空格\n<script>window.codeExecuted = true</script>\n' + 'long_line_'.repeat(35);
let browser;
try {
  const library = app.service.store.saveLibrary({ title: '隔离代码块验证' });
  const note = app.service.store.write({ type: 'note', data: { title: '目录树与纯文本', domain: library.data.domain, format: 'html', content: '<p></p>' } });
  const markdown = app.service.store.write({ type: 'note', data: { title: 'Markdown 围栏代码块', domain: library.data.domain, content: '```text\n' + tree + '\n```' } });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedCode = text; } }));
  await page.goto(app.url);
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('.tiptap').waitFor();
  await page.locator('.tiptap').click();
  await page.locator('#insert-content').selectOption('code');
  await page.locator('.code-surface').waitFor();
  assert.equal(await page.getByLabel('代码语言', { exact: true }).inputValue(), '');
  await page.locator('.tiptap').evaluate((el, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, tree);
  const code = page.locator('.code-surface code');
  assert.equal(await code.textContent(), tree);
  assert.equal(await page.locator('.tiptap table').count(), 0);
  assert.equal(await page.evaluate(() => window.codeExecuted), undefined);
  await page.waitForTimeout(600);
  await page.locator('.tiptap').evaluate(el => el.editor.commands.setTextSelection(1));
  await page.keyboard.press('Tab');
  assert.equal(await code.textContent(), '  ' + tree);
  await page.keyboard.press('Control+z');
  assert.equal(await code.textContent(), tree);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await code.textContent(), '  ' + tree);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await code.textContent(), tree);
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedCode), tree);
  assert.equal(await page.locator('.code-copy-status').textContent(), '已复制');
  await page.getByLabel('代码语言', { exact: true }).selectOption('markdown');
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  const stored = app.service.store.get(note.id).data.content;
  assert.match(stored, /<pre><code class="language-markdown">/);
  assert.match(stored, /&lt;script&gt;/);
  assert.ok(!stored.includes('code-tools'), 'Editor controls must not become note content');
  await page.reload(); await page.locator('.code-surface').waitFor();
  assert.equal(await code.textContent(), tree);
  assert.equal(await page.getByLabel('代码语言', { exact: true }).inputValue(), 'markdown');
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const dimensions = await page.locator('.code-surface pre').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(dimensions.scroll > dimensions.client, 'Long lines scroll inside the block');
    await page.locator('.editor-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, `code-${width}.png`) });
    await page.getByRole('button', { name: '代码自动换行', exact: true }).click();
    assert.equal(await code.evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
    assert.equal(await code.textContent(), tree);
    await page.getByRole('button', { name: '代码自动换行', exact: true }).click();
    await page.locator('.editor-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    assert.ok(await page.locator('.editor-scroll').evaluate(el => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 3));
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.locator(`[data-record="${markdown.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === 'Markdown 围栏代码块');
  // The Markdown renderer terminates fenced code with a newline before </code>.
  assert.equal(await code.textContent(), tree + '\n');
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedCode), tree + '\n');
  assert.deepEqual(errors, []);
  console.log('PASS: menu insertion, directory tree paste, spaces/tabs, indentation/undo, copy, language persistence, safe HTML, Markdown fences and 1220/931/600 scrolling.');
} finally { await browser?.close(); await app.close(); }
