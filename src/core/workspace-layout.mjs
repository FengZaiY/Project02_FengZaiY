import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { atomicWrite, canonical, check, hashFile, noSymlink, sha } from './util.mjs';

const layoutFile = directory => path.join(directory, '.fengzai-y', 'metadata', 'layout.json');
function closedFileHash(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); return hash.digest('hex'); }
  finally { fs.closeSync(fd); }
}
export function layoutState(directory) {
  const file = layoutFile(directory); noSymlink(file);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
export function databasePath(directory) {
  const state = layoutState(directory);
  return state?.state === 'complete' ? path.join(directory, '.fengzai-y', 'database', 'knowledge.sqlite') : path.join(directory, 'knowledge.sqlite');
}
export function deviceKeyPath(directory) {
  return layoutState(directory)?.state === 'complete' ? path.join(directory, '.fengzai-y', 'metadata', 'device-vault.key') : path.join(directory, 'device-vault.key');
}
const subdirectories = { 'received-objects': ['staging', 'received-objects'], 'objects': ['history', 'objects'], 'opened-files': ['cache', 'opened-files'] };
export function workspaceInternalPath(store, name, ...parts) {
  const root = typeof store === 'string' ? store : store.directory;
  check(Object.hasOwn(subdirectories, name), '未知的内部目录');
  return layoutState(root)?.state === 'complete' ? path.join(root, '.fengzai-y', ...subdirectories[name], ...parts) : path.join(root, name, ...parts);
}
export function layoutPreview(store) {
  const state = layoutState(store.directory);
  return { state: state?.state || 'legacy', source: databasePath(store.directory), target: path.join(store.directory, '.fengzai-y', 'database', 'knowledge.sqlite'),
    deviceId: store.deviceId, restartRequired: state?.state === 'pending', token: sha(canonical([store.deviceId, store.directory, state])),
    legacyGuard: 'knowledge.sqlite 目录作为旧版启动保护保留，避免旧安装版误建空库。' };
}
export function scheduleLayout(store, { token, confirmed }) {
  const preview = layoutPreview(store); check(confirmed === true && token === preview.token, '请重新预览并确认内部目录迁移', 'CONFLICT');
  check(!(store.local('workspace')?.tabs || []).some(tab => tab.dirty), '请先保存未保存的笔记');
  if (preview.state === 'complete') return preview;
  const internal = path.join(store.directory, '.fengzai-y'), owner = path.join(internal, 'owner.json'); noSymlink(owner);
  if (!fs.existsSync(internal)) { fs.mkdirSync(internal); atomicWrite(owner, JSON.stringify({ format: 1, deviceId: store.deviceId })); }
  check(fs.existsSync(owner) && JSON.parse(fs.readFileSync(owner, 'utf8')).deviceId === store.deviceId, '内部目录归属不符，停止迁移');
  const file = layoutFile(store.directory); noSymlink(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify({ format: 1, state: 'pending', deviceId: store.deviceId }));
  return layoutPreview(store);
}

// Called with the workspace lock held and before any application SQLite handle is opened.
export function applyLayout(directory) {
  let state = layoutState(directory); if (!state) return;
  check(state.format === 1 && ['pending', 'complete'].includes(state.state), '内部目录迁移状态无效');
  const source = path.join(directory, 'knowledge.sqlite'), target = path.join(directory, '.fengzai-y', 'database', 'knowledge.sqlite');
  noSymlink(source); noSymlink(target);
  if (state.state === 'complete') {
    check(fs.existsSync(target) && fs.statSync(target).isFile(), '内部数据库缺失，禁止创建空工作区');
    if (!fs.existsSync(source)) {
      fs.mkdirSync(source);
      atomicWrite(path.join(source, '请升级客户端.txt'), '数据库已迁移到 .fengzai-y/database。请使用支持可读目录的新版本打开本工作区。\n');
    }
    check(fs.statSync(source).isDirectory(), '根目录存在另一个数据库，停止打开以保护两处数据');
    return;
  }
  const from = fs.existsSync(source) && fs.statSync(source).isFile() ? source : target;
  check(fs.existsSync(from), '迁移数据库缺失，禁止创建空工作区');
  if (from === source) {
    check(!fs.existsSync(target), '内部数据库目标非空，保留两处数据等待处理');
    const db = new DatabaseSync(source);
    try {
      check(db.prepare("SELECT value FROM meta WHERE key='deviceId'").get()?.value === state.deviceId, '迁移工作区身份不符');
      check(Object.values(db.prepare('PRAGMA integrity_check').get())[0] === 'ok', '迁移前数据库校验失败');
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); check(checkpoint.busy === 0, '数据库仍被占用，请关闭其他实例');
    } finally { db.close(); }
    state = { ...state, databaseHash: closedFileHash(source) }; atomicWrite(layoutFile(directory), JSON.stringify(state));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(source, target);
  }
  check(state.databaseHash === closedFileHash(target), '内部数据库迁移校验失败，保留现场');
  const oldKey = path.join(directory, 'device-vault.key'), newKey = path.join(directory, '.fengzai-y', 'metadata', 'device-vault.key');
  noSymlink(oldKey); noSymlink(newKey);
  if (fs.existsSync(oldKey)) { check(!fs.existsSync(newKey), '内部凭据目标已存在，停止迁移'); fs.renameSync(oldKey, newKey); }
  // An old executable must fail instead of silently initializing a second, empty SQLite database.
  if (!fs.existsSync(source)) fs.mkdirSync(source);
  check(fs.statSync(source).isDirectory(), '旧版启动保护路径异常');
  atomicWrite(path.join(source, '请升级客户端.txt'), '数据库已迁移到 .fengzai-y/database。请使用支持可读目录的新版本打开本工作区。\n');
  atomicWrite(layoutFile(directory), JSON.stringify({ format: 1, state: 'complete', deviceId: state.deviceId }));
}

export async function relocateInternalFiles(store) {
  if (layoutState(store.directory)?.state !== 'complete') return { moved: 0, errors: [] };
  const items = new Map(), completed = store.local('internalRelocatedFiles') || {};
  const add = (source, target, hash) => { noSymlink(source); noSymlink(target); if (!completed[path.relative(store.directory, source)] && fs.existsSync(source)) items.set(source, { source, target, hash }); };
  for (const event of store.allEvents().filter(e => e.type === 'asset')) for (const name of ['objects', 'received-objects']) {
    const old = path.join(store.directory, name, event.data.sha256);
    add(old, workspaceInternalPath(store, name, event.data.sha256), event.data.sha256);
  }
  for (const row of store.db.prepare("SELECT key,value FROM local_config WHERE key LIKE 'v3Receive:%'").all()) {
    const hash = row.key.slice('v3Receive:'.length); if (!/^[a-f0-9]{64}$/.test(hash) || !JSON.parse(row.value)) continue;
    const name = `${hash}.v3.partial`; add(path.join(store.directory, 'received-objects', name), workspaceInternalPath(store, 'received-objects', name));
  }
  const report = { moved: 0, errors: [] };
  for (const item of items.values()) {
    try {
      const hash = await hashFile(item.source); check(!item.hash || hash === item.hash, '内部原件被外部修改，保留原位');
      check(![...store.activeAssetReads?.keys() || []].some(id => store.assetLocation(id)?.path === item.source), '原件正在使用');
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      if (!fs.existsSync(item.target)) fs.copyFileSync(item.source, item.target, fs.constants.COPYFILE_EXCL);
      check(await hashFile(item.target) === hash, '内部目标校验失败');
      store.transaction(() => {
        store.db.prepare('UPDATE assets SET path=? WHERE path=?').run(item.target, item.source);
        const links = store.local('localFileLinks'); if (links) store.local('localFileLinks', Object.fromEntries(Object.entries(links).map(([id, file]) => [id, file === item.source ? item.target : file])));
        const old = store.local('readableOldCopies') || [];
        if (item.hash && !old.some(entry => entry.relative === path.relative(store.directory, item.source))) store.local('readableOldCopies', [...old, { relative: path.relative(store.directory, item.source), hash, internalTarget: item.target }]);
        completed[path.relative(store.directory, item.source)] = { hash, target: path.relative(store.directory, item.target) };
        store.local('internalRelocatedFiles', completed);
      });
      report.moved++;
    } catch (error) { report.errors.push({ source: item.source, message: error.message }); }
  }
  store.local('internalLayoutReport', report); return report;
}
