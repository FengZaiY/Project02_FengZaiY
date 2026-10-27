import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateEvent } from './store.mjs';
import { canonical, check, sha, now, uuid, noSymlink, isId } from './util.mjs';

export const SHARED = '__shared__';
const OID = /^[a-f0-9]{40}$/;
const GLOBAL_TYPES = new Set(['agentPreferences', 'workspace', 'model', 'provider', 'usage', 'task']);
const MAX_SNAPSHOT = 128 * 1024 * 1024;
const EMPTY_CONTROL = { devices: [], roles: [] };

export function eventHeads(events) {
  const parents = new Set(events.flatMap(event => event.parents));
  return events.filter(event => !parents.has(event.id));
}

export function mergeControl(left = EMPTY_CONTROL, right = EMPTY_CONTROL) {
  const union = field => {
    check(Array.isArray(left[field]) && Array.isArray(right[field]), 'Invalid device registry');
    const values = new Map();
    for (const item of [...left[field], ...right[field]]) {
      check(item && isId(item.id) && typeof item.at === 'string', 'Invalid device entry');
      if (field === 'devices') check(isId(item.deviceId) && typeof item.name === 'string' && item.name.length <= 100, 'Invalid device name');
      else check(isId(item.primary) && Array.isArray(item.parents) && item.parents.every(isId)
        && !item.parents.includes(item.id), 'Invalid primary role');
      check(!values.has(item.id) || canonical(values.get(item.id)) === canonical(item), 'Device entry collision');
      values.set(item.id, item);
    }
    return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  const result = { devices: union('devices'), roles: union('roles') };
  const devices = new Set(result.devices.map(item => item.deviceId));
  check(result.roles.every(role => devices.has(role.primary)), 'Primary device is not registered');
  const known = new Set(result.roles.map(item => item.id));
  for (const role of result.roles) check(role.parents.every(id => known.has(id)), 'Missing primary role parent');
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

export class GitVersions {
  constructor(store) {
    this.store = store;
    this.root = path.join(store.directory, 'version-repositories');
    this.error = null;
    try { this.recover(); } catch (error) { this.error = error.message; }
  }
  control() { return this.store.local('v2Control') || structuredClone(EMPTY_CONTROL); }
  announce() {
    const control = this.control(), name = this.store.getMeta('deviceName');
    const last = control.devices.filter(item => item.deviceId === this.store.deviceId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).at(-1);
    if (last?.name === name) return;
    control.devices.push({ id: uuid(), deviceId: this.store.deviceId, name, at: now() });
    this.store.local('v2Control', control);
  }
  repo(scope) {
    check(typeof scope === 'string' && scope.length > 0 && scope.length <= 100, 'Choose a library scope');
    const directory = path.join(this.root, sha(scope));
    noSymlink(directory);
    return directory;
  }
  git(scope, args, input, options = {}) {
    const directory = this.repo(scope);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const nullFile = process.platform === 'win32' ? 'NUL' : os.devNull;
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'FengZaiY', GIT_AUTHOR_EMAIL: 'local@fengzaiy.invalid',
      GIT_COMMITTER_NAME: 'FengZaiY', GIT_COMMITTER_EMAIL: 'local@fengzaiy.invalid', ...options.env });
    try {
      return execFileSync('git', ['-c', `safe.directory=${directory.replaceAll('\\', '/')}`,
        '-c', `core.hooksPath=${nullFile}`, '-c', 'protocol.allow=never', '--git-dir', directory, ...args],
      { env, input, windowsHide: true, encoding: options.binary ? undefined : 'utf8',
        maxBuffer: MAX_SNAPSHOT, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      const message = error.code === 'ENOENT' ? '未找到 Git，请安装 Git for Windows 并重启应用' : String(error.stderr || error.message).slice(0, 1800);
      throw Object.assign(new Error(message), { code: 'GIT_ERROR' });
    }
  }
  ensure(scope) {
    const directory = this.repo(scope);
    if (!fs.existsSync(path.join(directory, 'HEAD'))) {
      fs.mkdirSync(directory, { recursive: true });
      this.git(scope, ['init', '--bare', '--initial-branch=state', '--template=', directory]);
    }
  }
  pointer(scope) { return this.store.local(`v2Version:${sha(scope)}`); }
  read(scope, commit) {
    check(OID.test(commit), 'Invalid Git commit');
    return this.validate(JSON.parse(this.git(scope, ['show', `${commit}:snapshot.json`])), scope);
  }
  validate(snapshot, scope) {
    check(snapshot?.format === 2 && snapshot.scope === scope && Array.isArray(snapshot.events), 'Invalid version snapshot');
    check(snapshot.events.length <= 100000, 'Version is too large');
    const ids = new Map();
    for (const event of snapshot.events) {
      validateEvent(event);
      check(!ids.has(event.id), 'Duplicate revision'); ids.set(event.id, event);
      check(scope === SHARED ? GLOBAL_TYPES.has(event.type) : !GLOBAL_TYPES.has(event.type), '版本包含其他范围的内容');
      const local = this.store.event(event.id);
      check(!local || local.hash === event.hash, 'Revision ID collision');
    }
    const allowed = new Set(), queue = snapshot.events.filter(event => scope === SHARED || event.data.domain === scope
      || event.parents.some(parent => ids.get(parent)?.data.domain === scope));
    for (let i = 0; i < queue.length; i++) {
      const event = queue[i]; if (allowed.has(event.id)) continue; allowed.add(event.id);
      for (const parent of event.parents) { check(ids.has(parent), '版本缺少前置历史'); queue.push(ids.get(parent)); }
    }
    check(allowed.size === ids.size, '版本包含不相关知识库的记录');
    const entityTypes = new Map(), assets = new Map(), ordered = [], pending = new Map(ids);
    for (const event of snapshot.events) {
      check(event.parents.every(id => ids.has(id)), '版本缺少前置历史');
      for (const id of event.parents) check(ids.get(id).entityId === event.entityId && ids.get(id).type === event.type, 'Invalid history parent');
      const type = entityTypes.get(event.entityId);
      check(!type || type === event.type, 'Entity type changed'); entityTypes.set(event.entityId, event.type);
      const existing = this.store.get(event.entityId);
      check(!existing || existing.type === event.type, 'Entity type changed');
      if (event.type === 'asset') {
        const value = `${event.data.sha256}:${event.data.size}`, previous = assets.get(event.entityId);
        check(!previous || previous === value, 'Asset identity changed'); assets.set(event.entityId, value);
        check(!existing || `${existing.data.sha256}:${existing.data.size}` === value, 'Asset identity changed');
      }
    }
    const children = new Map(), counts = new Map();
    for (const event of snapshot.events) {
      counts.set(event.id, event.parents.length);
      for (const parent of event.parents) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(event.id); }
    }
    const ready = snapshot.events.filter(event => !event.parents.length);
    for (let i = 0; i < ready.length; i++) {
      const event = ready[i]; ordered.push(event); pending.delete(event.id);
      for (const id of children.get(event.id) || []) { counts.set(id, counts.get(id) - 1); if (!counts.get(id)) ready.push(ids.get(id)); }
    }
    check(!pending.size, 'Cyclic version history');
    if (scope === SHARED) mergeControl(EMPTY_CONTROL, snapshot.control);
    else check(snapshot.control === undefined, 'Library cannot change devices');
    return { ...snapshot, events: ordered.sort((a, b) => a.id.localeCompare(b.id)) };
  }
  snapshot(scope) {
    const all = this.store.allEvents(), byId = new Map(all.map(event => [event.id, event]));
    // Include the outbound move itself, not subsequent edits owned only by the new library.
    const queue = all.filter(event => scope === SHARED ? GLOBAL_TYPES.has(event.type)
      : !GLOBAL_TYPES.has(event.type) && (event.data.domain === scope
        || event.parents.some(parent => byId.get(parent)?.data.domain === scope))), selected = new Map();
    for (let i = 0; i < queue.length; i++) {
      const event = queue[i]; if (selected.has(event.id)) continue; selected.set(event.id, event);
      for (const id of event.parents) { check(byId.has(id), 'Missing local parent'); queue.push(byId.get(id)); }
    }
    const events = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
    return this.validate({ format: 2, scope, events, ...(scope === SHARED ? { control: mergeControl(EMPTY_CONTROL, this.control()) } : {}) }, scope);
  }
  scopes() {
    const scopes = new Map(this.store.libraries().map(item => [item.data.domain, item.data.title]));
    for (const event of this.store.allEvents()) if (!GLOBAL_TYPES.has(event.type) && !scopes.has(event.data.domain)) scopes.set(event.data.domain, event.data.domain);
    scopes.set(SHARED, '共享偏好与设备');
    return [...scopes].map(([scope, title]) => {
      const pointer = this.pointer(scope);
      try {
        const snapshot = this.snapshot(scope), digest = sha(canonical(snapshot));
        return { scope, title, commit: pointer?.commit || null, at: pointer?.at, dirty: digest !== pointer?.digest,
          revisions: snapshot.events.length, conflicts: new Set(eventHeads(snapshot.events).filter((event, _, all) => all.some(other => other.entityId === event.entityId && other.id !== event.id)).map(e => e.entityId)).size };
      } catch (error) { return { scope, title, commit: pointer?.commit, dirty: true, error: error.message }; }
    });
  }
  requireClean(scope) {
    const current = this.snapshot(scope), pointer = this.pointer(scope);
    check(!current.events.length && scope !== SHARED || pointer?.digest === sha(canonical(current)), '请先保存本地版本，再拉取合并', 'UNCOMMITTED');
  }
  commit(scope, message = '') {
    check(!this.error, this.error);
    this.recover(); this.ensure(scope);
    const snapshot = this.snapshot(scope), previous = this.pointer(scope);
    if (previous?.digest === sha(canonical(snapshot))) return { ...previous, unchanged: true };
    return this.record(scope, snapshot, [...(previous ? [previous.commit] : []), ...(this.store.local(`v2Recovered:${sha(scope)}`) || [])], String(message).slice(0, 1000) || `保存版本 ${now()} · ${snapshot.events.length} 条历史`, false);
  }
  record(scope, snapshot, parents, message, apply, context = {}) {
    check(!this.store.local('v2Journal'), '存在未完成版本操作，请重启恢复');
    this.validate(snapshot, scope);
    const op = { scope, snapshot, parents: [...new Set(parents)], message, apply, context, at: now(), previous: this.pointer(scope)?.commit || null };
    this.store.local('v2Journal', op);
    return this.recover();
  }
  recover() {
    const op = this.store.local('v2Journal');
    if (!op) return null;
    this.ensure(op.scope); this.validate(op.snapshot, op.scope);
    if (!op.commit) {
      const blob = this.git(op.scope, ['hash-object', '-w', '--stdin'], canonical(op.snapshot)).trim();
      const tree = this.git(op.scope, ['mktree'], `100644 blob ${blob}\tsnapshot.json\n`).trim();
      op.commit = this.git(op.scope, ['commit-tree', tree, ...op.parents.flatMap(id => ['-p', id])], `${op.message}\n`,
        { env: { GIT_AUTHOR_DATE: op.at, GIT_COMMITTER_DATE: op.at } }).trim();
      this.store.local('v2Journal', op);
    }
    this.git(op.scope, ['update-ref', 'refs/heads/state', op.commit]);
    const pointer = { commit: op.commit, scope: op.scope, digest: sha(canonical(op.snapshot)), at: op.at, message: op.message };
    this.store.transaction(() => {
      if (op.apply) {
        const pending = new Map(op.snapshot.events.filter(event => !this.store.event(event.id)).map(event => [event.id, event]));
        while (pending.size) {
          let count = 0;
          for (const [id, event] of pending) if (event.parents.every(parent => this.store.event(parent))) {
            this.store.insert(event, true); pending.delete(id); count++;
          }
          check(count, 'Missing imported parents');
        }
        if (op.scope === SHARED) this.store.local('v2Control', mergeControl(this.control(), op.snapshot.control));
      }
      this.store.local(`v2Version:${sha(op.scope)}`, pointer);
      for (const [id, file] of op.context?.bindings || []) this.store.bindAsset(id, file, this.store.assetLocation(id)?.pinned === 1);
      if (op.context?.importRecord) {
        const { key, id, ...entry } = op.context.importRecord;
        this.store.local(key, { ...(this.store.local(key) || {}), [id]: { ...entry, commit: op.commit } });
      }
      this.store.local('v2Journal', null);
    });
    return pointer;
  }
  history(scope) {
    const pointer = this.pointer(scope);
    const tips = [...new Set([pointer?.commit, ...(this.store.local(`v2Recovered:${sha(scope)}`) || [])].filter(Boolean))];
    if (!tips.length) return [];
    return this.git(scope, ['log', '--format=%H%x09%cI%x09%s', '-100', ...tips]).trim().split('\n').filter(Boolean)
      .map(line => { const [commit, at, ...message] = line.split('\t'); return { commit, at, message: message.join('\t') }; });
  }
  bundle(scope, commit, base, file) {
    check(OID.test(commit) && (!base || OID.test(base)), 'Invalid version reference');
    this.git(scope, ['update-ref', 'refs/heads/publication', commit]);
    this.git(scope, ['bundle', 'create', file, 'refs/heads/publication', ...(base ? [`^${base}`] : [])]);
  }
  receiveBundle(scope, file, commit) {
    check(OID.test(commit), 'Invalid Git commit'); this.ensure(scope);
    this.git(scope, ['bundle', 'verify', file]);
    this.git(scope, ['bundle', 'unbundle', file]);
    this.git(scope, ['fsck', '--strict', '--no-reflogs', commit]);
    return this.read(scope, commit);
  }
  merge(scope, incoming, remoteCommit, context = {}) {
    this.requireClean(scope);
    const previous = this.pointer(scope);
    const current = this.snapshot(scope), events = new Map(current.events.map(event => [event.id, event]));
    incoming.events.forEach(event => { check(!events.has(event.id) || events.get(event.id).hash === event.hash, 'Revision collision'); events.set(event.id, event); });
    const snapshot = { format: 2, scope, events: [...events.values()].sort((a, b) => a.id.localeCompare(b.id)),
      ...(scope === SHARED ? { control: mergeControl(current.control, incoming.control) } : {}) };
    return this.record(scope, snapshot, [previous?.commit, remoteCommit].filter(Boolean), `合并接收 ${remoteCommit.slice(0, 12)}`, true, context);
  }
  restore(scope, commit) {
    check(scope !== SHARED, '共享设备策略不可整体回退，请明确调整'); this.requireClean(scope);
    const snapshot = this.read(scope, commit), targets = new Map();
    for (const event of eventHeads(snapshot.events)) {
      check(event.data.domain === scope, '此历史涉及跨库移动，请使用逐条历史恢复');
      check(!this.store.get(event.entityId)?.versions.some(version => version.data.domain !== scope), '当前资料已跨库移动，请使用逐条历史恢复');
      check(!targets.has(event.entityId), '所选历史含冲突，请逐条恢复'); targets.set(event.entityId, event);
    }
    const current = [...this.store.list({ domain: scope }), ...this.store.list({ domain: scope, trash: true })];
    check(!current.some(record => record.conflict), '请先处理当前冲突');
    this.store.transaction(() => {
      for (const record of current) {
        const target = targets.get(record.id);
        this.store.writeRaw({ id: record.id, type: record.type, parents: record.heads,
          data: target?.data || record.data, deleted: target ? target.deleted : true });
        targets.delete(record.id);
      }
      for (const target of targets.values()) this.store.writeRaw({ id: target.entityId, type: target.type,
        parents: this.store.headIds(target.entityId), data: target.data, deleted: target.deleted });
      this.store.local('v2Journal', { scope, snapshot: this.snapshot(scope), parents: [this.pointer(scope).commit],
        message: `恢复历史 ${commit.slice(0, 12)}`, apply: false, at: now() });
    });
    return this.recover();
  }
}
