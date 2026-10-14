import { validateEvent } from './store.mjs';
import { canonical, check, isId } from './util.mjs';

export const EMPTY_CONTROL = { devices: [], roles: [] };

export function eventHeads(events) {
  const parents = new Set(events.flatMap(event => event.parents));
  return events.filter(event => !parents.has(event.id));
}

export function mergeControl(left = EMPTY_CONTROL, right = EMPTY_CONTROL) {
  const union = field => {
    check(Array.isArray(left[field]) && Array.isArray(right[field]), 'Invalid device registry');
    const values = new Map();
    for (const item of [...left[field], ...right[field]]) {
      check(item && isId(item.id) && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)), 'Invalid device entry');
      if (field === 'devices') {
        check(Object.keys(item).sort().join() === 'at,deviceId,id,name' && isId(item.deviceId)
          && typeof item.name === 'string' && item.name.length <= 100, 'Invalid device name');
      } else {
        check(Object.keys(item).sort().join() === 'at,id,parents,primary' && isId(item.primary)
          && Array.isArray(item.parents) && item.parents.every(isId) && !item.parents.includes(item.id), 'Invalid primary role');
      }
      check(!values.has(item.id) || canonical(values.get(item.id)) === canonical(item), 'Device entry collision');
      values.set(item.id, item);
    }
    return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  const result = { devices: union('devices'), roles: union('roles') };
  const devices = new Set(result.devices.map(item => item.deviceId));
  check(result.roles.every(role => devices.has(role.primary)), 'Primary device is not registered');
  const known = new Set(result.roles.map(item => item.id));
  check(result.roles.every(role => role.parents.every(id => known.has(id))), 'Missing primary role parent');
  const done = new Set();
  while (done.size < result.roles.length) {
    const ready = result.roles.filter(role => !done.has(role.id) && role.parents.every(id => done.has(id)));
    check(ready.length, 'Cyclic primary roles');
    ready.forEach(role => done.add(role.id));
  }
  return result;
}

export function primaryRole(control) {
  const roles = mergeControl(EMPTY_CONTROL, control).roles;
  const parents = new Set(roles.flatMap(role => role.parents));
  const heads = roles.filter(role => !parents.has(role.id));
  return { heads, conflict: heads.length > 1, primary: heads.length === 1 ? heads[0].primary : null,
    epoch: heads.length === 1 ? heads[0].id : null };
}

// Validate the complete history before any database mutations. No older snapshot is required.
export function orderedEvents(events, store) {
  check(Array.isArray(events), 'Invalid modification history');
  const ids = new Map(), entities = new Map();
  for (const event of events) {
    validateEvent(event);
    check(!ids.has(event.id), 'Duplicate modification'); ids.set(event.id, event);
    const existing = store.event(event.id);
    check(!existing || existing.hash === event.hash, 'Revision ID collision');
    const pending = store.db.prepare('SELECT json FROM pending WHERE id=?').get(event.id);
    check(!pending || JSON.parse(pending.json).hash === event.hash, 'Pending revision ID collision');
    const first = entities.get(event.entityId) || store.get(event.entityId);
    if (first) {
      check(first.type === event.type, 'Record type changed');
      if (event.type === 'asset') check(first.data.sha256 === event.data.sha256 && first.data.size === event.data.size, 'Asset identity changed');
      if (['library', 'folder'].includes(event.type)) check(first.data.domain === event.data.domain, 'Library scope changed');
    }
    entities.set(event.entityId, event);
  }
  const children = new Map(), counts = new Map(), ready = [];
  for (const event of events) {
    counts.set(event.id, event.parents.length);
    if (!event.parents.length) ready.push(event);
    for (const id of event.parents) {
      const parent = ids.get(id);
      check(parent && parent.entityId === event.entityId && parent.type === event.type, '当前内容缺少修改历史或包含错误引用');
      if (!children.has(id)) children.set(id, []);
      children.get(id).push(event.id);
    }
  }
  for (let i = 0; i < ready.length; i++) {
    for (const id of children.get(ready[i].id) || []) {
      counts.set(id, counts.get(id) - 1);
      if (!counts.get(id)) ready.push(ids.get(id));
    }
  }
  check(ready.length === events.length, 'Cyclic modification history');
  return ready;
}
