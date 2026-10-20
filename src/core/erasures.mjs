import { canonical, check, isHash, isId, now, sha, uuid } from './util.mjs';
import { TYPES, RETIRED_AI_TYPES } from './catalog.mjs';

// Independent receipts allow us to remove payloads without rewriting old event hashes.
export function validateErasure(value) {
  check(value?.format === 1 && isId(value.id) && isId(value.entityId) && isId(value.deviceId)
    && TYPES.includes(value.type) && Number.isFinite(Date.parse(value.at)), '永久删除凭据无效');
  const fields = ['at', 'deviceId', 'entityId', 'format', 'hash', 'id', 'type', 'versions'];
  if (Object.hasOwn(value, 'purpose')) {
    check(value.purpose === 'retired-ai' && [...RETIRED_AI_TYPES, 'workspace'].includes(value.type), '退役清理凭据用途无效');
    fields.push('purpose');
  }
  check(Object.keys(value).sort().join() === fields.sort().join(), '永久删除凭据含未知字段');
  check(Array.isArray(value.versions) && value.versions.length > 0, '永久删除凭据缺少版本');
  const ids = new Set();
  for (const item of value.versions) {
    check(Object.keys(item).sort().join() === 'hash,id' && isId(item.id) && isHash(item.hash) && !ids.has(item.id), '永久删除版本无效');
    ids.add(item.id);
  }
  const { hash, ...body } = value;
  check(isHash(hash) && hash === sha(canonical(body)), '永久删除凭据校验失败');
  return value;
}

export function mergeErasures(...groups) {
  const receipts = new Map(), versions = new Map(), types = new Map();
  for (const value of groups.flat()) {
    validateErasure(value);
    check(!types.has(value.entityId) || types.get(value.entityId) === value.type, '永久删除实体类型冲突'); types.set(value.entityId, value.type);
    check(!receipts.has(value.id) || receipts.get(value.id).hash === value.hash, '永久删除凭据身份冲突');
    for (const item of value.versions) {
      const identity = `${value.entityId}:${value.type}:${item.hash}`;
      check(!versions.has(item.id) || versions.get(item.id) === identity, '永久删除版本身份冲突');
      versions.set(item.id, identity);
    }
    receipts.set(value.id, value);
  }
  return [...receipts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function filterErased(events, receipts) {
  check(Array.isArray(events), '修改记录格式无效');
  const entities = new Map();
  for (const receipt of mergeErasures(receipts)) {
    if (!entities.has(receipt.entityId)) entities.set(receipt.entityId, new Map());
    for (const item of receipt.versions) entities.get(receipt.entityId).set(item.id, { hash: item.hash, type: receipt.type });
  }
  return events.filter(event => {
    const versions = entities.get(event.entityId);
    if (!versions) return true;
    const known = versions.get(event.id);
    check(known, '永久删除与另一台电脑的新修改冲突；同步已暂停，请在保有新修改的电脑将内容另存为新笔记后再处理', 'ERASURE_CONFLICT');
    check(known.hash === event.hash && known.type === event.type, '永久删除版本校验不匹配');
    return false;
  });
}

export function createErasure(store, id) {
  const events = store.allEvents().filter(event => event.entityId === id);
  check(events.length > 0, '待清空内容已变化', 'CONFLICT');
  const body = { format: 1, id: uuid(), entityId: id, type: events[0].type, deviceId: store.deviceId, at: now(),
    versions: events.map(({ id, hash }) => ({ id, hash })).sort((a, b) => a.id.localeCompare(b.id)) };
  return { ...body, hash: sha(canonical(body)) };
}
