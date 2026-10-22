import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from '../src/server.mjs';
import { cleanData } from '../src/core/store.mjs';
import { canonical, sha, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/ui-revision-integrity');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ port: 0, directory: fs.mkdtempSync(path.join(root, 'case-')) });
const store = app.service.store, library = store.saveLibrary({ title: '校验测试' });
const content = { schema: 1, id: uuid(), entityId: uuid(), type: 'note', deviceId: store.deviceId, sequence: 2,
  createdAt: new Date().toISOString(), parents: [], deleted: false,
  data: cleanData('note', { title: '旧版记录', domain: library.data.domain, content: '保留原文', format: undefined }) };
const event = JSON.parse(JSON.stringify({ ...content, hash: sha(canonical(content)) }));
store.insert(event, false);
let browser;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1165, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole('button', { name: '多电脑同步', exact: true }).click();
  await page.locator('[data-action="sync-integrity"]').click();
  const result = page.locator('#sync-integrity-result');
  await result.getByText('本机修改记录校验通过', { exact: true }).waitFor();
  assert.match(await result.innerText(), /旧版兼容通过 1 条/);
  assert.deepEqual(store.event(event.id), event);
  const changed = structuredClone(event); changed.data.content = '损坏内容';
  store.db.prepare('UPDATE events SET json=? WHERE id=?').run(JSON.stringify(changed), event.id);
  await page.locator('[data-action="sync-integrity"]').click();
  await result.getByText('1 条记录需要检查', { exact: true }).waitFor();
  assert.match(await result.innerText(), new RegExp(event.id));
  for (const width of [1165, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await result.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `integrity-${width}.png`) });
  }
  assert.deepEqual(store.event(event.id), changed);
  assert.deepEqual(errors, []);
  console.log('PASS: legacy compatibility result, corrupt version identification, read-only diagnostics and responsive screenshots.');
} finally { await browser?.close(); await app.close(); }
