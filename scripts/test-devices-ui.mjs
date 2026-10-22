import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { makePairingKey } from '../src/core/transport.mjs';

const root = path.resolve('artifacts/devices-ui'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'case-')), key = makePairingKey();
const a = await createServer({ directory: path.join(directory, 'a'), port: 0 });
const b = await createServer({ directory: path.join(directory, 'b'), port: 0 });
let browser;
const errors = [];
try {
  for (const [index, app] of [a, b].entries()) {
    app.service.store.setMeta('deviceName', '同名电脑'); app.service.transport.announce();
    app.service.transport.configure(path.join(directory, `cloud-${index}`), key);
  }
  const pull = async (from, to) => {
    await from.service.transport.publish();
    const source = from.service.transport.channel(), target = to.service.transport.channel();
    fs.mkdirSync(target.root, { recursive: true });
    for (const name of fs.readdirSync(source.root)) fs.copyFileSync(source.file(name), target.file(name));
    await to.service.transport.importLatest();
  };
  await pull(a, b); await pull(b, a);
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  const devices = async app => { await page.goto(app.url); await page.locator('[data-nav=devices]').click(); await page.locator('.device-table').waitFor(); };
  const confirm = async () => { await page.locator('#modal [data-confirm]').click(); await page.locator('#modal').waitFor({ state: 'hidden' }); };
  await devices(a);
  assert.equal(await page.locator('[data-action=device-rename]').count(), 0);
  await page.getByRole('button', { name: '设本机为主力机', exact: true }).click(); await confirm();
  const other = () => page.locator(`[data-device-row="${b.service.store.deviceId}"]`);
  await other().locator('[data-action=device-rename]').waitFor();
  assert.equal(await page.locator('.device-table small').count(), 2);
  await other().locator('[data-action=device-rename]').click(); await page.locator('#dialog-value').fill('公司电脑'); await confirm();
  await other().getByText('公司电脑', { exact: true }).waitFor();
  await other().locator('[data-action=device-suspend]').click();
  await page.locator('#modal [data-cancel]').click();
  assert.equal(b.service.transport.devices().devices.find(item => item.local).suspended, false);
  await other().locator('[data-action=device-suspend]').click(); await confirm();
  await other().getByText('已停用', { exact: true }).waitFor();
  await pull(a, b); await devices(b);
  assert.equal(await page.locator('[data-action=device-rename]').count(), 0);
  assert.match(await page.locator('#main').innerText(), /本机已停用/);
  await devices(a); await other().locator('[data-action=device-resume]').click(); await confirm();
  await other().getByText('已启用', { exact: true }).waitFor();
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bottom = await page.locator('.settings-section').last().boundingBox(), footer = await page.locator('.statusbar').boundingBox();
    assert.ok(bottom.y + bottom.height <= footer.y + 1);
    await page.screenshot({ path: path.join(root, `devices-${width}.png`) });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await other().locator('[data-action=device-transfer]').click(); await confirm();
  await page.getByRole('button', { name: '取消转移', exact: true }).waitFor();
  assert.equal(a.service.transport.devices().primary, a.service.store.deviceId);
  await page.getByRole('button', { name: '取消转移', exact: true }).click(); await confirm();
  await page.getByRole('button', { name: '取消转移', exact: true }).waitFor({ state: 'hidden' });
  await other().locator('[data-action=device-transfer]').click(); await confirm();
  await page.getByRole('button', { name: '取消转移', exact: true }).waitFor();
  await pull(a, b); await devices(b);
  await page.getByRole('button', { name: '校验并接受主力机转移', exact: true }).click(); await confirm();
  await page.locator('[data-action=device-rename]').first().waitFor();
  assert.equal(b.service.transport.devices().primary, b.service.store.deviceId);
  await pull(b, a); await devices(a);
  assert.equal(await page.locator('[data-action=device-rename]').count(), 0);
  assert.equal(await page.locator('[data-action=device-primary]').count(), 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors }, null, 2));
  console.log('PASS: primary-only device management, rename, cancel, suspend/resume, target acceptance and responsive layout');
} catch (error) {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: false, error: error.stack, errors }, null, 2)); throw error;
} finally { await browser?.close(); await a.close(); await b.close(); }
