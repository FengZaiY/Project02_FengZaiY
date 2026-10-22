import { canonical, check, sha } from './util.mjs';

// Keep canonical() unchanged: it is also the checksum contract for old records.
export function persistentRevisionData(value) {
  const ancestors = new Set();
  let nodes = 0;
  const visit = (item, depth) => {
    check(++nodes <= 100000 && depth <= 64, '修改记录结构过大或嵌套过深');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { check(Number.isFinite(item), '修改记录不能包含非有限数值'); return item; }
    check(item && typeof item === 'object', '修改记录包含无法保存的值');
    check(!ancestors.has(item), '修改记录不能包含循环引用');
    check(Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)), '修改记录必须使用普通 JSON 对象');
    check(Object.getOwnPropertySymbols(item).length === 0, '修改记录不能包含 Symbol 字段');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    check(Object.values(descriptors).every(property => !property.get && !property.set), '修改记录不能包含动态属性');
    let result;
    if (Array.isArray(item)) {
      check(item.length <= 100000, '修改记录数组过长');
      result = Array.from({ length: item.length }, (_, index) => descriptors[index]?.value === undefined ? null : visit(descriptors[index].value, depth + 1));
    } else {
      result = Object.fromEntries(Object.entries(descriptors).filter(([, property]) => property.enumerable && property.value !== undefined)
        .map(([key, property]) => [key, visit(property.value, depth + 1)]));
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}

// Only fields accepted as optional by the original schema can be reconstructed.
const optional = {
  note: ['content', 'format', 'sourceIds', 'assetIds', 'presentation'],
  draft: ['content', 'format', 'sourceIds', 'assetIds', 'presentation'],
  source: ['content', 'format', 'url', 'assetIds'],
  annotation: ['content', 'noteId', 'quote'],
  agentPreferences: ['content'],
  relation: ['from', 'to', 'description'],
  proposal: ['content'],
  workspace: ['selectedTab', 'originDevice', 'tabs'],
  asset: ['mime'], folder: ['description'],
  model: ['inputRate', 'outputRate', 'currency', 'capabilities'],
  usage: ['taskId', 'modelId', 'usageReported', 'estimatedCost', 'billedCost', 'currency', 'recordedAt', 'pricing'],
  task: ['content', 'modelId', 'status', 'estimate', 'currency', 'sourceIds', 'pricing']
};
const cache = new Map();
const MAX_ATTEMPTS = 1024, MAX_BYTES = 32 * 1024 * 1024, MAX_SLOTS = 64;

export function revisionChecksum(event) {
  const { hash, ...content } = event, text = canonical(content), actual = sha(text);
  if (actual === hash) return { kind: 'exact' };
  const cacheKey = `${hash}:${actual}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const candidate = JSON.parse(JSON.stringify(content)), slots = [];
  const add = (object, keys, prefix) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return;
    for (const key of keys) if (!Object.hasOwn(object, key) && slots.length < MAX_SLOTS) slots.push({ object, key, path: `${prefix}.${key}` });
  };
  add(candidate.data, optional[event.type] || [], 'data');
  if (event.type === 'workspace' && Array.isArray(candidate.data.tabs)) {
    candidate.data.tabs.slice(0, MAX_SLOTS).forEach((tab, index) => add(tab, ['scroll', 'title', 'domain', 'recordId', 'id'], `data.tabs.${index}`));
  }
  if (event.type === 'proposal') candidate.data.items?.slice(0, MAX_SLOTS).forEach((item, index) => add(item.data, optional.note, `data.items.${index}.data`));
  if (['usage', 'task'].includes(event.type)) add(candidate.data.pricing,
    ['reason', 'currency', 'inputRate', 'outputRate', 'basis', 'sourceUrl', 'checkedAt', 'updatedAt'], 'data.pricing');
  let attempts = 0, result = { kind: 'invalid' };
  const budget = Math.min(MAX_ATTEMPTS, Math.floor(MAX_BYTES / (Buffer.byteLength(text) + MAX_SLOTS * 64)));
  const chosen = [];
  const search = (start, remaining) => {
    if (attempts >= budget) return false;
    if (!remaining) {
      attempts++;
      if (sha(canonical(candidate)) !== hash) return false;
      result = { kind: 'legacy-undefined', fields: chosen.map(slot => slot.path) };
      return true;
    }
    for (let index = start; index <= slots.length - remaining && attempts < budget; index++) {
      const slot = slots[index];
      Object.defineProperty(slot.object, slot.key, { value: undefined, enumerable: true, configurable: true });
      chosen.push(slot);
      const found = search(index + 1, remaining - 1);
      chosen.pop(); delete slot.object[slot.key];
      if (found) return true;
    }
    return false;
  };
  // Prefer the smallest proven omission. Search is bounded even for hostile histories.
  for (let count = 1; count <= slots.length && attempts < budget; count++) if (search(0, count)) break;
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, result);
  return result;
}
