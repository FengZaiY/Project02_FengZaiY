import { canonical, check, isId, sha } from './util.mjs';

export const managementRevision = control => sha(canonical(control));
export const managementHeads = events => {
  const parents = new Set(events.flatMap(event => event.parents));
  return events.filter(event => !parents.has(event.id));
};

function latestActions(events, candidates) {
  const byId = new Map(events.map(event => [event.id, event])), superseded = new Set();
  for (const event of candidates) {
    const pending = [...event.parents], visited = new Set();
    while (pending.length) {
      const id = pending.pop(); if (visited.has(id)) continue;
      visited.add(id); superseded.add(id); pending.push(...(byId.get(id)?.parents || []));
    }
  }
  return candidates.filter(event => !superseded.has(event.id));
}

export function transferDisputed(control, role) {
  if (!role.transferId) return false;
  const request = control.management?.find(event => event.id === role.transferId);
  if (!request) return true;
  const latest = latestActions(control.management, control.management.filter(event => event.epoch === request.epoch
    && ['transfer', 'cancel-transfer'].includes(event.action)));
  return latest.length !== 1 || latest[0].id !== request.id;
}

export function validateManagement(control) {
  const events = control.management || [], roles = new Map(control.roles.map(role => [role.id, role]));
  const devices = new Set(control.devices.map(device => device.deviceId)), ids = new Map();
  check(Array.isArray(events) && events.length <= 10000, '设备管理记录无效或数量过多');
  for (const event of events) {
    check(event && isId(event.id) && !ids.has(event.id) && isId(event.actor) && isId(event.epoch)
      && devices.has(event.deviceId) && Number.isFinite(Date.parse(event.at)) && typeof event.at === 'string'
      && Array.isArray(event.parents) && event.parents.every(isId) && new Set(event.parents).size === event.parents.length,
    '设备管理记录无效');
    check(['rename', 'suspend', 'resume', 'transfer', 'cancel-transfer'].includes(event.action), '未知设备管理操作');
    const fields = ['action', 'actor', 'at', 'deviceId', 'epoch', 'id', 'parents', ...(event.action === 'rename' ? ['name'] : [])];
    check(Object.keys(event).sort().join() === fields.sort().join(), '设备管理记录含未知字段');
    if (event.action === 'rename') check(typeof event.name === 'string' && event.name.trim() === event.name
      && event.name.length > 0 && event.name.length <= 100 && !/[\x00-\x1f\x7f]/.test(event.name), '设备名称须为 1 至 100 个字符');
    const role = roles.get(event.epoch);
    check(role?.primary === event.actor, '设备管理操作不是由所依据的主力机发起');
    if (['suspend', 'transfer'].includes(event.action)) check(event.deviceId !== event.actor, '不能停用或向本机转移主力角色');
    ids.set(event.id, event);
  }
  // Roles and management records form one causal graph: a transfer cannot authorize itself.
  const dependencies = new Map(control.roles.map(role => [role.id, [...role.parents, ...(role.transferId ? [role.transferId] : []), ...(role.managementParents || [])]]));
  for (const event of events) {
    check(!dependencies.has(event.id), '设备管理与角色标识冲突');
    check(event.parents.every(id => ids.has(id)), '缺少设备管理父记录');
    dependencies.set(event.id, [...event.parents, event.epoch]);
  }
  const done = new Set();
  while (done.size < dependencies.size) {
    const ready = [...dependencies].filter(([id, parents]) => !done.has(id) && parents.every(parent => done.has(parent)));
    check(ready.length, '设备管理或主力角色存在循环依赖');
    ready.forEach(([id]) => done.add(id));
  }
  for (const role of control.roles) {
    if (role.managementParents) check(role.managementParents.every(id => ids.has(id)), '主力角色缺少管理依据');
    if (role.recovery) {
      const prior = role.parents.map(id => roles.get(id));
      const participants = prior.flatMap(parent => [parent.primary, ids.get(parent.transferId)?.actor]);
      const included = new Set(), pending = [...(role.managementParents || [])];
      while (pending.length) { const id = pending.pop(); if (!included.has(id)) { included.add(id); pending.push(...ids.get(id).parents); } }
      const snapshot = { ...control, management: events.filter(event => included.has(event.id)) };
      check(prior.length && participants.includes(role.primary) && (prior.length > 1 || prior.some(parent => transferDisputed(snapshot, parent))), '主力角色恢复缺少冲突依据');
      continue;
    }
    if (role.transferId) {
      const request = ids.get(role.transferId);
      check(request?.action === 'transfer' && request.deviceId === role.primary
        && role.parents.length === 1 && role.parents[0] === request.epoch, '主力机转移缺少有效请求');
    } else if (role.parents.length === 1) {
      const parent = roles.get(role.parents[0]);
      check(parent.primary === role.primary || !events.some(event => event.epoch === parent.id), '主力机转移必须由原主力机发起');
    }
  }
  return events;
}

export function managementState(control, role) {
  const events = control.management || [];
  const latest = candidates => latestActions(events, candidates);
  const states = new Map();
  for (const deviceId of new Set(control.devices.map(device => device.deviceId))) {
    const related = events.filter(event => event.deviceId === deviceId);
    const names = latest(related.filter(event => event.action === 'rename'));
    const statuses = latest(related.filter(event => ['suspend', 'resume'].includes(event.action)));
    const nameValues = [...new Set(names.map(event => event.name))], statusValues = new Set(statuses.map(event => event.action));
    states.set(deviceId, { name: nameValues.length === 1 ? nameValues[0] : null, nameConflict: nameValues.length > 1,
      names: nameValues, suspended: statuses.some(event => event.action === 'suspend'), statusConflict: statusValues.size > 1 });
  }
  const transfers = latest(events.filter(event => event.epoch === role.epoch && ['transfer', 'cancel-transfer'].includes(event.action)));
  return { states, heads: managementHeads(events).map(event => event.id),
    transferConflict: transfers.length > 1, transfer: transfers.length === 1 && transfers[0].action === 'transfer' ? transfers[0] : null };
}
