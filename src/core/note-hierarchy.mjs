import { legacyNames } from './legacy-names.mjs';
import { canonical, check, sha } from './util.mjs';
import { compareNoteOrder } from './note-order.mjs';

export function noteTree(store, domain) {
  const records = store.list({ type: 'note', domain }), byId = new Map(records.map(record => [record.id, record])), result = new Map();
  function visit(record, trail = []) {
    if (result.has(record.id)) return result.get(record.id);
    if (trail.includes(record.id) || trail.length >= 16) return { issue: '笔记层级循环或超过 16 层', path: [], depth: 0 };
    let issue = record.conflict ? '笔记存在并发版本，请先对照处理' : '', parent = null;
    if (record.data.parentNoteId) {
      const candidate = byId.get(record.data.parentNoteId);
      if (!candidate || candidate.data.domain !== record.data.domain) issue ||= '上级笔记缺失、已删除或不在当前知识库';
      else {
        parent = visit(candidate, [...trail, record.id]);
        if (parent.issue) { issue ||= '上级笔记层级需要处理'; parent = null; }
      }
    }
    if (issue) parent = null;
    const node = { ...record, parentNoteId: parent?.id || null, depth: parent ? parent.depth + 1 : 0,
      path: [...(parent?.path || []), record.data.title], issue };
    result.set(record.id, node);
    return node;
  }
  records.forEach(record => visit(record));
  const children = new Map(), ordered = [];
  for (const node of result.values()) {
    const key = node.parentNoteId || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  function append(parent) {
    for (const node of (children.get(parent) || []).sort((a, b) =>
      a.data.domain.localeCompare(b.data.domain) || compareNoteOrder(a, b))) {
      ordered.push(node); append(node.id);
    }
  }
  append(null);
  return ordered;
}

export function noteDescendant(store, id, ancestor) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    if (id === ancestor) return true;
    seen.add(id); id = store.get(id)?.data.parentNoteId;
  }
  return false;
}

export function hasNoteChildren(store, id) {
  return [...store.list(), ...store.list({ trash: true })].some(record => record.id !== id && record.versions.some(version =>
    version.data.parentNoteId === id || version.data.items?.some(item => item.status === 'pending' && item.targetId !== id && item.data.parentNoteId === id)));
}

export function validateNotePlacement(store, type, data, id) {
  if (type !== 'note') return;
  const existing = store.get(id);
  if (existing && existing.data.domain !== data.domain) check(!hasNoteChildren(store, id), '此笔记仍有下级笔记或待确认层级方案，请先调整，不能单独跨知识库移动');
  const parentId = data.parentNoteId;
  if (!parentId) return;
  const parent = store.get(parentId);
  check(parent?.type === 'note' && !parent.deleted && !parent.conflict && parent.data.domain === data.domain, '上级笔记不可用或不属于当前知识库');
  check(!noteDescendant(store, parentId, id), '不能把笔记放在自身或下级笔记下面');
  const nodes = noteTree(store, data.domain), node = nodes.find(item => item.id === parentId);
  check(node && !node.issue, '请先处理上级笔记的层级问题');
  const current = nodes.find(item => item.id === id);
  const height = current ? Math.max(0, ...nodes.filter(item => noteDescendant(store, item.id, id)).map(item => item.depth - current.depth)) : 0;
  check(node.depth + 1 + height < 16, '笔记最多支持 16 层');
}

// A selected parent must be applied first, even when the agent listed the child first.
export function orderedProposalItems(store, items, itemIds) {
  const pending = items.filter(item => itemIds.includes(item.id) && item.status !== 'accepted');
  check(new Set(pending.map(item => item.targetId)).size === pending.length, '同一方案不能重复更新同一笔记');
  const selected = new Map(pending.map(item => [item.targetId, item])), done = new Set(), ordered = [];
  function visit(item, trail = new Set()) {
    if (done.has(item.id)) return;
    check(!trail.has(item.id), '方案的笔记层级存在循环');
    const next = new Set(trail); next.add(item.id);
    const parentId = item.data.parentNoteId;
    if (parentId) {
      const dependency = selected.get(parentId);
      if (dependency) visit(dependency, next);
      else {
        const parent = store.get(parentId);
        check(parent && !parent.deleted, '请同时选择尚未入库的上级笔记，或先确认上级笔记');
      }
    }
    done.add(item.id); ordered.push(item);
  }
  pending.forEach(item => visit(item));
  return ordered;
}

export function validateProposalHierarchy(store, items) {
  const targets = new Map();
  for (const item of items) {
    check(!targets.has(item.targetId), '同一方案不能重复更新同一笔记');
    targets.set(item.targetId, item);
  }
  for (const item of items.filter(entry => entry.status === 'pending')) {
    const seen = new Set([item.targetId]);
    let data = item.data;
    while (data.parentNoteId) {
      check(!seen.has(data.parentNoteId), '方案的笔记层级存在循环');
      seen.add(data.parentNoteId);
      check(seen.size <= 16, '笔记最多支持 16 层');
      const candidate = targets.get(data.parentNoteId);
      const stored = store.get(data.parentNoteId);
      const parent = candidate?.status === 'pending' ? candidate.data : stored?.data;
      check(parent && (candidate?.status === 'pending' || stored?.type === 'note' && !stored.deleted && !stored.conflict), '方案的上级笔记不可用');
      check(parent.domain === item.data.domain, '上下级笔记必须属于同一知识库');
      data = parent;
    }
  }
}

const derivedId = value => {
  const hex = sha(`${legacyNames.treeSeed}${value}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const legacyNoteId = id => derivedId(`folder:${id}`);

// Derived IDs and revision bytes are identical on every computer; original folder history stays intact.
export function migrateLegacyHierarchy(store, cleanData) {
  return store.transaction(() => {
    let count = 0;
    const add = content => {
      const event = { ...content, hash: sha(canonical(content)) };
      if (store.insert(event, false)) count++;
    };
    const old = store.allEvents().filter(event => event.type === 'folder'), pending = new Map(old.map(event => [event.id, event]));
    while (pending.size) {
      let progressed = false;
      for (const event of pending.values()) {
        if (event.parents.some(id => pending.has(id))) continue;
        add({ ...Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')),
          id: derivedId(`folder-version:${event.id}`), entityId: legacyNoteId(event.entityId), type: 'note',
          parents: event.parents.map(id => derivedId(`folder-version:${id}`)),
          data: cleanData('note', { title: event.data.title, domain: event.data.domain, content: event.data.description || '',
            format: 'markdown', sensitive: event.data.sensitive, tags: event.data.tags,
            parentNoteId: event.data.parentId ? legacyNoteId(event.data.parentId) : null }) });
        pending.delete(event.id); progressed = true;
      }
      check(progressed, '旧分级记录缺少基础版本，已停止转换');
    }
    for (const record of [...store.list({ type: 'note' }), ...store.list({ type: 'note', trash: true })]) {
      for (const event of record.versions) {
        if (!event.data.folderId || Object.hasOwn(event.data, 'parentNoteId') || !store.get(legacyNoteId(event.data.folderId))) continue;
        add({ ...Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')),
          id: derivedId(`placement:${event.id}`), parents: [event.id],
          data: cleanData('note', { ...event.data, folderId: null, parentNoteId: legacyNoteId(event.data.folderId) }) });
      }
    }
    for (const record of store.list({ type: 'proposal' })) for (const event of record.versions) {
      let changed = false;
      const items = event.data.items.map(item => {
        if (item.status !== 'pending' || !item.data.folderId || Object.hasOwn(item.data, 'parentNoteId') || !store.get(legacyNoteId(item.data.folderId))) return item;
        changed = true;
        return { ...item, data: { ...item.data, folderId: null, parentNoteId: legacyNoteId(item.data.folderId) } };
      });
      if (changed) add({ ...Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')),
        id: derivedId(`proposal-placement:${event.id}`), parents: [event.id], data: cleanData('proposal', { ...event.data, items }) });
    }
    return count;
  });
}
