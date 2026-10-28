import path from 'node:path';
import { canonical, check, isId, uuid } from './util.mjs';
import { cleanPersonal, PERSONAL_SCOPE } from './personal-schema.mjs';
import { requireSaved } from './draft-workflow.mjs';

export function cleanMaterialItems(items) {
  check(Array.isArray(items) && items.length <= 200, '资料方案最多 200 项');
  const ids = new Set(), targets = new Set();
  return items.map(item => {
    check(item && ['materialCategory', 'materialTopic', 'asset'].includes(item.type) && isId(item.id) && isId(item.targetId)
      && !ids.has(item.id) && !targets.has(item.targetId), '资料方案项身份重复或无效');
    ids.add(item.id); targets.add(item.targetId);
    check(Array.isArray(item.parents) && item.parents.every(isId), '资料方案缺少基础版本');
    check(item.status === 'pending' || item.status === 'accepted', '资料方案状态无效');
    check(item.reason === undefined || typeof item.reason === 'string' && item.reason.length <= 4000, '资料方案理由无效');
    check(item.acceptedVersionId === undefined || item.status === 'accepted' && isId(item.acceptedVersionId), '确认版本无效');
    let data;
    if (item.type === 'asset') {
      check(item.data && Object.keys(item.data).every(key => ['materialTopicId', 'managedFilename'].includes(key)), '资料方案只允许调整主题与实际文件名');
      check(item.data.materialTopicId === null || isId(item.data.materialTopicId), '资料主题无效');
      data = { ...item.data }; validateManagedFilename(data.managedFilename);
    } else data = cleanPersonal(item.type, item.data);
    return { id: item.id, targetId: item.targetId, type: item.type, parents: item.parents, data, status: item.status,
      ...(item.reason !== undefined ? { reason: item.reason } : {}), ...(item.acceptedVersionId ? { acceptedVersionId: item.acceptedVersionId } : {}) };
  });
}
export function validateManagedFilename(name, original) {
  if (name === undefined) return;
  check(typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[<>:"/\\|?*\x00-\x1f]/.test(name)
    && !/[. ]$/.test(name) && !name.startsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), '文件名包含不可用字符');
  if (original) check(path.extname(name).toLowerCase() === path.extname(original).toLowerCase(), '不能改变原文件扩展名');
}
export function validateMaterialPlacement(store, type, data) {
  if (type !== 'asset') return;
  validateManagedFilename(data.managedFilename, data.filename);
  if (data.materialTopicId) {
    const topic = store.get(data.materialTopicId), category = topic && store.get(topic.data.materialCategoryId);
    check(topic?.type === 'materialTopic' && !topic.deleted && !topic.conflict && category?.type === 'materialCategory' && !category.deleted && !category.conflict, '资料主题或分类不可用', 'CONFLICT');
  }
}
export function proposedMaterials(store, raw) {
  check(Array.isArray(raw) && raw.length <= 200, '资料方案最多 200 项');
  const keys = new Map();
  for (const item of raw) if (item.key !== undefined) {
    check(/^[a-zA-Z0-9_-]{1,80}$/.test(item.key) && !keys.has(item.key), '资料方案 key 必须唯一'); keys.set(item.key, item.targetId || uuid());
  }
  return cleanMaterialItems(raw.map(item => {
    const existing = item.targetId && store.get(item.targetId);
    check(!item.targetId || existing?.type === item.type && !existing.deleted && !existing.conflict, '资料方案目标不存在或有冲突');
    check(item.type !== 'asset' || existing, '请先通过 MCP 导入原件，再提出整理方案');
    check(!existing || canonical(item.parents?.slice().sort()) === canonical(existing.heads), '资料方案基础版本已变化', 'CONFLICT');
    check(existing || !item.parents?.length, '新分类或主题不可指定基础版本');
    const data = { ...item.data };
    for (const [key, field] of [['categoryKey', 'materialCategoryId'], ['topicKey', 'materialTopicId']]) if (item[key] !== undefined) {
      check(keys.has(item[key]), '资料方案依赖不存在'); data[field] = keys.get(item[key]);
    }
    if (item.type !== 'asset') data.domain = PERSONAL_SCOPE;
    if (existing?.data.sensitive && item.type !== 'asset') data.sensitive = true;
    return { id: uuid(), targetId: existing?.id || keys.get(item.key) || uuid(), type: item.type, data, parents: existing?.heads || [], status: 'pending', ...(item.reason !== undefined ? { reason: item.reason } : {}) };
  }));
}
export function approveMaterialItems(store, items, selectedIds) {
  const pending = items.filter(item => item.status === 'pending' && selectedIds.includes(item.id));
  const selected = new Map(pending.map(item => [item.targetId, item])), done = new Set();
  const apply = (item, visiting = new Set()) => {
    if (done.has(item.id)) return;
    check(!visiting.has(item.id), '资料方案依赖存在循环');
    visiting.add(item.id);
    const dependency = item.data.materialCategoryId || item.data.materialTopicId;
    if (dependency && selected.has(dependency)) apply(selected.get(dependency), visiting);
    else if (dependency) { const record = store.get(dependency); check(record && !record.deleted && !record.conflict, '请同时选择尚未入库的分类或主题'); }
    requireSaved(store, [item.targetId]);
    const current = store.get(item.targetId);
    const data = item.type === 'asset' ? { ...current?.data, ...item.data, centralized: true } : item.data;
    const event = store.writeRaw({ id: item.targetId, type: item.type, parents: item.parents, data });
    item.status = 'accepted'; item.acceptedVersionId = event.id; done.add(item.id);
  };
  pending.forEach(item => apply(item));
  if (pending.length) { store.local('readableStoragePending', true); store.local('hierarchyDirty', true); }
}
