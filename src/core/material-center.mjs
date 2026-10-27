import fs from 'node:fs';
import path from 'node:path';
import { canonical, check, hashFile, noSymlink, sha, uuid, atomicWrite } from './util.mjs';
import { MATERIAL_SCOPE } from './personal-schema.mjs';

function managedRoot(store, create) {
  const root = path.join(store.directory, '.fengzai-y'), marker = path.join(root, 'owner.json'); noSymlink(root); noSymlink(marker);
  if (fs.existsSync(root)) check(fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).deviceId === store.deviceId, '资料中心目录归属不符，已停止写入');
  else if (create) { fs.mkdirSync(root); atomicWrite(marker, JSON.stringify({ format: 1, deviceId: store.deviceId })); }
  return root;
}
export function userExportPath(store, filename) {
  check(typeof filename === 'string' && filename.length > 0, '导出文件名无效');
  let name = path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 200);
  if (!name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `FengZaiY-${name || 'export'}`;
  const directory = path.join(managedRoot(store, true), 'exports'); noSymlink(directory);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name); noSymlink(target); return target;
}
export function centralAssetPath(store, hash, create = true) {
  check(/^[a-f0-9]{64}$/.test(hash), '原件哈希无效');
  const root = managedRoot(store, create);
  const file = path.join(root, 'materials', hash.slice(0, 2), hash); noSymlink(file);
  if (create) fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
export function isCentralAsset(store, file) {
  try { return /^[a-f0-9]{64}$/.test(path.basename(file)) && path.resolve(file) === centralAssetPath(store, path.basename(file), false) && fs.existsSync(path.join(store.directory, '.fengzai-y', 'owner.json')); }
  catch { return false; }
}
export class MaterialCenter {
  constructor(store, hierarchy) { this.store = store; this.hierarchy = hierarchy; this.running = false; }
  update({ id, parents, changes }, actor = '用户') {
    const record = this.store.get(id);
    check(record?.type === 'asset' && !record.deleted && !record.conflict, '资料不可用');
    check(changes && Object.keys(changes).every(k => ['title', 'tags', 'sensitive', 'collectionIds'].includes(k)), '不允许修改原件身份');
    for (const ref of changes.collectionIds || []) { const collection = this.store.get(ref); check(collection?.type === 'materialCollection' && !collection.deleted && !collection.conflict, '资料集合不可用'); }
    return this.store.change('修改资料属性', actor, () => this.store.write({ id, type: 'asset', parents, data: { ...record.data, ...changes } }));
  }
  preview() {
    const rows = [...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })].filter(r => !r.data.centralized || !isCentralAsset(this.store, this.store.assetLocation(r.id)?.path || '')).map(record => {
      const local = this.store.assetLocation(record.id); let issue = '';
      if (record.conflict) issue = '存在版本冲突';
      else if (!local || !fs.existsSync(local.path)) issue = '原件未下载或缺失';
      else if (this.store.activeAssetReads?.get(record.id)) issue = '原件正在读取';
      return { id: record.id, title: record.data.title, parents: record.heads, source: local?.path || null,
        target: centralAssetPath(this.store, record.data.sha256, false), size: record.data.size, hash: record.data.sha256, issue };
    });
    return { rows, bytes: rows.filter(r => !r.issue).reduce((s, r) => s + r.size, 0), token: sha(canonical(rows)), progress: this.store.local('materialMigration') || null };
  }
  async migrate({ token, confirmed = false, resume = false } = {}) {
    check(!this.running, '资料迁移正在进行', 'BUSY');
    let job = this.store.local('materialMigration');
    if (!resume) { const preview = this.preview(); check(confirmed === true && preview.token === token, '请重新预览并确认资料迁移', 'CONFLICT'); job = { rows: preview.rows.filter(r => !r.issue), done: [], errors: [], state: 'running' }; }
    check(job, '没有可继续的迁移任务');
    job.errors = []; job.state = 'running'; this.store.local('materialMigration', job); this.running = true; this.store.materialMigrating = true;
    try {
      for (const item of job.rows) {
        if (job.done.includes(item.id)) continue;
        try {
          const record = this.store.get(item.id), local = this.store.assetLocation(item.id);
          check(record && canonical(record.heads) === canonical(item.parents) && local?.path === item.source, '资料或位置已变化，请重新预览', 'CONFLICT');
          check(!this.store.activeAssetReads?.get(item.id), '原件正在读取'); noSymlink(item.source);
          check(fs.statSync(item.source).size === item.size && await hashFile(item.source) === item.hash, '原件校验失败');
          const target = centralAssetPath(this.store, item.hash);
          if (!fs.existsSync(target)) {
            const space = fs.statfsSync(path.dirname(target)); check(space.bavail * space.bsize >= item.size + 64 * 1024 * 1024, '磁盘空间不足');
            const temp = `${target}.${uuid()}.partial`;
            try {
              await fs.promises.copyFile(item.source, temp, fs.constants.COPYFILE_EXCL);
              check(await hashFile(temp) === item.hash && fs.statSync(temp).size === item.size, '复制校验失败');
              const handle = await fs.promises.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
              try { await fs.promises.link(temp, target); }
              catch (error) { if (error.code !== 'EEXIST') throw error; }
            } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
          }
          check(fs.statSync(target).size === item.size && await hashFile(target) === item.hash, '目标原件已变化，未覆盖');
          check(!this.store.activeAssetReads?.get(item.id) && this.store.assetLocation(item.id)?.path === item.source, '原件开始使用或位置已变化，保留副本');
          this.store.change('升级资料中心', '用户', () => {
            this.store.writeRaw({ id: record.id, type: 'asset', parents: item.parents, deleted: record.deleted,
              data: { ...record.data, centralized: true, collectionIds: record.data.collectionIds || [], libraryDomains: record.data.libraryDomains || (record.data.domain === MATERIAL_SCOPE ? [] : [record.data.domain]) } });
            this.store.bindAsset(record.id, target, local.pinned === 1);
            if (this.hierarchy.managedOriginal(item.source) && item.source !== target) this.store.local('hierarchyCleanup', [...(this.store.local('hierarchyCleanup') || []), { relative: path.relative(this.store.directory, item.source), hash: item.hash, assetId: item.id }]);
            this.store.local('materialMigration', { ...job, done: [...job.done, item.id] });
          });
          job.done.push(item.id);
        } catch (error) { job.errors.push({ id: item.id, message: error.message }); }
        this.store.local('materialMigration', job);
      }
      await this.hierarchy.cleanOriginals();
      job.state = job.errors.length ? 'pending' : 'complete'; this.store.local('materialMigration', job); return job;
    } finally { this.running = false; this.store.materialMigrating = false; }
  }
}
