import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { encodeBlock } from '../src/core/rich-schema.mjs';

const root = path.resolve('artifacts/horizontal-drag'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser, page; const errors = [], measurements = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#dcecfb'; ctx.fillRect(0, 0, 180, 320);
    ctx.fillStyle = '#398aa4'; ctx.fillRect(20, 25, 140, 140);
    ctx.fillStyle = '#daa348'; ctx.fillRect(20, 190, 140, 100);
    return Array.from(Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0)));
  });
  const file = path.join(root, 'portrait.png'); fs.writeFileSync(file, Buffer.from(bytes));
  const library = app.service.store.saveLibrary({ title: '横向排列验证' });
  const asset = await app.service.call('assetImport', { path: file, domain: library.id });
  const mapPayload = { v: 1, kind: 'diagram', label: '思维导图', source: 'mindmap\n  root((学习主题))\n    基础概念\n      定义\n      示例\n    实践\n      步骤\n      问题' };
  const imagePayload = { v: 1, kind: 'image', label: '竖图素材', assetId: asset.id };
  const figure = (payload, width, align = 'left') => `<figure data-ss-block="${encodeBlock(payload).replaceAll('"', '&quot;')}" data-ss-layout='${JSON.stringify({ width, height: null, align })}'><figcaption>${payload.label}</figcaption></figure>`;
  const fixtures = [
    { name: '右侧空白并排', side: 'right', align: 'left' },
    { name: '左侧空白并排', side: 'left', align: 'right' },
    { name: '引用内并排', side: 'right', align: 'left', nested: true },
    { name: '较宽素材并排', side: 'right', align: 'left', wide: true }
  ];
  const records = fixtures.map(f => {
    const map = figure(mapPayload, f.wide ? 70 : 40, f.align), image = figure(imagePayload, f.wide ? 70 : 30);
    return app.service.store.write({ type: 'note', data: { title: f.name, domain: library.id, assetIds: [asset.id], format: 'html',
      content: `<p>前文保留</p>${f.nested ? `<blockquote><p>引用正文</p>${map}</blockquote>` : map}<p>相邻文字不能丢失</p>${image}<p>后文保留</p>` } });
  });
  await page.reload();
  const body = page.locator('.tiptap'), map = body.locator('[data-block-kind=diagram]'), image = body.locator('[data-block-kind=image]');
  const html = () => body.evaluate(el => el.editor.getHTML());
  const text = () => body.evaluate(el => el.editor.state.doc.textContent);
  const save = async () => {
    await page.locator('[data-action=save]').click();
    await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  };
  const ready = () => page.waitForFunction(() => document.querySelectorAll('.tiptap .block-aspect-media').length === 2
    && document.querySelector('.tiptap img')?.naturalWidth > 0);
  const hold = async locator => {
    await locator.scrollIntoViewIfNeeded(); const rect = await locator.boundingBox();
    const area = await page.locator('.editor-scroll').boundingBox();
    await page.mouse.move(rect.x + rect.width * .4, Math.max(area.y + 20, Math.min(area.y + area.height - 40, rect.y + rect.height * .5)));
    await page.mouse.down(); await page.locator('.block-drag-preview').waitFor();
  };
  const beside = async side => {
    await hold(image); await map.scrollIntoViewIfNeeded();
    const box = await map.boundingBox();
    const x = side === 'right' ? box.x + box.width + 30 : box.x - 30;
    const y = box.y + box.height / 2;
    assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.rich-block'), { x, y }), false,
      'Regression target must be empty space outside the media');
    await page.mouse.move(x, y, { steps: 10 });
    await page.locator(`.block-drop-marker[data-drop-side="${side}"]:not([hidden])`).waitFor();
    const marker = await page.locator('.block-drop-marker').boundingBox();
    assert.equal(marker.width, 3); assert.ok(marker.height >= 36);
    return { x, y };
  };
  const rowFits = async (side, label) => {
    const a = await map.boundingBox(), b = await image.boundingBox(), row = await body.locator('.block-row').boundingBox();
    assert.ok(Math.abs(a.y - b.y) < 2, label + ': intentional row must stay horizontal');
    assert.ok(side === 'right' ? b.x >= a.x + a.width + 10 : a.x >= b.x + b.width + 10, label + ': ordered without overlap');
    for (const box of [a, b]) assert.ok(box.x >= row.x - 1 && box.x + box.width <= row.x + row.width + 1, label + ': within row');
    for (const locator of [map, image]) {
      const ratio = await locator.evaluate(el => {
        const media = el.querySelector('.rich-content > svg,.rich-content > img'), rect = media.getBoundingClientRect();
        return { actual: rect.width / rect.height, expected: media.viewBox ? media.viewBox.baseVal.width / media.viewBox.baseVal.height : media.naturalWidth / media.naturalHeight };
      });
      assert.ok(Math.abs(ratio.actual - ratio.expected) < .02, label + ': proportions retained');
    }
    measurements.push({ label, row: row.width, map: a, image: b });
  };
  for (const [index, fixture] of fixtures.entries()) {
    await page.setViewportSize({ width: 1220, height: 892 });
    await page.locator(`[data-record="${records[index].id}"]`).click(); await ready();
    if (await page.locator('[data-action=toggle-source]').getAttribute('aria-expanded') !== 'true')
      await page.getByRole('button', { name: '原附件', exact: true }).click();
    const original = await html(), originalText = await text();
    const originalLayout = await body.locator('.rich-block').evaluateAll(nodes => nodes.map(el => el.dataset.ssLayout));
    if (!fixture.wide) assert.ok((await map.boundingBox()).height < 80, 'Small map reproduces narrow drop target');
    await beside(fixture.side);
    if (index === 0) {
      await page.screenshot({ path: path.join(root, 'right-drop-marker.png') });
      await page.keyboard.press('Escape'); await page.mouse.up();
      assert.equal(await html(), original);
      await beside(fixture.side);
    }
    await page.mouse.up(); await body.locator('.block-row').waitFor();
    assert.equal(await text(), originalText);
    assert.equal(await body.locator('.block-row > .rich-block').count(), 2);
    if (fixture.nested) assert.equal(await body.locator('blockquote > .block-row').count(), 1);
    await rowFits(fixture.side, fixture.name);
    assert.deepEqual(await body.locator('.rich-block').evaluateAll(nodes => nodes.map(el => el.dataset.ssLayout).sort()), [...originalLayout].sort());
    const moved = await html();
    await body.press('Control+z'); assert.equal(await html(), original, 'Join must undo in one step');
    await body.press('Control+Shift+z'); assert.equal(await html(), moved);
    // A row can still be reordered and extracted vertically through the existing edge targets.
    if (index === 0) {
      await hold(image); let box = await map.boundingBox();
      await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
      await rowFits('left', '横排内调整顺序');
      await body.press('Control+z'); assert.equal(await html(), moved);
      await hold(image); box = await map.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2, { steps: 6 }); await page.mouse.up();
      assert.equal(await body.locator('.block-row').count(), 0);
      await body.press('Control+z'); assert.equal(await html(), moved);
      const handle = image.locator('[data-resize-edge=e]'); await handle.scrollIntoViewIfNeeded();
      box = await handle.boundingBox(); const before = await image.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
      assert.ok((await image.boundingBox()).width > before.width + 15);
      await rowFits('right', '并排后缩放');
      await body.press('Control+z'); assert.equal(await html(), moved);
    }
    await save(); const saved = await html();
    await page.reload(); await ready(); assert.equal(await html(), saved);
    assert.deepEqual(await map.evaluate(el => JSON.parse(el.dataset.ssBlock)), mapPayload);
    assert.deepEqual(await image.evaluate(el => JSON.parse(el.dataset.ssBlock)), imagePayload);
    for (const width of [1220, 931, 600]) {
      await page.setViewportSize({ width, height: 892 }); await map.scrollIntoViewIfNeeded();
      await rowFits(fixture.side, `${fixture.name}-${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (index === 0) await page.screenshot({ path: path.join(root, `horizontal-${width}.png`) });
    }
  }
  assert.ok(measurements.some(m => m.row < 360), 'Verify the previously forced-vertical narrow layout');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, measurements, errors }, null, 2));
  console.log('PASS: left/right whitespace drop targets, small map with portrait and source panel, nested rows, narrow rows, shrink/proportions, resize, reorder/extract, cancel, undo and save/reopen.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser?.close(); await app.close(); }
