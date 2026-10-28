import { chromium, _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const desktop = process.argv.includes('--desktop');
const root = path.resolve('artifacts/code-paste'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, desktop ? 'desktop-' : 'browser-'));
let app, browser, application, page;
try {
  if (desktop) {
    application = await electron.launch({ executablePath: electronPath, args: [path.resolve('.'), '--smoke-test', `--data-dir=${directory}`], timeout: 40000 });
    application.process().once('exit', code => console.log(`Isolated Electron exit: ${code}`));
    page = await application.firstWindow();
    await application.evaluate(({ clipboard }) => { globalThis.codePasteClipboard = clipboard.availableFormats().map(type => [type, clipboard.readBuffer(type)]); });
  } else {
    app = await createServer({ directory, port: 0 });
    try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
    page = await browser.newPage({ viewport: { width: 1220, height: 892 } }); await page.goto(app.url);
  }
  await page.locator('[data-nav=notes]').waitFor();
  const call = (method, input = {}) => desktop ? page.evaluate(({ method, input }) => window.desktop.call(method, input), { method, input }) : app.service.call(method, input);
  const library = await call('librarySave', { title: '隔离粘贴验证' });
  const note = await call('save', { type: 'note', data: { title: '外部代码粘贴', domain: library.id, format: 'html', content: '<p>保留的正文</p><p></p>' } });
  await page.reload(); await page.locator(`[data-record="${note.id}"]`).click(); await page.locator('.tiptap').waitFor();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const editor = page.locator('.tiptap');
  const reset = async () => {
    await editor.evaluate(el => { el.editor.commands.setContent('<p>保留的正文</p><p></p>'); el.editor.commands.focus('end'); });
    await page.waitForTimeout(600);
  };
  const paste = async (text, html = '') => {
    if (desktop) {
      await application.evaluate(({ clipboard }, content) => {
        clipboard.write(content);
        globalThis.codePasteCurrent = clipboard.availableFormats().map(type => [type, clipboard.readBuffer(type)]);
        return true;
      }, { text, ...(html ? { html } : {}) });
      await editor.evaluate(el => el.editor.commands.focus('end'));
      await page.keyboard.press('Control+v');
    } else await editor.evaluate((el, { text, html }) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
      if (html) clipboardData.setData('text/html', html);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, { text, html });
  };
  const tree = '工作区/\n├─ 资料/\n│\t└─ 合同.txt\n└─ 笔记/';
  await reset(); await paste(tree);
  await page.locator('.code-surface code').waitFor();
  assert.equal(await page.locator('.code-surface code').textContent(), tree);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('.code-surface').count(), 0);
  assert.match(await editor.textContent(), /保留的正文/);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await page.locator('.code-surface code').textContent(), tree);
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  await page.reload(); await page.locator('.code-surface').waitFor();
  assert.equal(await page.locator('.code-surface code').textContent(), tree);
  await reset(); await paste(tree, `<div>${tree.replaceAll('\n', '<br>')}</div>`);
  assert.equal(await page.locator('.code-surface code').textContent(), tree);
  await reset(); await paste('说明\n\n```python\n  print("ok")\n```\n\n结束');
  assert.equal(await page.locator('.code-surface code').textContent(), '  print("ok")\n');
  assert.equal(await page.getByLabel('代码语言', { exact: true }).inputValue(), 'python');
  assert.match(await editor.textContent(), /结束/);
  const text = 'root/\n  one\n    two';
  await reset(); await paste(text, '<p><strong>说明</strong></p><pre><code class="language-text"><span>root/</span><br>  one\n    two</code><button>复制</button></pre><p>结尾</p>');
  assert.equal(await page.locator('.code-surface code').textContent(), text);
  assert.equal(await page.locator('.tiptap strong').textContent(), '说明');
  await reset(); await paste(text, '<div style="white-space: pre-wrap"><div>root/</div><div>  one</div><div>    two</div></div>');
  assert.equal(await page.locator('.code-surface code').textContent(), text);
  await reset(); await paste('普通代码', '<p>正文 <code>inline()</code></p><p><strong>加粗</strong></p><table><tr><td>单元格</td></tr></table>');
  assert.equal(await page.locator('.code-surface').count(), 0);
  assert.equal(await page.locator('.tiptap strong').textContent(), '加粗');
  assert.equal(await page.locator('.tiptap td').textContent(), '单元格');
  await reset(); await paste('姓名\t分数\n甲\t80');
  assert.equal(await page.locator('.tiptap td').count(), 4);
  assert.equal(await page.locator('.code-surface').count(), 0);
  await reset(); await paste('```html\n<script>window.pasteRan=true</script>\n```');
  assert.equal(await page.evaluate(() => window.pasteRan), undefined);
  assert.match(await page.locator('.code-surface code').textContent(), /<script>/);
  await reset(); await paste(tree);
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `${desktop ? 'desktop' : 'browser'}-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  console.log(`PASS: ${desktop ? 'native Electron Ctrl+V' : 'browser clipboard events'} plain trees, wrappers, fences, HTML pre/styles, undo, persistence, rich text/TSV and inert code.`);
} finally {
  if (application) {
    await application.evaluate(({ clipboard }) => {
      const types = clipboard.availableFormats(), expected = globalThis.codePasteCurrent;
      if (globalThis.codePasteClipboard && expected && types.length === expected.length
        && expected.every(([type, buffer]) => types.includes(type) && clipboard.readBuffer(type).equals(buffer))) {
        clipboard.clear(); for (const [type, buffer] of globalThis.codePasteClipboard) clipboard.writeBuffer(type, buffer);
      }
    }).catch(() => {});
    await application.close();
  }
  await browser?.close(); await app?.close();
}
