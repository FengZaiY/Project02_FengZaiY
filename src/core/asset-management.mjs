import fs from 'node:fs';
import path from 'node:path';
import { richReferences } from './rich-content.mjs';
import { canonical, check, isId, outside, sha } from './util.mjs';
import { personalReferences, MATERIAL_SCOPE } from './personal-schema.mjs';
import { isReadableAsset, materialLocation } from './readable-storage.mjs';

const referenceCache = new WeakMap();
const nonReferencingTypes = ['asset', 'library', 'folder', 'workspace', 'model', 'provider', 'usage', 'agentPreferences'];
export function assetReferenceIndex(store) {
  const drafts = (store.local('workspace')?.tabs || []).filter(tab => tab.dirty && tab.draft);
  const businessDrafts = Object.values(store.local('personalDrafts') || {}).filter(Boolean);
  // Asset metadata batches do not change references; do not reparse all notes for each item.
  const latest = store.db.prepare(`SELECT id FROM events WHERE type NOT IN (${nonReferencingTypes.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 1`).get(...nonReferencingTypes);
  const stamp = canonical([latest?.id || null, drafts, businessDrafts]);
  const cached = referenceCache.get(store);
  if (cached?.stamp === stamp) return cached;
  const refs = new Map();
  let uncertain = false;
  const add = (record, bodies, pending = false) => {
    const ids = new Set();
    for (const data of bodies) {
      for (const id of personalReferences(data)) ids.add(id);
      for (const id of [...(data.assetIds || []), ...(data.sourceIds || []), data.from, data.to, data.noteId]) {
        if (isId(id)) ids.add(id);
      }
      try { for (const id of richReferences(data).refs) ids.add(id); }
      catch { uncertain = true; }
    }
    for (const id of ids) {
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id).push({ id: record.id, title: record.data.title, domain: record.data.domain, type: record.type,
        deleted: record.deleted === true, conflict: record.conflict === true, pending });
    }
  };
  for (const record of [...store.list(), ...store.list({ trash: true })]) {
    if (nonReferencingTypes.includes(record.type)) continue;
    const bodies = record.versions.flatMap(version => [version.data, ...(version.type === 'proposal' ? version.data.items.map(item => item.data) : [])]);
    add(record, bodies);
  }
  for (const tab of drafts) add({ id: tab.recordId, data: tab.draft, type: tab.recordType || 'note' }, [tab.draft], true);
  for (const draft of businessDrafts) add({ id: draft.id, data: draft.data, type: draft.type }, [draft.data], true);
  const result = { stamp, refs, uncertain };
  referenceCache.set(store, result);
  return result;
}

// Local writes protect known references; incoming immutable events still merge normally.
export function validateAssetChange(store, id, data, deleted) {
  const current = store.get(id);
  if (!current || ((!deleted || current.deleted) && current.versions.every(version => version.data.domain === data.domain))) return;
  const index = assetReferenceIndex(store);
  check(!index.uncertain, '部分正文引用暂时无法核验，请先处理内容格式，不能移动或回收资料', 'ASSET_REFERENCE_UNKNOWN');
  const references = (index.refs.get(id) || []).filter(ref => !store.revertingIds?.has(ref.id));
  check(!references.length, `此资料仍有 ${references.length} 处引用（含草稿、方案或回收站），请先处理引用`, 'ASSET_REFERENCED');
}

export function assetKind(data) {
  const ext = path.extname(data.filename).toLowerCase();
  if (data.mime?.startsWith('image/')) return 'image';
  if (data.mime?.startsWith('video/')) return 'video';
  if (data.mime?.startsWith('audio/')) return 'audio';
  if (data.mime?.startsWith('text/') || ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.epub'].includes(ext)) return 'document';
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive';
  return 'other';
}

export class AssetManagement {
  constructor(store) { this.store = store; }
  storage(record, local, originals) {
    if (!local) return { state: 'unbound', kind: 'unbound', label: '尚未下载到本机', path: null, directory: null, relativeDirectory: null };
    const file = path.resolve(local.path), directory = path.dirname(file);
    const withinRoot = !outside(this.store.directory, file);
    const relative = withinRoot ? path.relative(this.store.directory, file) : null;
    const parts = relative?.split(path.sep) || [];
    const projected = relative && originals[relative] === record.data.sha256;
    let kind = 'legacy', label = '已有存放位置', state = 'missing';
    if (!withinRoot) { kind = 'external'; label = '工作区外'; }
    else if (isReadableAsset(this.store, file)) { kind = 'organized'; label = '分类资料原件'; }
    else if (projected) {
      if (parts[1] === '回收站') { kind = 'trash'; label = '回收资料'; }
      else if (parts[1] === '共享资料') { kind = 'shared'; label = '共享资料'; }
      else if (parts.length > 3) { kind = 'note'; label = '笔记资料'; }
      else { kind = 'library'; label = '知识库资料'; }
    } else if (parts[0] === '.fengzai-y' && parts[1] === 'materials') { kind = 'central'; label = '集中原件'; }
    else if (parts.length === 3 && parts[1] === 'attachments') { kind = 'import'; label = '导入存放位置'; }
    else if (parts[0] === 'received-objects') { kind = 'received'; label = '接收存放位置'; }
    let previewIdentity;
    try {
      const stat = fs.statSync(file, { bigint: true });
      state = stat.isFile() && stat.size === BigInt(record.data.size) ? 'available' : 'changed';
      if (state === 'available' && stat.ino !== 0n) previewIdentity = sha(canonical([file, record.heads, record.data.sha256,
        ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]));
    } catch {}
    return { state, kind, label, path: file, directory, filename: path.basename(file), withinRoot, previewIdentity,
      relativeDirectory: withinRoot ? path.relative(this.store.directory, directory) : null };
  }
  rows(trash = false) {
    const index = assetReferenceIndex(this.store);
    const records = this.store.list({ type: 'asset', trash });
    const originals = this.store.local('hierarchyOriginals') || {};
    const groups = new Map();
    const groupKey = record => canonical([record.data.domain, record.data.sha256, record.data.size]);
    for (const record of records) groups.set(groupKey(record), (groups.get(groupKey(record)) || 0) + 1);
    return records.map(record => {
      const local = this.store.assetLocation(record.id);
      const storage = this.storage(record, local, originals);
      let organization; try { organization = materialLocation(this.store, record.data); } catch (error) { organization = { issue: error.message }; }
      return { ...record, storage, organization, available: storage.state === 'available', pinned: local?.pinned === 1, kind: assetKind(record.data),
        references: index.refs.get(record.id) || [], referencesUnknown: index.uncertain,
        duplicateCount: groups.get(groupKey(record)) || 1 };
    });
  }
  catalog({ domain, collectionId, categoryId, topicId, query = '', kind = '', availability = '', usage = '', tag = '', sort = 'updated', trash = false, offset = 0, limit = 100, directory = '' } = {}) {
    check(typeof query === 'string' && query.length <= 1000 && typeof tag === 'string', '筛选条件无效');
    check(typeof directory === 'string' && directory.length <= 32768, '目录筛选无效');
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 200, '分页范围无效');
    const scoped = this.rows(trash === true).filter(row => (!domain || row.versions.some(version => version.data.domain === domain || version.data.libraryDomains?.includes(domain))) && (!collectionId || row.versions.some(v => v.data.collectionIds?.includes(collectionId))));
    const tags = [...new Set(scoped.flatMap(row => row.data.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const term = query.trim().toLocaleLowerCase();
    const filtered = scoped.filter(row => (!categoryId || row.organization.categoryId === categoryId) && (!topicId || (topicId === ':unfiled' ? !row.data.materialTopicId : row.data.materialTopicId === topicId))
      && (!term || row.versions.some(v => [v.data.title, v.data.filename, ...v.data.tags].join('\n').toLocaleLowerCase().includes(term)))
      && (!kind || row.kind === kind) && (!tag || row.data.tags.includes(tag))
      && (!availability || (availability === 'available' ? row.available : availability === 'missing' ? !row.available : row.pinned))
      && (!usage || (usage === 'used' ? row.references.length > 0 : usage === 'unused' ? !row.references.length && !row.referencesUnknown
        : usage === 'duplicates' ? row.duplicateCount > 1 : row.conflict)));
    const directories = new Map();
    for (const row of filtered) {
      const local = row.storage, key = local.directory || ':unbound';
      if (!directories.has(key)) {
        const parts = local.relativeDirectory?.split(path.sep).filter(Boolean) || [];
        directories.set(key, { path: local.directory, relative: local.relativeDirectory,
          segments: parts.map((name, index) => ({ name, path: path.join(this.store.directory, ...parts.slice(0, index + 1)) })),
          withinRoot: local.withinRoot === true, count: 0, available: 0 });
      }
      const group = directories.get(key);
      group.count++; group.available += row.available ? 1 : 0;
    }
    const matches = filtered.filter(row => !directory || (directory === ':unbound' ? !row.storage.path
      : directory === ':external' ? row.storage.path && !row.storage.withinRoot
      : row.storage.directory && !outside(directory, row.storage.directory)));
    matches.sort((a, b) => (sort === 'name' ? a.data.title.localeCompare(b.data.title, 'zh-CN')
      : sort === 'size' ? b.data.size - a.data.size : b.updatedAt.localeCompare(a.updatedAt)) || a.id.localeCompare(b.id));
    return { total: matches.length, totalBytes: matches.reduce((sum, row) => sum + row.data.size, 0), scopedTotal: scoped.length, tags,
      storage: { root: this.store.directory, directories: [...directories.values()] },
      rows: matches.slice(offset, offset + limit).map(({ versions, references, ...row }) => ({ ...row, referenceCount: references.length })) };
  }
  detail(id) {
    const record = this.store.get(id);
    check(record?.type === 'asset', '资料不存在');
    return this.rows(record.deleted).find(row => row.id === id);
  }
  current(id, parents, deleted = false) {
    const record = this.store.get(id);
    check(record?.type === 'asset' && record.deleted === deleted, deleted ? '请选择回收站中的资料' : '资料不存在或已移入回收站');
    check(!record.conflict && Array.isArray(parents) && canonical([...parents].sort()) === canonical([...record.heads].sort()),
      '资料已发生变化，请重新打开详情或处理冲突后再操作', 'CONFLICT');
    return record;
  }
  update({ id, parents, changes }) {
    return this.store.transaction(() => this.updateRaw({ id, parents, changes }));
  }
  updateRaw({ id, parents, changes }) {
    const record = this.current(id, parents);
    check(changes && Object.keys(changes).every(key => ['title', 'tags', 'domain', 'sensitive', 'collectionIds'].includes(key)), '不允许修改原文件身份或其他字段');
    for (const id of changes.collectionIds || []) { const collection = this.store.get(id); check(collection?.type === 'materialCollection' && !collection.deleted && !collection.conflict, '资料集合不可用'); }
    const data = { ...record.data, ...changes };
    check(typeof data.title === 'string' && data.title.trim().length > 0 && data.title.length <= 500, '资料名称须为 1 至 500 个字符');
    data.title = data.title.trim();
    check(Array.isArray(data.tags) && data.tags.length <= 100 && data.tags.every(tag => typeof tag === 'string' && tag.trim() && tag.length <= 100), '标签最多 100 个，每个不超过 100 字');
    data.tags = [...new Set(data.tags.map(tag => tag.trim()))];
    check(typeof data.sensitive === 'boolean', '敏感标记无效');
    const library = this.store.libraries().find(item => item.data.domain === data.domain);
    check(data.domain === MATERIAL_SCOPE || library && !library.deleted && !library.conflict, '请选择可用知识库');
    if (data.domain !== record.data.domain) data.folderId = null;
    if (canonical(data) === canonical(record.data)) return record;
    this.store.writeRaw({ id, type: 'asset', data, parents });
    return this.store.get(id);
  }
  batch({ items, action, tags = [], domain }) {
    check(Array.isArray(items) && items.length > 0 && items.length <= 200 && new Set(items.map(item => item.id)).size === items.length, '每次选择 1 至 200 项不同资料');
    check(['addTags', 'removeTags', 'move', 'trash', 'restore'].includes(action), '不支持的批量操作');
    check(Array.isArray(tags) && tags.length <= 100 && tags.every(tag => typeof tag === 'string' && tag.trim() && tag.length <= 100), '标签格式无效');
    const normalized = [...new Set(tags.map(tag => tag.trim()))];
    check(!['addTags', 'removeTags'].includes(action) || normalized.length > 0, '请输入至少一个标签');
    return this.store.transaction(() => {
      const records = items.map(item => this.current(item.id, item.parents, action === 'restore'));
      for (const record of records) {
        if (['trash', 'restore'].includes(action)) {
          this.store.writeRaw({ id: record.id, type: 'asset', parents: record.heads, data: record.data, deleted: action === 'trash' });
        } else {
          const changes = action === 'move' ? { domain } : { tags: action === 'addTags'
            ? [...new Set([...record.data.tags, ...normalized])] : record.data.tags.filter(tag => !normalized.includes(tag)) };
          this.updateRaw({ id: record.id, parents: record.heads, changes });
        }
      }
      return { count: records.length };
    });
  }
}
