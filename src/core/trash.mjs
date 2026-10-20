import { richReferences } from './rich-content.mjs';
import { canonical, check, isId, sha } from './util.mjs';
import { createErasure, filterErased } from './erasures.mjs';
import { deletionFiles, scheduleDeletion } from './permanent-files.mjs';
import { retiredAI } from './retired-ai.mjs';

export const TRASH_TYPES = ['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'asset', 'library', 'workspace', 'conversation'];

export function references(data) {
  const ids = new Set([...(data.sourceIds || []), ...(data.assetIds || []),
    data.noteId, data.from, data.to, data.parentNoteId, data.folderId, data.parentId].filter(isId));
  for (const id of richReferences(data).refs) ids.add(id);
  if (data.draftOrigin) ids.add(data.draftOrigin.id);
  for (const item of data.items || []) {
    for (const ref of item.draftRefs || []) ids.add(ref.id);
    if (isId(item.targetId)) ids.add(item.targetId);
    for (const id of references(item.data || {})) ids.add(id);
  }
  return ids;
}

export function previewTrash(store, { domain = '', legacyOnly = false } = {}) {
  check(typeof domain === 'string' && domain.length <= 100, '知识库范围无效');
  check(typeof legacyOnly === 'boolean', '残留清理范围无效');
  const records = [...store.list(), ...store.list({ trash: true })];
  // Earlier releases hid cleared entries but retained their bodies. Require a new confirmation.
  const events = store.allEvents(), known = new Set(records.map(record => record.id));
  for (const event of events) if (!known.has(event.entityId) && store.isPurged(event.entityId)) {
    const versions = store.headIds(event.entityId).map(id => store.event(id));
    records.push({ id: event.entityId, type: event.type, data: versions[0].data, heads: versions.map(e => e.id),
      versions, deleted: true, conflict: false, legacyCleared: true });
    known.add(event.entityId);
  }
  const targets = records.filter(record => record.deleted && TRASH_TYPES.includes(record.type)
    && (!legacyOnly || record.legacyCleared)
    && (!domain || record.versions.every(version => version.data.domain === domain)));
  const candidates = new Set(targets.map(record => record.id)), reasons = new Map(), refs = new Map();
  // Include only attachments actually used by the selected history; unrelated materials stay intact.
  for (const event of events.filter(event => candidates.has(event.entityId))) {
    for (const id of references(event.data)) {
      const asset = records.find(record => record.id === id && record.type === 'asset');
      if (asset && !candidates.has(id) && (!domain || asset.versions.every(v => v.data.domain === domain))) {
        targets.push({ ...asset, implicitAsset: true }); candidates.add(id);
      }
    }
  }
  let uncertain = false;
  const add = (id, owner, title) => {
    if (!refs.has(id)) refs.set(id, []);
    refs.get(id).push({ owner, title });
  };
  const scopes = new Map(records.filter(record => record.type === 'library').map(record => [record.data.domain, record.id]));
  for (const record of records) {
    for (const version of events.filter(event => event.entityId === record.id)) {
      try {
        for (const id of references(version.data)) if (id !== record.id) add(id, record.id, record.data.title);
      } catch { uncertain = true; }
      const library = scopes.get(version.data.domain);
      if (library && library !== record.id && record.type !== 'workspace') add(library, record.id, record.data.title);
    }
  }
  for (const tab of store.local('workspace')?.tabs || []) {
    if (!tab.dirty) continue;
    if (candidates.has(tab.recordId)) reasons.set(tab.recordId, '存在未保存编辑，请先处理对应工作标签');
    try {
      for (const id of references(tab.draft || {})) add(id, null, '未保存编辑');
      const library = scopes.get(tab.draft?.domain || tab.domain);
      if (library) add(library, null, '未保存编辑');
    } catch { uncertain = true; }
  }
  for (const record of targets) {
    if (record.conflict) reasons.set(record.id, '存在并发版本，请先处理冲突');
    else if (store.activeAssetReads?.get(record.id)) reasons.set(record.id, '原文件正在读取，请关闭预览后再试');
    else if (uncertain) reasons.set(record.id, '部分内容引用无法核验，请先处理内容格式');
    else if (store.db.prepare("SELECT 1 FROM pending WHERE json_extract(json,'$.entityId')=?").get(record.id)) reasons.set(record.id, '有未接收完整的修改，请先处理同步');
  }
  // A blocked item continues to protect its dependencies, including other trash items.
  let changed;
  do {
    changed = false;
    for (const record of targets) {
      if (reasons.has(record.id)) continue;
      const incoming = (refs.get(record.id) || []).find(ref => !candidates.has(ref.owner) || reasons.has(ref.owner));
      if (incoming) { reasons.set(record.id, `仍被“${incoming.title}”引用`); changed = true; }
    }
  } while (changed);
  const items = targets.map(record => ({ id: record.id, title: record.data.title, type: record.type,
    domain: record.data.domain, parents: record.heads, legacyCleared: !!record.legacyCleared,
    implicitAsset: !!record.implicitAsset, reason: reasons.get(record.id) || '' })).sort((a, b) => a.id.localeCompare(b.id));
  const files = deletionFiles(store, items.filter(item => !item.reason).map(item => item.id));
  return { domain, legacyOnly, total: items.length, eligible: items.filter(item => !item.reason), blocked: items.filter(item => item.reason),
    files, estimatedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    token: sha(canonical({ domain, legacyOnly, items, files })) };
}

export function emptyTrash(store, { domain = '', legacyOnly = false, token, confirmed } = {}) {
  check(confirmed === true, '清空回收站需要明确确认');
  return store.transaction(() => {
    const preview = previewTrash(store, { domain, legacyOnly });
    check(token === preview.token, '回收站内容或引用已变化，请重新预览后确认', 'CONFLICT');
    const ids = preview.eligible.map(item => item.id);
    const receipts = ids.map(id => createErasure(store, id));
    scheduleDeletion(store, ids, preview.files);
    store.eraseRaw(receipts);
    return { ids, count: ids.length, skipped: preview.blocked.length };
  });
}

export function prepareRemoteErasure(store, receipts, incoming = []) {
  if (!receipts.length) return { ids: [], files: [] };
  const retained = filterErased([...store.allEvents(), ...incoming], receipts);
  const ids = [...new Set(receipts.map(item => item.entityId))];
  const removed = new Set(receipts.filter(item => !retiredAI(item.type)).map(item => item.entityId));
  for (const event of retained) {
    check(![...references(event.data)].some(id => removed.has(id)), '永久删除内容仍被另一台电脑的笔记或历史引用，请先处理引用', 'ERASURE_CONFLICT');
  }
  for (const tab of store.local('workspace')?.tabs || []) if (tab.dirty) {
    check(!removed.has(tab.recordId) && ![...references(tab.draft || {})].some(id => removed.has(id)), '永久删除涉及未保存编辑，请先处理工作标签', 'UNSAVED');
  }
  check(!ids.some(id => store.activeAssetReads?.get(id)), '永久删除原件正在读取，请先关闭预览', 'BUSY');
  return { ids, files: deletionFiles(store, ids) };
}
