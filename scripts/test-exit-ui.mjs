import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';

const root = path.resolve('artifacts/exit-ui'); fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'profile-'));
const application = await electron.launch({ executablePath: electronPath,
  args: [path.resolve('.'), '--smoke-test', '--test-exit', `--data-dir=${profile}`], timeout: 40000 });
let page;
const closeRequest = () => application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
const screenshot = async name => {
  const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage({}, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(root, name), Buffer.from(png, 'base64'));
};
try {
  page = await application.firstWindow();
  await page.locator('[data-nav=notes]').waitFor();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await assert.rejects(page.evaluate(() => window.desktop.call('exitFinish', { id: 'fake', rendererReady: true })), /退出检查/);
  await closeRequest(); await page.locator('#exit-confirm').waitFor();
  await page.waitForFunction(() => document.querySelector('#exit-confirm')?.textContent === '退出');
  assert.match(await page.locator('#exit-check-status').innerText(), /没有待保存/);
  await closeRequest(); assert.equal(await page.locator('#exit-confirm').count(), 1);
  await screenshot('saved.png');
  await page.locator('#exit-continue').click();
  assert.equal(await page.locator('dialog[open]').count(), 0);

  await page.locator('[data-nav=settings]').click();
  await page.locator('#agent-preferences-form textarea').fill('未保存的整理偏好');
  await closeRequest(); await page.locator('#exit-check-status', { hasText: '整理偏好尚未保存' }).waitFor();
  assert.equal(await page.locator('#exit-confirm').isDisabled(), true);
  await screenshot('preferences.png');
  await page.locator('#exit-continue').click();
  await page.locator('#skill-discard').click();
  await page.getByRole('heading', { name: '撤销未保存修改', exact: true }).waitFor();
  await closeRequest();
  await page.locator('#toast', { hasText: '请先完成或取消当前编辑窗口' }).waitFor();
  assert.equal(await page.locator('#exit-confirm').count(), 0);
  await page.locator('[data-confirm]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();

  const dirtyRecords = await page.evaluate(async () => {
    const a = await window.desktop.call('save', { type: 'note', data: { title: '冲突笔记', content: 'base', domain: 'exit-test' } });
    const b = await window.desktop.call('save', { type: 'draft', data: { title: '待保存草稿', content: 'base', domain: 'exit-test' } });
    const tabs = [a, b].map(note => ({ id: crypto.randomUUID(), recordId: note.id, recordType: note.type, title: note.data.title,
      domain: note.data.domain, dirty: true, baseHeads: note.heads, draft: { ...note.data, content: '<p>本机未保存内容</p>', format: 'html' } }));
    await window.desktop.call('workspaceSave', { tabs, selectedTab: tabs[1].id });
    return { a, b, tabs };
  });
  await page.reload(); await page.locator('.tiptap').waitFor();
  await page.evaluate(async a => window.desktop.call('save', { id: a.id, type: a.type, parents: a.heads, data: { ...a.data, content: 'newer content' } }), dirtyRecords.a);
  const stale = await page.evaluate(a => window.desktop.callResult('save', { id: a.id, type: a.type, parents: a.heads, data: a.data }), dirtyRecords.a);
  assert.equal(stale.error.code, 'CONFLICT');
  await closeRequest(); await page.locator('#exit-confirm', { hasText: '保存后退出' }).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
  await page.waitForFunction(() => innerWidth <= 1000);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await screenshot('pending.png');
  await page.locator('#exit-confirm').click();
  await page.locator('#exit-check-status', { hasText: '待处理冲突' }).waitFor();
  await page.locator('#exit-check-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#exit-confirm').isDisabled(), true);
  assert.equal(await page.getByRole('heading', { name: '保存期间出现新版本', exact: true }).count(), 0);
  const persisted = await page.evaluate(async ({ a, b }) => ({ a: await window.desktop.call('record', { id: a.id }), b: await window.desktop.call('record', { id: b.id }) }), dirtyRecords);
  assert.equal(persisted.a.heads.length, 1); assert.equal(persisted.a.data.content, 'newer content');
  assert.match(persisted.b.data.content, /本机未保存内容/);
  await screenshot('conflict.png');
  await page.locator('#exit-continue').click();
  await page.locator(`[data-close-tab="${dirtyRecords.tabs[0].id}"]`).click();
  await page.locator('[data-confirm]').click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });

  const savedIds = await page.evaluate(async () => {
    const notes = [];
    for (const type of ['note', 'draft']) notes.push(await window.desktop.call('save', { type, data: { title: `退出测试 ${type}`, domain: 'exit-test', content: 'before' } }));
    const tabs = notes.map(note => ({ id: crypto.randomUUID(), recordId: note.id, recordType: note.type, title: note.data.title,
      domain: note.data.domain, dirty: true, baseHeads: note.heads, draft: { ...note.data, content: `<p>saved-on-exit-${note.id}</p>`, format: 'html' } }));
    await window.desktop.call('workspaceSave', { tabs, selectedTab: tabs[0].id });
    return notes.map(note => note.id);
  });
  await page.reload(); await page.locator('.tiptap').waitFor();
  await closeRequest(); await page.locator('#exit-confirm', { hasText: '保存后退出' }).waitFor();
  await page.locator('#exit-sync').click();
  await page.locator('[data-nav=sync].active').waitFor();
  await closeRequest(); await page.locator('#exit-confirm', { hasText: '保存后退出' }).waitFor();
  const closed = page.waitForEvent('close');
  const exited = once(application.process(), 'exit');
  await page.locator('#exit-confirm').click(); await closed;
  await exited;
  const db = new DatabaseSync(path.join(profile, 'knowledge.sqlite'), { readOnly: true });
  try {
    for (const id of savedIds) {
      const row = db.prepare('SELECT e.json FROM events e JOIN heads h ON h.event_id=e.id WHERE e.entity_id=?').get(id);
      assert.match(JSON.parse(row.json).data.content, new RegExp(`saved-on-exit-${id}`));
    }
    const workspace = JSON.parse(db.prepare("SELECT value FROM local_config WHERE key='workspace'").get().value);
    assert.equal(workspace.tabs.some(tab => tab.dirty), false);
  } finally { db.close(); }
  assert.deepEqual(errors, []);
  console.log('PASS: native exit handshake, duplicate close/cancel, preference guard, all-tab note/draft saves, conflict preservation, sync navigation and persisted exit.');
} catch (error) { await screenshot('failure.png').catch(() => {}); throw error; }
finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
}
