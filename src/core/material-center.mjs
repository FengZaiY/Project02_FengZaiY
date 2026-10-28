import fs from 'node:fs';
import path from 'node:path';
import { canonical, check, hashFile, noSymlink, sha, uuid, atomicWrite } from './util.mjs';
import { MATERIAL_SCOPE } from './personal-schema.mjs';
import { readableAssetPath, readableDirectory, isReadableAsset, materialLocation } from './readable-storage.mjs';
import { assetReferenceIndex } from './asset-management.mjs';

export function managedRoot(store, create) {
  const root = path.join(store.directory, '.fengzai-y'), marker = path.join(root, 'owner.json'); noSymlink(root); noSymlink(marker);
  if (fs.existsSync(root)) check(fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).deviceId === store.deviceId, '资料中心目录归属不符，已停止写入');
  else if (create) { fs.mkdirSync(root); atomicWrite(marker, JSON.stringify({ format: 1, deviceId: store.deviceId })); }
  return root;
}
export function userExportPath(store, filename) {
  check(typeof filename === 'string' && filename.length > 0, '导出文件名无效');
  let name = path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 200);
  if (!name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `FengZaiY-${name || 'export'}`;
  const directory = readableDirectory(store, store.directory, '导出', 'exports'); noSymlink(directory);
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
  async cleanupPreview() {
    const rows = [];
    for (const item of this.store.local('readableOldCopies') || []) {
      try {
        const file = this.hierarchy.checked(item.relative), target = item.internalTarget || this.store.assetLocation(item.assetId)?.path;
        if (!fs.existsSync(file)) continue;
        let issue = '';
        if (!target || target === file || !fs.existsSync(target)) issue = '新的可用原件不存在';
        else if (this.store.db.prepare('SELECT 1 FROM assets WHERE path=?').get(file) || Object.values(this.store.local('localFileLinks') || {}).some(p => path.resolve(p).toLowerCase() === file.toLowerCase())) issue = '仍被本机绑定或链接引用';
        else if (item.assetId && (this.store.get(item.assetId)?.conflict || this.store.activeAssetReads?.get(item.assetId))) issue = '原件冲突或正在读取';
        else if (!this.hierarchy.managedOriginal(file)) issue = '无法核验托管归属';
        else { noSymlink(target); if (await hashFile(file) !== item.hash || await hashFile(target) !== item.hash) issue = '旧副本或当前原件被修改'; }
        rows.push({ ...item, source: file, target, bytes: fs.statSync(file).size, issue });
      } catch (error) { rows.push({ ...item, issue: error.message }); }
    }
    return { rows, token: sha(canonical(rows)), bytes: rows.filter(r => !r.issue).reduce((total, row) => total + row.bytes, 0) };
  }
  async cleanup({ token, confirmed }) {
    const preview = await this.cleanupPreview(); check(confirmed === true && preview.token === token, '请重新预览并确认旧副本清理', 'CONFLICT');
    const done = [], errors = [];
    for (const item of preview.rows.filter(row => !row.issue)) {
      try {
        check(!this.store.db.prepare('SELECT 1 FROM assets WHERE path=?').get(item.source) && !(item.assetId && this.store.activeAssetReads?.get(item.assetId))
          && !Object.values(this.store.local('localFileLinks') || {}).some(file => path.resolve(file).toLowerCase() === item.source.toLowerCase()), '原件开始使用，保留副本');
        noSymlink(item.source); noSymlink(item.target);
        check(await hashFile(item.source) === item.hash && await hashFile(item.target) === item.hash, '文件已变化，保留副本');
        check(!this.store.db.prepare('SELECT 1 FROM assets WHERE path=?').get(item.source) && !(item.assetId && this.store.activeAssetReads?.get(item.assetId))
          && !Object.values(this.store.local('localFileLinks') || {}).some(file => path.resolve(file).toLowerCase() === item.source.toLowerCase()), '原件开始使用，保留副本');
        fs.unlinkSync(item.source); done.push(item.relative); this.hierarchy.pruneEmpty(path.dirname(item.source));
      } catch (error) { errors.push({ relative: item.relative, message: error.message }); }
    }
    this.store.local('readableOldCopies', (this.store.local('readableOldCopies') || []).filter(item => !done.includes(item.relative)));
    return { done, errors, retained: preview.rows.filter(row => row.issue) };
  }
  tree() {
    return { categories: this.store.list({ type: 'materialCategory' }), topics: this.store.list({ type: 'materialTopic' }),
      pending: this.store.local('readableStoragePending') === true, migration: this.store.local('materialMigration') || null };
  }
  proposalPreview(id) {
    const proposal = this.store.get(id); check(proposal?.type === 'proposal', '请选择整理方案');
    const planner = Object.create(this.store), local = new Map(); planner.planningPaths = true;
    planner.local = (key, value) => { if (value !== undefined) local.set(key, value); if (!local.has(key)) local.set(key, structuredClone(this.store.local(key))); return local.get(key); };
    const candidates = new Map((proposal.data.materialItems || []).filter(i => i.status === 'pending' && i.type !== 'asset').map(i => [i.targetId, { id: i.targetId, type: i.type, data: i.data }]));
    planner.get = target => candidates.get(target) || this.store.get(target);
    const refs = assetReferenceIndex(this.store);
    return (proposal.data.materialItems || []).map(item => {
      const current = this.store.get(item.targetId);
      if (item.type !== 'asset') return { id: item.id, title: item.data.title, type: item.type, logical: item.type === 'materialTopic' ? `${planner.get(item.data.materialCategoryId)?.data.title || '缺少分类'} / ${item.data.title}` : item.data.title };
      const record = { ...current, data: { ...current?.data, ...item.data } };
      try { const source = this.store.assetLocation(item.targetId)?.path || null, target = readableAssetPath(planner, record, false);
        return { id: item.id, title: current?.data.title, source,
        target, placement: source === target && fs.existsSync(source) ? 'ready' : 'pending', logical: materialLocation(planner, record.data), bytes: current?.data.size,
        references: refs.refs.get(item.targetId) || [] }; }
      catch (error) { return { id: item.id, title: current?.data.title, issue: error.message }; }
    });
  }
  preview({ onlyPlanned = false, ids } = {}) {
    const snapshot = new Map(), planner = Object.create(this.store); planner.planningPaths = true;
    planner.local = (key, value) => { if (value !== undefined) snapshot.set(key, value); if (!snapshot.has(key)) snapshot.set(key, structuredClone(this.store.local(key))); return snapshot.get(key); };
    const rows = [...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })].sort((a, b) => a.id.localeCompare(b.id)).filter(record => (!ids || ids.includes(record.id)) && (!onlyPlanned || record.data.materialTopicId || record.data.managedFilename || isReadableAsset(this.store, this.store.assetLocation(record.id)?.path || ''))).map(record => {
      const local = this.store.assetLocation(record.id); let issue = '';
      let target = null, logical = null;
      try { target = readableAssetPath(planner, record, false); logical = materialLocation(this.store, record.data); } catch (error) { issue = error.message; }
      if (record.conflict) issue = '存在版本冲突';
      else if (!local || !fs.existsSync(local.path)) issue = '原件未下载或缺失';
      else if (this.store.activeAssetReads?.get(record.id)) issue = '原件正在读取';
      return { id: record.id, title: record.data.title, parents: record.heads, source: local?.path || null,
        target, logical, size: record.data.size, hash: record.data.sha256, issue };
    }).filter(row => row.source !== row.target || row.issue);
    return { rows, bytes: rows.filter(r => !r.issue).reduce((s, r) => s + r.size, 0), token: sha(canonical(rows)), progress: this.store.local('materialMigration') || null };
  }
  async migrate({ token, confirmed = false, resume = false, onlyPlanned = false, ids } = {}) {
    check(!this.running, '资料迁移正在进行', 'BUSY');
    let job = this.store.local('materialMigration');
    if (!resume) { const preview = this.preview({ onlyPlanned, ids }); check(confirmed === true && preview.token === token, '请重新预览并确认资料迁移', 'CONFLICT'); job = { format: 2, rows: preview.rows.filter(r => !r.issue), skipped: preview.rows.filter(r => r.issue), done: [], errors: [], state: 'running' }; }
    check(job?.format === 2, '请重新预览新的可读目录迁移任务');
    job.errors = []; job.state = 'running'; this.store.local('materialMigration', job); this.running = true; this.store.materialMigrating = true;
    try {
      for (const item of job.rows) {
        if (job.done.includes(item.id)) continue;
        try {
          const record = this.store.get(item.id), local = this.store.assetLocation(item.id);
          check(record && canonical(record.heads) === canonical(item.parents) && local?.path === item.source, '资料或位置已变化，请重新预览', 'CONFLICT');
          check(!this.store.activeAssetReads?.get(item.id), '原件正在读取'); noSymlink(item.source);
          check(fs.statSync(item.source).size === item.size && await hashFile(item.source) === item.hash, '原件校验失败');
          const target = readableAssetPath(this.store, record);
          check(target === item.target && canonical(materialLocation(this.store, record.data)) === canonical(item.logical), '目标分类、名称或路径已变化，请重新预览', 'CONFLICT');
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
          check(canonical(this.store.headIds(record.id)) === canonical(item.parents) && canonical(materialLocation(this.store, this.store.get(record.id).data)) === canonical(item.logical), '复制期间资料或分类已变化，保留原绑定', 'CONFLICT');
          this.store.transaction(() => {
            this.store.bindAsset(record.id, target, local.pinned === 1);
            if (this.hierarchy?.managedOriginal(item.source) && item.source !== target) this.store.local('readableOldCopies', [...(this.store.local('readableOldCopies') || []), { relative: path.relative(this.store.directory, item.source), hash: item.hash, assetId: item.id }]);
            this.store.local('materialMigration', { ...job, done: [...job.done, item.id] });
          });
          job.done.push(item.id);
        } catch (error) { job.errors.push({ id: item.id, message: error.message }); }
        this.store.local('materialMigration', job);
      }
      job.state = job.errors.length || job.skipped?.length ? 'pending' : 'complete'; this.store.local('materialMigration', job);
      this.store.local('readableStoragePending', job.state !== 'complete'); return job;
    } finally { this.running = false; this.store.materialMigrating = false; }
  }
}
