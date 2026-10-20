import fs from 'node:fs';
import path from 'node:path';
import { LocalHierarchy } from './local-hierarchy.mjs';
import { check, hashFile, inside, noSymlink, now, outside } from './util.mjs';

export function deletionFiles(store, ids) {
  const selected = new Set(ids), events = store.allEvents(), hierarchy = new LocalHierarchy(store);
  const assets = events.filter(event => selected.has(event.entityId) && event.type === 'asset');
  const retained = new Set(events.filter(event => !selected.has(event.entityId) && event.type === 'asset').map(event => event.data.sha256));
  const hashes = new Set(assets.map(event => event.data.sha256).filter(hash => !retained.has(hash)));
  const items = new Map();
  const add = (relative, hash, kind, assetId) => {
    const file = inside(store.directory, relative); noSymlink(file);
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    check(!stat || stat.isFile(), '待清理路径不是普通文件');
    items.set(relative, { relative, hash, kind, ...(assetId ? { assetId } : {}), bytes: stat?.size || 0, state: 'pending' });
  };
  for (const [relative, hash] of Object.entries(store.local('hierarchyFiles') || {})) {
    if (!ids.some(id => relative.endsWith(`-${id}.json`) || relative.endsWith(`-${id}.md`))) continue;
    const file = inside(store.directory, relative);
    check(hierarchy.projectionFile(file), '生成文件的知识库归属无法核验，暂不能永久删除');
    add(relative, hash, 'projection');
  }
  for (const asset of assets) {
    if (!hashes.has(asset.data.sha256)) continue;
    const binding = store.assetLocation(asset.entityId);
    if (binding && !outside(store.directory, binding.path)) {
      const relative = path.relative(store.directory, binding.path);
      const managed = hierarchy.managedOriginal(binding.path) || ['objects', 'received-objects'].some(folder =>
        relative === path.join(folder, asset.data.sha256));
      if (managed) add(relative, asset.data.sha256, 'asset', asset.entityId);
    }
    const received = path.join('received-objects', asset.data.sha256);
    if (fs.existsSync(inside(store.directory, received))) add(received, asset.data.sha256, 'asset', asset.entityId);
    const opened = path.join('opened-files', asset.entityId, asset.data.filename);
    if (fs.existsSync(inside(store.directory, opened))) add(opened, asset.data.sha256, 'asset', asset.entityId);
    const partial = `${received}.v3.partial`, progress = store.local(`v3Receive:${asset.data.sha256}`);
    if (progress?.hash === asset.data.sha256 && fs.existsSync(inside(store.directory, partial))) {
      add(partial, asset.data.sha256, 'partial', asset.entityId);
      items.get(partial).mtime = fs.statSync(inside(store.directory, partial)).mtimeMs;
    }
  }
  for (const item of store.local('hierarchyCleanup') || []) {
    if (hashes.has(item.hash) && hierarchy.managedOriginal(inside(store.directory, item.relative))) add(item.relative, item.hash, 'asset', item.assetId);
  }
  for (const [relative, hash] of Object.entries(store.local('hierarchyOriginals') || {})) {
    if (hashes.has(hash) && hierarchy.projectionFile(inside(store.directory, relative))) add(relative, hash, 'asset');
  }
  for (const hash of hashes) for (const folder of Object.values(store.local('libraryDirectories') || {})) {
    const file = path.join(store.directories.location(folder), 'attachments', hash);
    if (fs.existsSync(file) && hierarchy.managedOriginal(file)) add(path.relative(store.directory, file), hash, 'asset');
  }
  return [...items.values()];
}

export function scheduleDeletion(store, ids, files) {
  if (!ids.length) return;
  store.local('permanentDeletionAssetHashes', [...new Set([...(store.local('permanentDeletionAssetHashes') || []),
    ...store.allEvents().filter(event => ids.includes(event.entityId) && event.type === 'asset').map(event => event.data.sha256)])]);
  const jobs = store.local('permanentDeletionFiles') || [];
  for (const file of files) if (!jobs.some(item => item.relative === file.relative && item.hash === file.hash && item.state !== 'done')) jobs.push(file);
  store.local('permanentDeletionFiles', jobs);
  const removed = new Set(ids), workspace = store.local('workspace');
  if (workspace) {
    const tabs = (workspace.tabs || []).filter(tab => !removed.has(tab.recordId));
    store.local('workspace', { ...workspace, tabs, selectedTab: tabs.some(tab => tab.id === workspace.selectedTab) ? workspace.selectedTab : null });
  }
  // A paused publication holds full event payloads; it must never republish deleted text.
  for (const row of store.db.prepare("SELECT key,value FROM local_config WHERE key LIKE 'v3:%:plan'").all()) {
    const plan = JSON.parse(row.value);
    if (!Object.values(plan?.metadata || {}).some(events => events.some(event => removed.has(event.entityId)))) continue;
    store.db.prepare('DELETE FROM local_config WHERE key=? OR key=?').run(row.key, row.key.replace(/:plan$/, ':progress'));
  }
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_requests'").get()) {
    for (const row of store.db.prepare('SELECT grant_id,request_id,result FROM agent_requests').all()) {
      if (ids.some(id => row.result.includes(id))) store.db.prepare('UPDATE agent_requests SET result=? WHERE grant_id=? AND request_id=?')
        .run(JSON.stringify({ id: JSON.parse(row.result).id, permanentlyDeleted: true }), row.grant_id, row.request_id);
    }
  }
  for (const key of ['retiredV2Journal']) {
    const value = store.local(key);
    if (value && ids.some(id => JSON.stringify(value).includes(id))) store.local(key, null);
  }
}

export function deletionStatus(store) {
  const files = store.local('permanentDeletionFiles') || [];
  const legacyArchives = ['version-repositories', 'version-staging'].filter(name => fs.existsSync(path.join(store.directory, name)));
  return { files, pending: files.filter(item => item.state !== 'done').length,
    retiredAI: store.local('retiredAiCleanup'),
    releasedBytes: files.filter(item => item.state === 'done').reduce((n, item) => n + (item.releasedBytes || 0), 0),
    database: store.local('permanentDeletionDatabase'), transport: store.local('permanentDeletionTransport'), legacyArchives,
    legacyBackups: (store.local('backups') || []).length };
}

export async function runDeletionFiles(store) {
  const files = store.local('permanentDeletionFiles') || [], hierarchy = new LocalHierarchy(store);
  for (const item of files) {
    if (item.state === 'done') continue;
    try {
      const file = inside(store.directory, item.relative); noSymlink(file);
      const protectedFile = () => {
        if (item.kind === 'projection') check(hierarchy.projectionFile(file), '知识库目录归属已变化，暂停清理');
        if (item.kind === 'asset') check(hierarchy.managedOriginal(file)
          || ['objects', 'received-objects'].some(folder => item.relative === path.join(folder, item.hash))
          || item.assetId && path.dirname(item.relative) === path.join('opened-files', item.assetId), '原件目录归属已变化，暂停清理');
        const bindings = store.db.prepare('SELECT id,path FROM assets').all().filter(row => path.resolve(row.path).toLowerCase() === file.toLowerCase());
        check(!bindings.some(row => !store.isPurged(row.id) || store.activeAssetReads?.get(row.id)), '文件仍有共用或正在读取的引用');
        check(!Object.values(store.local('localFileLinks') || {}).some(value => path.resolve(value).toLowerCase() === file.toLowerCase()), '文件仍被本机链接引用');
        if (item.kind !== 'projection') check(!store.allEvents().some(event => event.type === 'asset' && event.data.sha256 === item.hash), '原件仍被其他资料或历史引用');
      };
      protectedFile();
      let releasedBytes = 0;
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (item.kind === 'partial') {
          check(item.relative === path.join('received-objects', `${item.hash}.v3.partial`)
            && store.local(`v3Receive:${item.hash}`)?.hash === item.hash
            && stat.isFile() && stat.size === item.bytes && stat.mtimeMs === item.mtime, '接收临时文件已变化，保留并等待处理');
        } else check(stat.isFile() && await hashFile(file) === item.hash, '文件已被外部修改，保留并等待处理');
        protectedFile(); noSymlink(file);
        const current = fs.statSync(file);
        check(current.size === stat.size && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs && current.ino === stat.ino, '文件在校验期间变化，保留等待处理');
        fs.unlinkSync(file); releasedBytes = stat.size;
      }
      for (const key of ['hierarchyFiles', 'hierarchyOriginals', 'hierarchyVerified']) {
        const values = store.local(key) || {}; delete values[item.relative]; store.local(key, values);
      }
      if (item.kind === 'partial') store.local(`v3Receive:${item.hash}`, null);
      store.local('hierarchyCleanup', (store.local('hierarchyCleanup') || []).filter(entry => entry.relative !== item.relative));
      for (const row of store.db.prepare('SELECT id,path FROM assets').all()) {
        if (store.isPurged(row.id) && path.resolve(row.path).toLowerCase() === file.toLowerCase()) store.db.prepare('DELETE FROM assets WHERE id=?').run(row.id);
      }
      hierarchy.pruneEmpty(path.dirname(file));
      Object.assign(item, { state: 'done', releasedBytes, reason: '', at: now() });
    } catch (error) { Object.assign(item, { state: 'blocked', reason: error.message, at: now() }); }
    store.local('permanentDeletionFiles', files);
  }
  try {
    const checkpoint = store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    check(!checkpoint.busy, '数据库仍被读取，稍后重试压缩');
    store.db.exec('VACUUM');
    check(!store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, '数据库日志仍被占用，稍后重试');
    store.local('permanentDeletionDatabase', { state: 'done', at: now() });
  } catch (error) { store.local('permanentDeletionDatabase', { state: 'blocked', reason: error.message, at: now() }); }
  return deletionStatus(store);
}
