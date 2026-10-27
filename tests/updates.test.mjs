import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateManager, assertUpdateIdle } from '../src/desktop/updates.mjs';
import { updateSource } from '../src/desktop/update-source.mjs';
import { releaseConfig } from '../scripts/release-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import updaterPackage from 'electron-updater';
import { HttpExecutor } from 'builder-util-runtime';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js';

const source = { provider: 'generic', url: 'https://updates.example.test/studyself/' };
function setup(options = {}) {
  const engine = new EventEmitter();
  engine.checkForUpdates = async () => {
    engine.emit('checking-for-update'); engine.emit('update-available');
    return { updateInfo: { version: '0.2.0', releaseNotes: '<script>remote</script>', releaseDate: '2026-10-20T00:00:00Z' } };
  };
  engine.downloadUpdate = async () => { engine.emit('download-progress', { percent: 55, total: 100, transferred: 55 }); engine.emit('update-downloaded', { version: '0.2.0' }); return ['fixture.exe']; };
  engine.quitAndInstall = (...args) => { engine.installArgs = args; };
  const events = [];
  const manager = new UpdateManager({ version: '0.1.1', packaged: true, platform: 'win32', source, createUpdater: () => engine, notify: status => events.push(status), ...options });
  return { engine, manager, events };
}

test('online source requires explicit HTTPS directory or public GitHub repository; release metadata matches provider', () => {
  assert.equal(updateSource({ ...source, url: 'https://updates.example.test/releases' }).url, 'https://updates.example.test/releases/');
  for (const url of ['http://example.test/', 'file:///c:/update', 'https://user:secret@example.test/', 'https://example.test/?token=x', 'https://example.test/latest.yml']) {
    assert.throws(() => updateSource({ ...source, url }));
  }
  assert.throws(() => updateSource({ provider: 'github', owner: '../x', repo: 'repo' }));
  assert.throws(() => updateSource({ provider: 's3' }));
  assert.deepEqual(releaseConfig({}).extraMetadata.studyselfUpdateSource,
    { provider: 'github', owner: 'FengZaiY', repo: 'Project02_StudySelf', private: false, releaseType: 'release' });
  assert.throws(() => releaseConfig({ STUDYSELF_UPDATE_URL: source.url, STUDYSELF_UPDATE_GITHUB: 'owner/repo' }));
  for (const env of [{ STUDYSELF_UPDATE_URL: source.url }, { STUDYSELF_UPDATE_GITHUB: 'owner/repo' }]) {
    const config = releaseConfig(env);
    assert.deepEqual(config.extraMetadata.studyselfUpdateSource, config.publish[0]);
    assert.equal(config.win.target, 'nsis');
    assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  }
});

test('development and unconfigured installations cannot download or install', async () => {
  const failed = setup({ createUpdater: () => { throw new Error('component failure'); } }).manager;
  assert.equal(failed.status().phase, 'configuration-error');
  await assert.rejects(failed.check());
  for (const options of [{ packaged: false }, { platform: 'linux' }, { source: null }, { source: { provider: 'invalid' } }]) {
    let constructed = false;
    const { manager } = setup({ ...options, createUpdater: () => { constructed = true; } });
    assert.equal(constructed, false);
    await assert.rejects(manager.check()); await assert.rejects(manager.download()); assert.throws(() => manager.install());
    assert.notEqual(manager.status().phase, 'current');
  }
});

test('checks do not download, progress is reported, verified download is installed only on explicit action', async () => {
  const { engine, manager, events } = setup();
  assert.equal(engine.autoDownload, false); assert.equal(engine.autoInstallOnAppQuit, false);
  assert.equal(engine.allowDowngrade, false); assert.equal(engine.allowPrerelease, false);
  await assert.rejects(manager.download());
  assert.equal((await manager.check()).phase, 'available');
  assert.ok(manager.status().checkedAt);
  assert.throws(() => manager.install());
  assert.equal((await manager.download()).phase, 'downloaded');
  assert.ok(events.some(event => event.progress?.percent === 55));
  assert.equal(engine.installArgs, undefined);
  await assert.rejects(manager.check());
  manager.install(); assert.deepEqual(engine.installArgs, [false, true]);
  assert.throws(() => manager.install());
});

test('failed checks, failed integrity, concurrent clicks and outdated download events cannot report success', async () => {
  const { engine, manager } = setup();
  let release;
  engine.checkForUpdates = () => new Promise(resolve => { release = resolve; });
  const pending = manager.check();
  await assert.rejects(manager.check()); await assert.rejects(manager.download());
  release({ updateInfo: { version: '0.1.0' } });
  assert.equal((await pending).phase, 'current');
  engine.checkForUpdates = async () => { throw Object.assign(new Error('private/path'), { code: 'ECONNRESET' }); };
  const failure = await manager.check();
  assert.equal(failure.phase, 'error'); assert.equal(failure.error.includes('private/path'), false);
  engine.checkForUpdates = async () => { engine.emit('update-available'); return { updateInfo: { version: '0.2.0' } }; };
  await manager.check();
  engine.downloadUpdate = async () => { engine.emit('update-downloaded', { version: '0.1.9' }); throw Object.assign(new Error('bad hash'), { code: 'ERR_CHECKSUM_MISMATCH' }); };
  assert.equal((await manager.download()).phase, 'error'); assert.throws(() => manager.install());
  engine.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(manager.status().phase, 'error');
  await manager.check();
  engine.downloadUpdate = async () => { engine.emit('update-downloaded', { version: '0.2.0' }); };
  await manager.download();
  engine.quitAndInstall = () => { throw new Error('cannot launch'); };
  assert.equal(manager.install().phase, 'error');
});

test('auto check persistence fails closed without changing current choice', () => {
  let saved;
  const { manager } = setup({ saveAutoCheck: value => { saved = value; } });
  manager.configure({ autoCheck: false }); assert.equal(saved, false);
  assert.throws(() => manager.configure({ autoCheck: 'false' }));
  manager.saveAutoCheck = () => { throw new Error('disk full'); };
  assert.throws(() => manager.configure({ autoCheck: true })); assert.equal(manager.status().autoCheck, false);
});

test('installation gate protects pending storage, dirty tabs, imports, sync, reads and overlapping requests', () => {
  const service = { transport: {}, imports: new Set(), agents: {}, store: { local: key => key === 'workspace' ? { tabs: [] } : null, activeAssetReads: new Map() } };
  const storage = { status: () => ({ restartRequired: false }) };
  assertUpdateIdle(service, storage);
  assert.throws(() => assertUpdateIdle(service, storage, 1, true), /自定义启动目录/);
  assert.throws(() => assertUpdateIdle(service, { status: () => ({ restartRequired: true }) }));
  assert.throws(() => assertUpdateIdle(service, storage, 2));
  for (const [object, key] of [[service, 'localTask'], [service.transport, 'running'], [service.agents, 'starting']]) {
    object[key] = true; assert.throws(() => assertUpdateIdle(service, storage)); object[key] = false;
  }
  service.imports.add('pending'); assert.throws(() => assertUpdateIdle(service, storage)); service.imports.clear();
  service.store.activeAssetReads.set('asset', 1); assert.throws(() => assertUpdateIdle(service, storage)); service.store.activeAssetReads.clear();
  service.store.local = () => ({ tabs: [{ dirty: true }] }); assert.throws(() => assertUpdateIdle(service, storage));
});

test('real NSIS updater parses an isolated feed, verifies SHA512 and rejects damaged bytes without executing anything', async t => {
  const root = path.resolve('artifacts/update-downloads'); fs.mkdirSync(root, { recursive: true });
  const payload = Buffer.from('Non-executable isolated update fixture.');
  let corrupt = true;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/latest.yml')) {
      res.end(JSON.stringify({ version: '0.2.0', files: [{ url: 'fixture.exe', size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') }] }));
    } else { const data = corrupt ? Buffer.from('damaged fixture') : payload; res.setHeader('Content-Length', data.length); res.end(data); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  class IsolatedExecutor extends HttpExecutor {
    createRequest(options, callback) { return http.request(options, callback); }
    download(...args) { return ElectronHttpExecutor.prototype.download.apply(this, args); }
  }
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const config = path.join(directory, 'app-update.yml');
  fs.writeFileSync(config, JSON.stringify({ updaterCacheDirName: 'cache' }));
  const fakeApp = { version: '0.1.1', isPackaged: true, name: 'StudySelf', userDataPath: directory, baseCachePath: directory,
    appUpdateConfigPath: config, whenReady: async () => {}, onQuit: () => assert.fail('ordinary quit must not install') };
  const manager = new UpdateManager({ version: '0.1.1', packaged: true, platform: 'win32', source, createUpdater: () => {
    const engine = new updaterPackage.NsisUpdater(undefined, fakeApp);
    engine.httpExecutor = new IsolatedExecutor();
    // Only this test replaces HTTPS with a loopback fixture; production source validation remains unchanged.
    engine.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/`, useMultipleRangeRequest: false });
    engine.disableDifferentialDownload = true; engine.logger = null;
    return engine;
  } });
  assert.equal((await manager.check()).phase, 'available');
  assert.equal((await manager.download()).phase, 'error');
  assert.throws(() => manager.requireDownloaded());
  corrupt = false;
  await manager.check();
  assert.equal((await manager.download()).phase, 'downloaded');
  assert.deepEqual(fs.readFileSync(manager.updater.installerPath), payload);
});
