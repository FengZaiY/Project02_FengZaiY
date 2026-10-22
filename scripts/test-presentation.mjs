import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { presentationFixture } from './fixtures/presentation.mjs';
import { call as client } from '../skills/studyself-organize/scripts/client.mjs';
import { uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/presentation-ui'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser;
const errors = [], requests = [];
try {
  const library = app.service.store.saveLibrary({ title: '交互笔记验证' });
  const data = { title: '线性关系 · 交互实验', domain: library.data.domain, format: 'html', content: '<h2>线性关系</h2><p>输入每增加一个单位，输出增加固定的量。</p>' };
  const note = app.service.store.write({ type: 'note', data });
  const grant = app.service.agents.createGrant({ name: '交互验证 Agent', domains: [data.domain], edit: true });
  await app.service.agents.configure(true);
  const env = { STUDYSELF_AGENT_URL: app.service.agents.status().url, STUDYSELF_AGENT_TOKEN: grant.token };
  const rpc = (method, input) => client(method, { preferencesVersion: app.service.agents.preferences().version, ...input }, uuid(), env);
  const proposal = await rpc('propose', { title: '增加交互实验', domain: data.domain, items: [
    { targetId: note.id, parents: note.heads, data: { ...data, presentation: presentationFixture(data) }, reason: '用参数实验帮助理解线性关系，保留原知识正文。' },
    { data: { ...data, title: '稍后确认的笔记' } }
  ] });
  const broken = app.service.store.write({ type: 'note', data: { ...data, title: '运行保护', presentation: presentationFixture(data, { script: 'while(true){}' }) } });
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.copiedDesignRequest = text; }
    } });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(app.url)) requests.push(request.url()); });
  page.on('console', message => { if (message.type() === 'error') console.log(message.text()); });
  await page.goto(app.url);
  await page.locator(`[data-record="${note.id}"]`).click();
  const modeBar = page.getByRole('group', { name: '笔记呈现方式' });
  assert.equal(await modeBar.getByRole('button', { name: '交互阅读', exact: true }).isDisabled(), true);
  assert.equal(await modeBar.getByRole('button', { name: '正文编辑', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('iframe.interactive-page').count(), 0);
  await page.locator('.tiptap').evaluate(el => { window.plainEditor = el.editor; });
  await modeBar.getByRole('button', { name: '复制设计请求', exact: true }).click();
  await page.getByText('设计请求已复制，请交给已连接的外部 Agent', { exact: true }).waitFor();
  const request = await page.evaluate(() => window.copiedDesignRequest);
  for (const value of [note.id, note.heads[0], data.domain, 'presentation v1', '等待我预览确认']) assert.ok(request.includes(value));
  assert.ok(!request.includes(data.content));
  assert.deepEqual(app.service.store.get(note.id).heads, note.heads);
  await modeBar.getByRole('button', { name: '正文编辑', exact: true }).click();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor === window.plainEditor), true);
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.getByText('交互页面尚未生成', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const boxes = await modeBar.locator('button,.page-state').evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    for (const [index, box] of boxes.entries()) {
      assert.ok(box.left >= 0 && box.right <= width + 1);
      for (const other of boxes.slice(index + 1)) assert.ok(box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top);
    }
    await page.screenshot({ path: path.join(root, `entry-${width}.png`) });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.locator('[data-nav=proposals]').click(); await page.locator(`[data-record="${proposal.id}"]`).click();
  await page.getByRole('button', { name: '预览交互页面', exact: true }).click();
  await page.frameLocator('#modal iframe.interactive-page').locator('#chart svg').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(app.service.store.get(note.id).data.presentation, undefined);
  await page.locator('[data-proposal-item]').first().check(); await page.locator('[data-action=approve]').click();
  await page.waitForFunction(() => document.querySelector('[data-proposal-item]')?.disabled === true);
  assert.equal(app.service.store.get(proposal.id).data.items[1].status, 'pending');
  await page.locator('[data-nav=notes]').click(); await page.locator(`[data-record="${note.id}"]`).click();
  const frame = () => page.frameLocator('iframe.interactive-page');
  await frame().locator('#chart svg').waitFor({ timeout: 20000 });
  assert.ok(await frame().locator('#chart svg path').count() > 5);
  await frame().locator('#rate').focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  try { await page.waitForFunction(() => document.querySelector('iframe.interactive-page')?.contentDocument?.querySelector('#result')?.textContent === '7', null, { timeout: 6000 }); }
  catch (error) { console.log(await page.locator('.presentation-host').innerText(), await frame().locator('#rate').inputValue(), await frame().locator('#result').innerText()); throw error; }
  await frame().getByRole('button', { name: '参数实验' }).click();
  await frame().locator('#intro').waitFor({ state: 'hidden' });
  assert.equal(await frame().locator('#intro').isVisible(), false);
  await frame().getByRole('button', { name: '逐步演示' }).click();
  await frame().getByText('第 5 步', { exact: true }).waitFor();
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await frame().locator('body').evaluate(el => el.ownerDocument.scrollingElement.scrollTop = 0);
    assert.equal(await page.locator('.editor-surface').isVisible(), false);
    assert.ok((await page.locator('iframe.interactive-page').boundingBox()).height > 350);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(root, `page-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const content = await page.locator('iframe.interactive-page').contentFrame();
    assert.equal(await content.locator('body').evaluate(el => el.scrollWidth > el.ownerDocument.documentElement.clientWidth + 1), false);
    await frame().locator('#bottom').scrollIntoViewIfNeeded(); assert.equal(await frame().locator('#bottom').isVisible(), true);
    await frame().locator('#chart').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    assert.ok(await frame().locator('#chart svg path').count() > 5, `Chart became blank at ${width}`);
    await page.screenshot({ path: path.join(root, `chart-${width}.png`) });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.getByRole('button', { name: '正文编辑', exact: true }).click();
  await page.locator('.tiptap').evaluate(el => { window.editorBeforeMode = el.editor; });
  await page.getByRole('button', { name: '交互阅读', exact: true }).click();
  await frame().locator('#chart svg').waitFor();
  await page.getByRole('button', { name: '正文编辑', exact: true }).click();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor === window.editorBeforeMode), true);
  await page.locator('.tiptap p').click(); await page.keyboard.press('End'); await page.keyboard.type(' updated');
  await page.getByText('页面待更新 · 正文已有新修改').waitFor();
  await page.getByRole('button', { name: '查看上次页面', exact: true }).click();
  await frame().locator('#chart svg').waitFor();
  await page.getByRole('button', { name: '正文编辑', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await page.locator('.tiptap').innerText(), '线性关系\n\n输入每增加一个单位，输出增加固定的量。');
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await page.locator('.history-page-change').waitFor(); await page.getByRole('button', { name: '关闭', exact: true }).click();
  const current = app.service.store.get(note.id);
  const source = await rpc('draftCreate', { data: { ...data, title: '新增实验结论', content: '需要观察更大的系数范围' } });
  const revisedData = { ...current.data, content: current.data.content + '<p>新增资料：比较不同系数。</p>' };
  revisedData.presentation = presentationFixture(revisedData);
  revisedData.presentation.basis.sources = [{ id: source.id, versionId: source.heads[0] }];
  const revision = await rpc('propose', { title: '更新知识与页面', domain: data.domain, items: [{ targetId: note.id, parents: current.heads, draftRefs: [{ id: source.id, versionId: source.heads[0], complete: true }], data: revisedData }] });
  assert.deepEqual(app.service.store.get(note.id).heads, current.heads);
  await page.locator('[data-nav=proposals]').click(); await page.locator(`[data-record="${revision.id}"]`).click();
  await page.locator('[data-proposal-item]').check(); await page.locator('[data-action=approve]').click();
  await page.waitForFunction(() => document.querySelector('[data-proposal-item]')?.disabled === true);
  await page.locator('[data-nav=notes]').click(); await page.locator(`[data-record="${note.id}"]`).click();
  await frame().locator('#chart svg').waitFor();
  assert.equal(await page.getByRole('button', { name: '交互阅读', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByText('交互已停止', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重新运行', exact: true }).click(); await frame().locator('#chart svg').waitFor();
  await page.locator(`[data-record="${broken.id}"]`).click();
  await page.getByText(/交互已停止/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '正文编辑', exact: true }).click(); assert.equal(await page.locator('.tiptap').isVisible(), true);
  const mediaPath = path.join(root, 'page-image.png');
  fs.writeFileSync(mediaPath, Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#277d65'; ctx.fillRect(0,0,80,40); return canvas.toDataURL().split(',')[1]; }), 'base64'));
  const asset = await app.service.call('assetImport', { path: mediaPath, domain: data.domain });
  const supportPage = presentationFixture(data, { assetIds: [asset.id], noteIds: [note.id],
    html: `<div id="formula"></div><div id="diagram"></div><img data-asset-id="${asset.id}" alt="页面图片"><button data-note-id="${note.id}">前往实验笔记</button><p id="motion">动画步骤</p>`,
    script: "page.formula('formula','E=mc^2'); page.diagram('diagram','flowchart LR\\n A[Input] --> B[Output]'); page.animate('motion',[{opacity:0.2},{opacity:1}],{duration:1000,iterations:100});" });
  const support = app.service.store.write({ type: 'note', data: { ...data, title: '公式与附件', presentation: supportPage } });
  await page.reload(); await page.locator(`[data-record="${support.id}"]`).click();
  await frame().locator('#formula .katex').waitFor(); await frame().locator('#diagram svg').waitFor();
  assert.match(await frame().locator('.katex').evaluate(el => getComputedStyle(el).fontFamily), /KaTeX/);
  await frame().locator('img').evaluate(el => new Promise((resolve, reject) => { if (el.naturalWidth === 80) resolve(); else { el.onload = resolve; el.onerror = reject; } }));
  await page.screenshot({ path: path.join(root, 'formula-diagram-media.png') });
  assert.equal(await frame().locator('#motion').evaluate(el => el.getAnimations().length), 1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  assert.equal(await frame().locator('#motion').evaluate(el => el.getAnimations().length), 0);
  if (await page.locator('[data-action=toggle-source]').getAttribute('aria-expanded') !== 'true') await page.locator('[data-action=toggle-source]').click();
  await page.locator(`[data-preview-asset="${asset.id}"]`).click();
  await page.locator('#source-preview img').waitFor();
  await page.locator('#source-preview img').evaluate(el => { window.originalPagePreview = el; });
  await page.getByRole('button', { name: '正文编辑', exact: true }).click();
  await page.getByRole('button', { name: '交互阅读', exact: true }).click();
  assert.equal(await page.locator('#source-preview img').evaluate(el => el === window.originalPagePreview), true);
  await frame().getByRole('button', { name: '前往实验笔记', exact: true }).click();
  await frame().locator('#chart svg').waitFor();
  app.service.store.bindAsset(asset.id, path.join(root, 'missing-image.png'));
  await page.reload(); await page.locator(`[data-record="${support.id}"]`).click();
  await frame().getByText('附件暂不可用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '正文编辑', exact: true }).click();
  assert.equal(await page.locator('.tiptap').isVisible(), true);
  const attacks = [
    ['guest-globals', "page.text('steps',[typeof window,typeof document,typeof fetch,typeof process,typeof postMessage,typeof Worker].join(','));", 'undefined,undefined,undefined,undefined,undefined,undefined'],
    ['forged-message', "__emit(JSON.stringify({op:'rpc',id:'steps',value:{method:'delete'}}));", null],
    ['dynamic-html', "page.html('steps','<img src=\"https://example.invalid/leak\">');", null],
    ['command-flood', "for(let i=0;i<201;i++)page.text('steps',String(i));", null],
    ['heap-limit', "let a=[];while(true)a.push('x'.repeat(1000000));", null],
    ['callback-loop', "page.on('step','click',()=>{while(true){}});", 'callback'],
    ['async-late-result', "page.diagram('steps','flowchart LR\\n A --> B'); page.text('steps','最新内容');", '最新内容']
  ];
  for (const [title, script, result] of attacks) {
    const candidate = app.service.store.write({ type: 'note', data: { ...data, title, presentation: presentationFixture(data, { script }) } });
    await page.reload(); await page.locator(`[data-record="${candidate.id}"]`).click();
    if (result === 'callback') {
      await page.locator('.page-runtime-bar [role=status]', { hasText: '交互运行中' }).waitFor();
      await frame().getByRole('button', { name: '逐步演示' }).click();
      await page.locator('.page-state', { hasText: '交互运行失败' }).waitFor({ timeout: 10000 });
    } else if (result) {
      await frame().getByText(result, { exact: true }).waitFor();
      if (title === 'async-late-result') { await page.waitForTimeout(500); assert.equal(await frame().locator('#steps').innerText(), result); }
    }
    else await page.locator('.page-state', { hasText: '交互运行失败' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '正文编辑', exact: true }).click(); assert.equal(await page.locator('.tiptap').isVisible(), true);
  }
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, requests }, null, 2));
  console.log('PASS: interactive page, chart, events, timers, edit/undo, stale body, runtime timeout, responsive layout');
} catch (error) {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: false, error: error.stack, errors, requests }, null, 2)); throw error;
} finally { await browser?.close(); await app.close(); }
