import fs from 'node:fs';
import path from 'node:path';
import { check, noSymlink, now } from './util.mjs';

const rootOf = store => path.join(store.directory, 'received-objects');
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const within = (root, file) => {
  const relative = path.relative(pathKey(root), pathKey(file));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const progressRows = store => store.db.prepare("SELECT key,value FROM local_config WHERE key LIKE 'v3Receive:%'").all()
  .map(row => ({ hash: row.key.slice('v3Receive:'.length), value: JSON.parse(row.value) })).filter(row => row.value);

// Removing only the directory keeps unknown files and interrupted receives intact.
export function pruneReceivedDirectory(store) {
  const directory = rootOf(store);
  try {
    noSymlink(directory);
    if (!fs.existsSync(directory)) return { state: 'absent' };
    if (!fs.lstatSync(directory).isDirectory()) return { state: 'blocked', reason: '接收路径不是文件夹，已保留' };
    if (fs.readdirSync(directory).length) return { state: 'retained' };
    if (progressRows(store).length || store.db.prepare('SELECT path FROM assets').all().some(row => within(directory, row.path))
      || Object.values(store.local('localFileLinks') || {}).some(file => within(directory, file))) {
      return { state: 'protected', reason: '仍有原件绑定、续传登记或本机链接，保留空目录' };
    }
    fs.rmdirSync(directory);
    return { state: 'removed' };
  } catch (error) {
    return { state: 'blocked', reason: `接收目录清理未完成：${error.message}` };
  }
}

export function receivedObjectsStatus(store, { offset = 0, limit = 25 } = {}) {
  check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, '接收目录分页参数无效');
  const directory = rootOf(store), report = { directory, at: now(), exists: false, total: 0, bytes: 0,
    counts: {}, items: [], offset, limit, error: null };
  try {
    noSymlink(directory);
    const progress = new Map(progressRows(store).map(row => [row.hash, row.value]));
    report.pendingReceives = progress.size;
    if (!fs.existsSync(directory)) return report;
    report.exists = true;
    check(fs.lstatSync(directory).isDirectory(), '接收路径不是文件夹，已保留');
    const bindings = new Map();
    for (const row of store.db.prepare('SELECT id,path FROM assets').all()) {
      const key = pathKey(row.path);
      if (!bindings.has(key)) bindings.set(key, []);
      bindings.get(key).push(row.id);
    }
    const links = new Set(Object.values(store.local('localFileLinks') || {}).map(pathKey));
    const cleanup = new Set((store.local('hierarchyCleanup') || []).map(item => item.relative));
    const deletions = new Set((store.local('permanentDeletionFiles') || []).filter(item => item.state !== 'done').map(item => item.relative));
    const files = fs.readdirSync(directory).sort();
    report.total = files.length;
    for (let index = 0; index < files.length; index++) {
      const name = files[index], file = path.join(directory, name), relative = path.relative(store.directory, file);
      const item = { name, size: 0, state: 'review', reason: '没有足够的托管清理依据，保留待核对' };
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) item.reason = '额外目录或链接，保留且不读取内容';
        else {
          item.size = stat.size;
          const ids = bindings.get(pathKey(file)) || [], partial = /^([a-f0-9]{64})\.v3\.partial$/.exec(name);
          if (ids.some(id => store.activeAssetReads?.get(id) > 0)) {
            item.state = 'reading'; item.reason = '原件正在读取，暂不迁移或清理';
          } else if (links.has(pathKey(file))) {
            item.state = 'linked'; item.reason = '仍被本机文件链接引用，保留';
          } else if (partial && progress.has(partial[1])) {
            const receive = progress.get(partial[1]);
            item.state = 'resume'; item.reason = '接收中或中断后保留；继续拉取时会复核并续传';
            item.completedBytes = receive.bytes; item.totalBytes = receive.size;
          } else if (ids.length) {
            item.state = 'organize'; item.reason = '仍是资料绑定的原件，等待目录整理；历史或冲突引用可能继续保留';
          } else if (deletions.has(relative)) {
            item.state = 'deletion'; item.reason = '已有永久删除任务，请在永久删除清理中重试';
          } else if (cleanup.has(relative)) {
            item.state = 'cleanup'; item.reason = '已登记旧副本，目录整理会重新核验引用及内容后清理';
          }
        }
      } catch (error) { item.reason = `无法检查，已保留：${error.message}`; }
      report.bytes += item.size;
      report.counts[item.state] = (report.counts[item.state] || 0) + 1;
      if (index >= offset && index < offset + limit) report.items.push(item);
    }
  } catch (error) { report.error = error.message; }
  return report;
}
