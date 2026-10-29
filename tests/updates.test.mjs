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
import { attachUpdateDownload } from '../src/desktop/update-download.mjs';

const source = { provider: 'generic', url: 'https://updates.example.test/fengzaiy/' };
function setup(options = {}) {
  const engine = new EventEmitter();
  engine.checkForUpdates = async () => {
    engine.emit('checking-for-update'); engine.emit('update-available');
    return { updateInfo: { version: '0.2.0', releaseNotes: '<script>remote</script>', releaseDate: '2026-10-20T00:00:00Z' } };
  };
  engine.downloadUpdate = async () => { engine.emit('download-progress', { percent: 55, total: 100, transferred: 55 }); engine.emit('update-downloaded', { version: '0.2.0' }); return ['fixture.exe']; };
  engine.quitAndInstall = (...args) => { engine.installArgs = args; };
  engine.resetDownload = async () => {};
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
  assert.deepEqual(releaseConfig({}).extraMetadata.fengzaiyUpdateSource,
    { provider: 'github', owner: 'FengZaiY', repo: 'Project02_FengZaiY', private: false, releaseType: 'release' });
  assert.throws(() => releaseConfig({ FENGZAIY_UPDATE_URL: source.url, FENGZAIY_UPDATE_GITHUB: 'owner/repo' }));
  for (const env of [{ FENGZAIY_UPDATE_URL: source.url }, { FENGZAIY_UPDATE_GITHUB: 'owner/repo' }]) {
    const config = releaseConfig(env);
    assert.deepEqual(config.extraMetadata.fengzaiyUpdateSource, config.publish[0]);
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

test('real NSIS updater cancels, resumes, restarts and verifies SHA512 without executing anything', async t => {
  const root = path.resolve('artifacts/update-downloads'); fs.mkdirSync(root, { recursive: true });
  const payload = Buffer.alloc(512 * 1024, 97), requests = [];
  let corrupt = true;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/latest.yml')) {
      res.end(JSON.stringify({ version: '0.2.0', files: [{ url: 'fixture.exe', size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') }] }));
    } else {
      if (corrupt) { res.end('damaged fixture'); return; }
      const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
      requests.push(offset);
      const headers = { 'Content-Length': payload.length - offset };
      if (offset) headers['Content-Range'] = `bytes ${offset}-${payload.length - 1}/${payload.length}`;
      res.writeHead(offset ? 206 : 200, headers);
      let sent = offset;
      const timer = setInterval(() => {
        const end = Math.min(sent + 16384, payload.length); res.write(payload.subarray(sent, end)); sent = end;
        if (sent === payload.length) { clearInterval(timer); res.end(); }
      }, 20);
      res.on('close', () => clearInterval(timer));
    }
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
  const fakeApp = { version: '0.1.1', isPackaged: true, name: 'FengZaiY', userDataPath: directory, baseCachePath: directory,
    appUpdateConfigPath: config, whenReady: async () => {}, onQuit: () => assert.fail('ordinary quit must not install') };
  const manager = new UpdateManager({ version: '0.1.1', packaged: true, platform: 'win32', source, createUpdater: () => {
    const engine = new updaterPackage.NsisUpdater(undefined, fakeApp);
    engine.httpExecutor = new IsolatedExecutor();
    // Only this test replaces HTTPS with a loopback fixture; production source validation remains unchanged.
    engine.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/`, useMultipleRangeRequest: false });
    engine.disableDifferentialDownload = true; engine.logger = null;
    return attachUpdateDownload(engine, { directory: path.join(directory, 'resume'), fetch, allowLoopback: true });
  } });
  assert.equal((await manager.check()).phase, 'available');
  assert.equal((await manager.download()).phase, 'error');
  assert.throws(() => manager.requireDownloaded());
  corrupt = false;
  await manager.check();
  let pausing;
  const pause = progress => { if (progress.transferred >= 32768) { manager.updater.off('download-progress', pause); pausing = manager.pause(); } };
  manager.updater.on('download-progress', pause);
  assert.equal((await manager.download()).phase, 'paused');
  await pausing;
  const pausedBytes = manager.status().progress.transferred;
  manager.updater.on('download-progress', pause);
  assert.equal((await manager.download()).phase, 'paused');
  await pausing;
  assert.equal(requests[1], pausedBytes);
  assert.equal((await manager.restartDownload()).phase, 'downloaded');
  assert.deepEqual(requests, [0, pausedBytes, 0]);
  assert.deepEqual(fs.readFileSync(manager.updater.installerPath), payload);
});

test('pause waits for cancellation to settle; late events and duplicate actions cannot install or overlap', async () => {
  const { engine, manager } = setup();
  await manager.check();
  let stopped, token;
  engine.downloadUpdate = cancellation => new Promise((resolve, reject) => {
    token = cancellation; stopped = reject;
    engine.emit('download-progress', { percent: 55, total: 100, transferred: 55 });
  });
  const download = manager.download();
  const pause = manager.pause();
  assert.equal(token.cancelled, true); assert.equal(manager.status().phase, 'pausing');
  await assert.rejects(manager.download()); await assert.rejects(manager.check());
  await assert.rejects(manager.restartDownload()); assert.throws(() => manager.install());
  engine.emit('download-progress', { percent: 100 }); engine.emit('update-downloaded', { version: '0.2.0' });
  stopped(new Error('cancelled download'));
  await pause; await download;
  assert.equal(manager.status().phase, 'paused'); assert.equal(manager.status().progress.percent, 55);
  engine.emit('error', new Error('late cancellation')); assert.equal(manager.status().phase, 'paused');
  assert.equal((await manager.pause()).phase, 'paused');
  engine.downloadUpdate = async () => { engine.emit('update-downloaded', { version: '0.2.0' }); };
  assert.equal((await manager.download()).phase, 'downloaded');
});

test('restart waits for the old task and resets cache once; reset failure and download failure stay retryable', async () => {
  const { engine, manager } = setup(); await manager.check();
  let resets = 0, release;
  engine.downloadUpdate = token => new Promise((resolve, reject) => { token.onCancel(() => { release = reject; }); });
  engine.resetDownload = async () => { resets++; };
  const original = manager.download(), restart = manager.restartDownload();
  assert.equal(manager.status().phase, 'restarting'); assert.equal(resets, 0);
  await assert.rejects(manager.restartDownload()); await assert.rejects(manager.check());
  engine.downloadUpdate = async () => { engine.emit('update-downloaded', { version: '0.2.0' }); };
  release(new Error('cancel')); await original; await restart;
  assert.equal(resets, 1); assert.equal(manager.status().phase, 'downloaded');
  const failed = setup(); await failed.manager.check();
  failed.engine.downloadUpdate = async () => { throw new Error('network failed'); };
  await failed.manager.download(); assert.equal(failed.manager.status().failedOperation, 'download');
  failed.engine.resetDownload = async () => { throw new Error('cache busy'); };
  assert.equal((await failed.manager.restartDownload()).phase, 'error');
  failed.engine.downloadUpdate = async () => { failed.engine.emit('update-downloaded', { version: '0.2.0' }); };
  assert.equal((await failed.manager.download()).phase, 'downloaded');
});
