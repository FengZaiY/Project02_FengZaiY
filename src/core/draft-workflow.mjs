import { canonical, check, isId, sha } from './util.mjs';

const workflowCache = new WeakMap();

export function cleanDraftRefs(refs) {
  check(Array.isArray(refs) && refs.length <= 100, '草稿关联最多 100 项');
  const seen = new Set();
  return refs.map(ref => {
    check(ref && isId(ref.id) && isId(ref.versionId) && !seen.has(ref.id), '草稿关联需要唯一标识及修改版本');
    check(ref.complete === undefined || typeof ref.complete === 'boolean', '草稿覆盖范围必须为布尔值');
    seen.add(ref.id);
    return { id: ref.id, versionId: ref.versionId, ...(ref.complete !== undefined ? { complete: ref.complete } : {}) };
  });
}

export function requireSaved(store, ids) {
  check(!(store.local('workspace')?.tabs || []).some(tab => tab.dirty && ids.includes(tab.recordId)),
    '相关草稿或目标笔记有未保存编辑，请先保存后再归档', 'CONFLICT');
}

export function validateDraftRefs(store, refs = []) {
  for (const ref of refs) {
    const draft = store.get(ref.id), version = store.event(ref.versionId);
    check(draft?.type === 'draft' && !draft.deleted && !draft.conflict && version?.entityId === ref.id,
      '来源草稿缺失、已回收或存在冲突，请重新核对', 'CONFLICT');
    check(draft.heads.length === 1 && draft.heads[0] === ref.versionId, '来源草稿已修改，请重新整理并关联最新版本', 'CONFLICT');
    requireSaved(store, [ref.id]);
  }
}

// Completion is derived from reviewed evidence, never from a model-written status.
export function draftWorkflows(store) {
  const stamp = store.db.prepare('SELECT id FROM events ORDER BY rowid DESC LIMIT 1').get()?.id;
  const cached = workflowCache.get(store);
  if (cached && cached.stamp === stamp) return cached.entries;
  const records = [...store.list(), ...store.list({ trash: true })];
  const byId = new Map(records.map(record => [record.id, record]));
  const entries = new Map();
  for (const draft of records.filter(record => record.type === 'draft')) {
    entries.set(draft.id, { status: 'pending', results: [], proposals: [], heads: draft.heads, conflict: draft.conflict });
  }
  const current = (entry, ref) => !entry.conflict && entry.heads.length === 1 && entry.heads[0] === ref.versionId;
  const available = id => { const note = byId.get(id); return note?.type === 'note' && !note.deleted && !note.conflict; };
  for (const note of records.filter(record => record.type === 'note')) {
    for (const version of note.versions) {
      const ref = version.data.draftOrigin, entry = ref && entries.get(ref.id);
      if (!entry) continue;
      const active = current(entry, ref), usable = available(note.id);
      entry.results.push({ noteId: note.id, title: note.data.title, current: active, available: usable, direct: true });
      if (active && usable) entry.status = 'processed';
    }
  }
  for (const proposal of records.filter(record => record.type === 'proposal')) {
    for (const version of proposal.versions) {
      const grouped = new Map();
      for (const item of version.data.items) for (const ref of item.draftRefs || []) {
        const entry = entries.get(ref.id); if (!entry) continue;
        const active = current(entry, ref);
        const receipt = item.acceptedVersionId && store.event(item.acceptedVersionId);
        const accepted = item.status === 'accepted' && receipt?.entityId === item.targetId && receipt.type === 'note';
        const usable = accepted && available(item.targetId) && !proposal.conflict;
        if (accepted) entry.results.push({ noteId: item.targetId, title: byId.get(item.targetId)?.data.title || item.data.title,
          versionId: receipt.id, proposalId: proposal.id, current: active, available: !!usable, direct: false });
        if (!grouped.has(ref.id)) grouped.set(ref.id, []);
        grouped.get(ref.id).push({ active, usable, accepted, complete: ref.complete === true });
      }
      for (const [id, items] of grouped) {
        const entry = entries.get(id);
        entry.proposals.push({ id: proposal.id, title: proposal.data.title, current: items.every(item => item.active),
          deleted: proposal.deleted, conflict: proposal.conflict, accepted: items.filter(item => item.accepted).length, total: items.length });
        if (entry.status === 'processed') continue;
        const activeItems = items.filter(item => item.active);
        if (activeItems.some(item => item.complete) && activeItems.every(item => item.usable)) entry.status = 'processed';
        else if (activeItems.some(item => item.usable)) entry.status = 'partial';
      }
    }
  }
  for (const entry of entries.values()) {
    entry.results = [...new Map(entry.results.map(result => [`${result.noteId}:${result.versionId || ''}:${result.current}`, result])).values()];
  }
  workflowCache.set(store, { stamp, entries });
  return entries;
}

export function archiveDraft(store, { id, parents, domain, parentNoteId = null }) {
  return store.transaction(() => {
    const draft = store.get(id);
    check(draft?.type === 'draft' && !draft.deleted && !draft.conflict, '请选择无冲突的草稿');
    check(Array.isArray(parents) && canonical([...parents].sort()) === canonical(draft.heads), '草稿已修改，请重新确认', 'CONFLICT');
    validateDraftRefs(store, [{ id, versionId: draft.heads[0] }]);
    const library = store.libraries().find(record => record.data.domain === domain);
    check(library && !library.deleted && !library.conflict, '请选择可用知识库');
    const hash = sha(`draft-archive:${id}:${draft.heads[0]}`);
    const targetId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const existing = store.get(targetId);
    if (existing) {
      check(!existing.deleted && !existing.conflict && existing.data.domain === domain && (existing.data.parentNoteId || null) === parentNoteId,
        '此版本已归档，请查看已有结果或处理冲突', 'CONFLICT');
      return existing;
    }
    const { folderId, ...data } = draft.data;
    store.writeRaw({ id: targetId, type: 'note', data: { ...data, domain, parentNoteId,
      sourceIds: [...new Set([...(data.sourceIds || []), id])], draftOrigin: { id, versionId: draft.heads[0] } } });
    return store.get(targetId);
  });
}
