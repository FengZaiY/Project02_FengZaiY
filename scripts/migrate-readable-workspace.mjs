// Explicit maintenance command; uses the same trusted UI operations and exit handshake as the desktop.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, chromium } from 'playwright';
import electronPath from 'electron';
import { databasePath, layoutState } from '../src/core/workspace-layout.mjs';
import { canonical, sha } from '../src/core/util.mjs';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const workspace = path.resolve(argument('workspace') || ''), output = path.resolve(argument('report') || 'artifacts/readable-workspace-migration.json');
assert.ok(argument('workspace') && process.argv.includes('--confirmed'), 'Provide the reviewed workspace and --confirmed; close the installed app first.');
assert.ok(fs.existsSync(databasePath(workspace)), 'Existing database required');
function snapshot() {
  const db = new DatabaseSync(databasePath(workspace), { readOnly: true });
  try {
    return {
      deviceId: db.prepare("SELECT value FROM meta WHERE key='deviceId'").get().value,
      revisions: db.prepare('SELECT count(*) AS n FROM events').get().n,
      eventDigest: sha(canonical(db.prepare('SELECT id,json FROM events ORDER BY id').all())),
      headsDigest: sha(canonical(db.prepare('SELECT entity_id,event_id FROM heads ORDER BY entity_id,event_id').all())),
      credentialsDigest: sha(canonical(db.prepare("SELECT key,value FROM local_config WHERE key LIKE 'secret:%' ORDER BY key").all())),
      assetCount: db.prepare('SELECT count(*) AS n FROM assets').get().n
    };
  } finally { db.close(); }
}
const report = process.argv.includes('--resume') && fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8'))
  : { startedAt: new Date().toISOString(), workspace, before: snapshot(), state: 'starting' };
if (report.error) { report.previousError = report.error; delete report.error; }
let attachPort = argument('attach-port');
function save() { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
async function launch() {
  const browser = attachPort ? await chromium.connectOverCDP(`http://127.0.0.1:${Number(attachPort)}`) : null; attachPort = null;
  const application = browser || await electron.launch({ executablePath: electronPath, args: [path.resolve('.')], timeout: 60000 });
  const page = browser ? browser.contexts()[0].pages()[0] : await application.firstWindow();
  await page.waitForSelector('[data-nav=assets]', { timeout: 60000 });
  const state = await page.evaluate(() => window.desktop.call('state'));
  assert.equal(path.resolve(state.localDataDirectory).toLowerCase(), workspace.toLowerCase(), 'Desktop anchor points to another workspace');
  assert.equal(state.workspace.tabs.some(tab => tab.dirty), false, 'Unsaved edits must be handled by the user');
  return { application, page };
}
async function exit(application, page) {
  const closed = application.waitForEvent(application.evaluate ? 'close' : 'disconnected', { timeout: 60000 });
  if (application.evaluate) await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  else await page.evaluate(() => window.close());
  const state = await Promise.race([closed.then(() => 'closed'), page.locator('#exit-confirm').waitFor({ timeout: 60000 }).then(() => 'confirm').catch(() => 'closed')]);
  if (state === 'closed') { await closed; return; }
  assert.equal(await page.locator('#exit-confirm').isDisabled(), false, 'Exit is blocked by unsaved work');
  await page.locator('#exit-confirm').click(); await closed;
}
try {
  let { application, page } = await launch();
  await page.locator('[data-nav=assets]').click();
  await page.waitForFunction(async () => (await window.desktop.call('materialMigrationStatus'))?.state !== 'running', undefined, { timeout: 600000 });
  report.preview = await page.evaluate(() => window.desktop.call('materialMigrationPreview')); report.state = 'previewed'; save();
  if (report.preview.rows.some(row => !row.issue)) {
    report.migration = await page.evaluate(token => window.desktop.call('materialMigrate', { token, confirmed: true }), report.preview.token);
  } else report.migration = await page.evaluate(() => window.desktop.call('materialMigrationStatus'));
  // Finish projections before taking the content invariants and arranging the closed-database move.
  await page.waitForFunction(async () => !(await window.desktop.call('localHierarchyStatus')).busy);
  report.projection = await page.evaluate(() => window.desktop.call('localHierarchyRefresh'));
  report.afterOriginals = snapshot(); assert.deepEqual(report.afterOriginals, report.before, 'Business records changed during maintenance');
  if (layoutState(workspace)?.state !== 'complete') {
    await page.locator('[data-nav=settings]').click();
    await page.locator('[data-action=storage-internal]').click();
    await page.getByRole('button', { name: '安排重启迁移', exact: true }).click();
    await page.waitForFunction(async () => (await window.desktop.call('storageInternalPreview')).state === 'pending');
    report.state = 'restart-scheduled'; save();
    await exit(application, page);
    ({ application, page } = await launch());
  }
  report.layout = await page.evaluate(() => window.desktop.call('storageInternalPreview'));
  report.after = snapshot(); assert.deepEqual(report.after, report.before, 'Content/credential invariants changed after restart');
  report.remaining = await page.evaluate(() => window.desktop.call('materialMigrationPreview'));
  report.cleanup = await page.evaluate(() => window.desktop.call('materialCleanupPreview'));
  report.state = report.remaining.rows.some(row => row.issue) || report.projection.errors?.length ? 'needs-attention' : 'complete';
  report.completedAt = new Date().toISOString(); save();
  await exit(application, page);
  console.log(JSON.stringify({ state: report.state, revisions: report.after.revisions, assets: report.after.assetCount,
    migrated: report.migration?.done.length || 0, remaining: report.remaining.rows.length, layout: report.layout.state,
    projectionErrors: report.projection.errors?.length || 0, oldCopiesRetained: report.cleanup.rows.length, report: output }));
} catch (error) {
  report.state = 'stopped'; report.error = error.message; save(); console.error(error); process.exitCode = 1;
}
