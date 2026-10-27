import { canonical, check, now, sha } from './util.mjs';

export function withoutPresentation(type, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (type === 'note' || type === 'draft') {
    const { presentation, ...body } = data;
    return body;
  }
  if (type === 'proposal' && Array.isArray(data.items)) return { ...data, items: data.items.map(item =>
    item?.data ? { ...item, data: withoutPresentation('note', item.data) } : item) };
  if (type === 'workspace' && Array.isArray(data.tabs)) return { ...data, tabs: data.tabs.map(tab =>
    tab?.draft ? { ...tab, draft: withoutPresentation('note', tab.draft) } : tab) };
  return data;
}

// Callers validate the original before this deterministic, narrowly scoped retirement.
// IDs and parent references stay stable; the original checksum is retained without its payload.
export function retirePresentation(event) {
  const data = withoutPresentation(event.type, event.data);
  if (canonical(data) === canonical(event.data)) return event;
  check(!event.retiredPresentation, '退役记录仍含交互阅读数据', 'INVALID');
  const { hash, ...original } = event;
  const body = { ...original, data, retiredPresentation: hash };
  return { ...body, hash: sha(canonical(body)) };
}

export const sourceRevisionHash = event => event.retiredPresentation || event.hash;
export const sameRevision = (left, right) => sourceRevisionHash(left) === sourceRevisionHash(right)
  && retirePresentation(left).hash === retirePresentation(right).hash;

export function migratePresentation(store, validateEvent) {
  let changed = 0;
  const cleanCache = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cleanCache);
    if (value.schema === 1 && value.hash && value.entityId) {
      validateEvent(value);
      return retirePresentation(value);
    }
    let cleaned = value;
    if (value.type && value.data) cleaned = { ...value, data: withoutPresentation(value.type, value.data) };
    if (Array.isArray(cleaned.tabs)) cleaned = withoutPresentation('workspace', cleaned);
    return Object.fromEntries(Object.entries(cleaned).map(([key, item]) => [key, cleanCache(item)]));
  };
  store.transaction(() => {
    for (const table of ['events', 'pending', 'rejected']) {
      for (const row of store.db.prepare(`SELECT id,json FROM ${table}`).all()) {
        const event = JSON.parse(row.json);
        if (canonical(withoutPresentation(event.type, event.data)) === canonical(event.data)) continue;
        validateEvent(event);
        const next = retirePresentation(event); validateEvent(next);
        store.db.prepare(`UPDATE ${table} SET json=? WHERE id=?`).run(JSON.stringify(next), row.id);
        changed++;
      }
    }
    for (const row of store.db.prepare('SELECT key,value FROM local_config').all()) {
      // Skip unrelated settings, secrets and large receive indexes.
      if (!row.value.includes('"presentation"')) continue;
      const value = JSON.parse(row.value), cleaned = cleanCache(value);
      if (canonical(value) === canonical(cleaned)) continue;
      if (/^v3:.*:plan$/.test(row.key)) {
        store.local(row.key, null);
        store.local(row.key.replace(/:plan$/, ':progress'), { state: 'cancelled', reason: '交互阅读已移除，请重新进行空间预估和发布' });
      } else store.local(row.key, cleaned);
      changed++;
    }
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_requests'").get()) {
      for (const row of store.db.prepare('SELECT grant_id,request_id,result FROM agent_requests').all()) {
        if (!row.result.includes('"presentation"')) continue;
        const result = JSON.parse(row.result), cleaned = cleanCache(result);
        if (canonical(result) === canonical(cleaned)) continue;
        store.db.prepare('UPDATE agent_requests SET result=? WHERE grant_id=? AND request_id=?')
          .run(JSON.stringify(cleaned), row.grant_id, row.request_id);
        changed++;
      }
    }
    if (changed) {
      store.setMeta('presentationRetired', 1);
      store.local('hierarchyDirty', true);
      store.local('presentationRetirement', { at: now(), changed, pending: true });
    }
  });
  return changed;
}
