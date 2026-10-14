import { richReferences } from './rich-content.mjs';
import { canonical, check, isId, sha } from './util.mjs';

export const TRASH_TYPES = ['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'asset', 'library', 'workspace', 'conversation'];

function references(data) {
  const ids = new Set([...(data.sourceIds || []), ...(data.assetIds || []),
    data.noteId, data.from, data.to, data.parentNoteId, data.folderId, data.parentId].filter(isId));
  for (const id of richReferences(data).refs) ids.add(id);
  for (const item of data.items || []) {
    if (isId(item.targetId)) ids.add(item.targetId);
    for (const id of references(item.data || {})) ids.add(id);
  }
  return ids;
}

export function previewTrash(store, { domain = '' } = {}) {
  check(typeof domain === 'string' && domain.length <= 100, '知识库范围无效');
  const records = [...store.list(), ...store.list({ trash: true })];
  const targets = records.filter(record => record.deleted && TRASH_TYPES.includes(record.type)
    && (!domain || record.versions.every(version => version.data.domain === domain)));
  const candidates = new Set(targets.map(record => record.id)), reasons = new Map(), refs = new Map();
  let uncertain = false;
  const add = (id, owner, title) => {
    if (!refs.has(id)) refs.set(id, []);
    refs.get(id).push({ owner, title });
  };
  const scopes = new Map(records.filter(record => record.type === 'library').map(record => [record.data.domain, record.id]));
  for (const record of records) {
    for (const version of record.versions) {
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
    domain: record.data.domain, parents: record.heads, reason: reasons.get(record.id) || '' })).sort((a, b) => a.id.localeCompare(b.id));
  return { domain, total: items.length, eligible: items.filter(item => !item.reason), blocked: items.filter(item => item.reason),
    token: sha(canonical({ domain, items })) };
}

export function emptyTrash(store, { domain = '', token, confirmed } = {}) {
  check(confirmed === true, '清空回收站需要明确确认');
  return store.transaction(() => {
    const preview = previewTrash(store, { domain });
    check(token === preview.token, '回收站内容或引用已变化，请重新预览后确认', 'CONFLICT');
    for (const item of preview.eligible) store.purgeRaw(item.id, item.parents);
    const ids = preview.eligible.map(item => item.id), removed = new Set(ids);
    const workspace = store.local('workspace');
    if (workspace) {
      const tabs = (workspace.tabs || []).filter(tab => !removed.has(tab.recordId));
      store.local('workspace', { ...workspace, tabs, selectedTab: tabs.some(tab => tab.id === workspace.selectedTab) ? workspace.selectedTab : null });
    }
    return { ids, count: ids.length, skipped: preview.blocked.length };
  });
}
