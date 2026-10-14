import { check } from './util.mjs';

export const placedTypes = ['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'asset'];
const normalName = name => name.trim().normalize('NFKC').toLocaleLowerCase();

// Invalid concurrent structures remain visible at the root without rewriting shared history.
export function folderTree(store, domain) {
  const records = store.list({ type: 'folder', domain });
  const byId = new Map(records.map(record => [record.id, record]));
  const siblings = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.data.domain, record.data.parentId || null, normalName(record.data.title)]);
    siblings.set(key, (siblings.get(key) || 0) + 1);
  }
  const result = new Map();
  function visit(record, trail = []) {
    if (result.has(record.id)) return result.get(record.id);
    let issue = record.conflict ? '目录存在并发修改' : '', parent = null;
    if (siblings.get(JSON.stringify([record.data.domain, record.data.parentId || null, normalName(record.data.title)])) > 1) issue ||= '存在并发创建的同名目录，请改名区分';
    if (trail.includes(record.id) || trail.length >= 16) return { id: record.id, issue: '目录循环或层级过深', path: [], depth: 0 };
    if (record.data.parentId) {
      const candidate = byId.get(record.data.parentId);
      if (!candidate || candidate.data.domain !== record.data.domain) issue ||= '上级目录缺失或不属于当前知识库';
      else {
        parent = visit(candidate, [...trail, record.id]);
        if (parent.issue) { issue ||= '上级目录需要处理'; parent = null; }
      }
    }
    if (issue) parent = null;
    const node = { ...record, parentId: parent?.id || null, depth: parent ? parent.depth + 1 : 0,
      path: [...(parent?.path || []), record.data.title], issue };
    result.set(record.id, node);
    return node;
  }
  records.forEach(record => visit(record));
  return [...result.values()].sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), 'zh-CN') || a.id.localeCompare(b.id));
}

export function isDescendant(store, id, ancestor) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    if (id === ancestor) return true;
    seen.add(id); id = store.get(id)?.data.parentId;
  }
  return false;
}

export function validatePlacement(store, type, data, id) {
  if (type !== 'folder' && !placedTypes.includes(type)) return;
  const parentId = type === 'folder' ? data.parentId : data.folderId;
  if (parentId) {
    const parent = store.get(parentId);
    check(parent?.type === 'folder' && !parent.deleted && !parent.conflict && parent.data.domain === data.domain,
      '目标文件夹不可用或不属于当前知识库');
    const nodes = folderTree(store, data.domain), node = nodes.find(item => item.id === parentId);
    check(node && !node.issue, '请先处理目标目录结构');
    if (type === 'folder') {
      check(!isDescendant(store, parentId, id), '不能把文件夹放入自身或其下级目录');
      const current = nodes.find(item => item.id === id);
      const height = current ? Math.max(0, ...nodes.filter(item => isDescendant(store, item.id, id)).map(item => item.depth - current.depth)) : 0;
      check(node.depth + 1 + height < 16, '目录最多支持 16 层');
    }
  }
  if (type === 'folder') {
    check(!store.get(id) || store.get(id).data.domain === data.domain, '文件夹不能直接跨知识库移动');
    check(!store.list({ type: 'folder', domain: data.domain }).some(record => record.id !== id
      && record.versions.some(version => !version.deleted && (version.data.parentId || null) === (parentId || null)
        && normalName(version.data.title) === normalName(data.title))), '同级目录已存在同名文件夹');
  }
}

export function folderEmpty(store, id) {
  return ![...store.list(), ...store.list({ trash: true })].some(record => record.id !== id && record.versions.some(version =>
    version.data.folderId === id || version.data.parentId === id || version.data.items?.some(item => item.status === 'pending' && item.data.folderId === id)));
}
