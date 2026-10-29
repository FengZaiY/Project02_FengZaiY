import { agentOperations, secretResults, localOnlyInputs } from './agent-operation-catalog.mjs';
import { canonical, check, sha, uuid, now } from './util.mjs';

const storageKey = 'agentOperationQueue';
const terminal = new Set(['completed', 'rejected', 'failed', 'expired', 'interrupted', 'local_action_required']);
export class AgentOperations {
  constructor(service) {
    this.service = service; this.store = service.store; this.running = 0;
    const grants = new Set(service.agents.grants().filter(grant => !grant.revoked).map(grant => grant.id));
    const orphaned = (this.store.local(storageKey) || []).filter(entry => !grants.has(entry.grantId));
    if (orphaned.length) this.removeGrants(orphaned.map(entry => entry.grantId));
    const entries = this.entries();
    if (entries.some(entry => entry.state === 'executing')) {
      for (const entry of entries) if (entry.state === 'executing') { entry.state = 'interrupted'; delete entry.payload; entry.message = '上次执行中断，请核对实际状态；不会自动重跑'; }
      this.save(entries);
    }
  }
  entries() {
    const entries = this.store.local(storageKey) || [];
    const erasures = this.erasureRevision();
    let changed = false;
    for (const entry of entries) {
      if (entry.erasureRevision !== erasures) {
        delete entry.payload; delete entry.result; delete entry.localToken;
        entry.erasureRevision = erasures;
        if (entry.state === 'pending' || entry.state === 'local_action_required') entry.state = 'expired';
        entry.message = '已有永久删除，旧请求内容及结果不再提供'; changed = true;
      }
      if (entry.state === 'pending' && Date.parse(entry.expiresAt) <= Date.now()) {
        entry.state = 'expired'; delete entry.payload; changed = true;
      }
    }
    if (changed) this.save(entries);
    return entries;
  }
  save(entries) {
    const grants = new Set(this.service.agents.grants().filter(grant => !grant.revoked).map(grant => grant.id));
    entries = entries.filter(entry => grants.has(entry.grantId));
    this.store.transaction(() => {
      this.store.local(storageKey, entries);
      for (const entry of entries) this.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?) ON CONFLICT(grant_id,request_id) DO UPDATE SET result=excluded.result')
        .run(entry.grantId, entry.requestId, entry.digest, JSON.stringify(this.summary(entry)));
    });
  }
  seal(value) { return this.store.vault.seal(JSON.stringify(value)); }
  open(value) { return JSON.parse(this.store.vault.open(value)); }
  erasureRevision() { return sha(canonical(this.store.erasures())); }
  authorize(grantId) {
    const grant = this.service.agents.grants().find(item => item.id === grantId);
    check(grant && !grant.revoked && Date.parse(grant.expiresAt) > Date.now(), '授权已撤销或过期', 'UNAUTHORIZED'); return grant;
  }
  removeGrants(ids) {
    const removed = new Set(ids);
    this.store.transaction(() => {
      // Read without expiry processing so revoked receipts cannot be recreated.
      this.save((this.store.local(storageKey) || []).filter(entry => !removed.has(entry.grantId)));
      const erase = this.store.db.prepare('DELETE FROM agent_requests WHERE grant_id=?');
      for (const id of removed) erase.run(id);
    });
  }
  snapshot() {
    return sha(canonical({ heads: this.store.db.prepare('SELECT entity_id,event_id FROM heads ORDER BY entity_id,event_id').all(),
      control: this.store.local('v3Control'), binding: this.store.local('syncBindingRevision'),
      folder: this.store.local('syncFolder'), storage: this.service.storage?.status() || null,
      // Background inspection updates checkedAt even when the installation is unchanged.
      skills: this.service.skillInstallations.list().map(({ checkedAt, ...installation }) => installation), grants: this.service.agents.grants(),
      preferences: this.service.agents.preferences().version }));
  }
  summary(entry) {
    return { id: entry.id, operation: entry.operation, label: agentOperations[entry.operation].label,
      agent: entry.agent, state: entry.state, at: entry.at, expiresAt: entry.expiresAt, message: entry.message,
      mode: agentOperations[entry.operation].mode };
  }
  list() { return this.entries().map(entry => this.summary(entry)); }
  detail(id) {
    const entry = this.entries().find(item => item.id === id); check(entry, '操作请求不存在');
    if (!entry.payload) return { ...this.summary(entry), input: {}, token: '', stale: false };
    const payload = this.open(entry.payload);
    const input = structuredClone(payload.input);
    if (entry.operation === 'vaultSave') input.value = '[密码内容已加密，仅保存到所选账号]';
    if (entry.operation === 'syncConfigure' && input.key) input.key = `[密钥指纹 ${sha(input.key).slice(0, 16)}]`;
    const target = input.id || input.accountId || input.targetId;
    return { ...this.summary(entry), input, target: target ? this.store.get(target)?.data.title || this.service.agents.grants().find(grant => grant.id === target)?.name || target : null,
      token: sha(canonical({ id, snapshot: payload.snapshot, digest: entry.digest })), stale: payload.snapshot !== this.snapshot() };
  }
  async review(id) {
    const detail = this.detail(id);
    if (detail.state !== 'pending') return detail;
    const previews = { trashEmpty: 'trashPreview', assetMerge: 'assetMergePreview', syncDisconnect: 'syncDisconnectPreview',
      materialMigrate: 'materialMigrationPreview', materialCleanup: 'materialCleanupPreview', storageInternalSchedule: 'storageInternalPreview',
      storageSchedule: 'storageInspect', changeUndo: 'changeDetail',
      deletionRetry: 'deletionStatus', emptyDirectoriesClean: 'emptyDirectoriesPreview', storagePreviousClean: 'storagePreviousPreview',
      financeCsvImport: 'financeCsvPreview', syncConfirmBatch: 'syncStatus', syncConfirmUpload: 'syncStatus', deviceManage: 'deviceStatus', deviceSetPrimary: 'deviceStatus' };
    const method = previews[detail.operation];
    if (method) {
      try {
        const preview = await this.service.call(method, detail.input);
        detail.preview = preview;
        if (preview?.token && detail.input.token !== preview.token) detail.stale = true;
      } catch (error) { detail.blocked = error.message; }
    } else if (detail.operation === 'approve') detail.preview = this.store.get(detail.input.id)?.data;
    else if (detail.operation === 'skillInstallConfirm') {
      const preview = this.service.skillInstallations.previews.get(detail.input.token);
      if (!preview) detail.blocked = '安装预览不存在或已过期，请重新发起预览';
      else detail.preview = { action: preview.action, directory: preview.directory,
        files: Object.keys(preview.before).filter(name => preview.before[name] !== preview.after[name]) };
    }
    const current = this.detail(id);
    if (current.state !== 'pending' || current.token !== detail.token) return current;
    return { ...detail, stale: detail.stale || current.stale };
  }
  async request(grant, { operation, input = {}, preferencesVersion }, requestId) {
    this.authorize(grant.id);
    const spec = Object.hasOwn(agentOperations, operation) && agentOperations[operation]; check(spec, '不支持的应用操作', 'FORBIDDEN');
    check(input && typeof input === 'object' && !Array.isArray(input), '操作参数必须为对象');
    check(Buffer.byteLength(JSON.stringify(input)) <= 1024 * 1024, '操作参数不能超过 1 MiB');
    check(!['password', 'recoveryKey', 'rendererReady'].some(key => Object.hasOwn(input, key)), '主密码、恢复密钥和本机确认字段不能经 MCP 提供', 'FORBIDDEN');
    const fields = spec.parameters.split(',').filter(Boolean);
    check(Object.keys(input).every(key => fields.includes(key)), '操作含未知参数，请先读取 operation_catalog', 'INVALID');
    if (operation === 'save') check(['note', 'draft', 'source', 'annotation', 'relation'].includes(input.type),
      '请选择普通知识内容；方案和工作区使用专用工具，不能伪造确认结果', 'FORBIDDEN');
    if (localOnlyInputs.has(operation)) check(!Object.keys(input).length, '此操作必须在本机输入参数');
    const prefs = this.service.agents.preferences();
    check(!prefs.conflict && preferencesVersion === prefs.version, '整理偏好已变化，请重新读取 bootstrap', 'PREFERENCES_CHANGED');
    check(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(requestId), '需要唯一 requestId');
    if (spec.mode === 'read' || spec.mode === 'secret') {
      if (spec.mode === 'secret') this.service.passwordVault.requireUnlocked();
      const erasures = this.erasureRevision(), generation = this.service.passwordVault.generation;
      const value = await this.service.call(operation, input);
      this.authorize(grant.id);
      check(erasures === this.erasureRevision(), '资料已永久删除，请重新读取', 'PURGED');
      if (spec.mode === 'secret') {
        this.service.passwordVault.requireUnlocked();
        check(generation === this.service.passwordVault.generation, '密码库锁定状态已变化，请重新请求', 'VAULT_LOCKED');
      }
      return { state: 'completed', value };
    }
    if (operation === 'vaultSave') this.service.passwordVault.requireUnlocked();
    const digest = sha(canonical({ operation, input, preferencesVersion })), entries = this.entries();
    const previous = entries.find(entry => entry.grantId === grant.id && entry.requestId === requestId);
    if (previous) { check(previous.digest === digest, '相同 requestId 不能更换操作或参数', 'CONFLICT'); return this.summary(previous); }
    const receipt = this.store.db.prepare('SELECT digest,result FROM agent_requests WHERE grant_id=? AND request_id=?').get(grant.id, requestId);
    if (receipt) { check(receipt.digest === digest, '相同 requestId 已用于其他操作', 'CONFLICT'); return { ...JSON.parse(receipt.result), message: '历史请求已处理，不会重跑；详细结果已过保留期' }; }
    check(entries.filter(entry => !terminal.has(entry.state)).length < 100, '待处理请求过多，请先在本机处理');
    const entry = { id: uuid(), grantId: grant.id, agent: grant.name, requestId, operation, digest, state: 'pending', at: now(), erasureRevision: this.erasureRevision(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      payload: this.seal({ input, preferencesVersion, snapshot: this.snapshot() }) };
    const active = entries.filter(item => !terminal.has(item.state));
    const recent = entries.filter(item => terminal.has(item.state) && Date.parse(item.at) > Date.now() - 86400000)
      .slice(-(499 - active.length));
    this.save([...active, ...recent, entry]);
    return this.summary(entry);
  }
  result(grant, id) {
    this.authorize(grant.id);
    const entry = this.entries().find(item => item.id === id && item.grantId === grant.id); check(entry, '操作请求不存在或不属于此凭证', 'FORBIDDEN');
    const summary = this.summary(entry);
    if (!entry.result) return summary;
    if (secretResults.has(entry.operation)) {
      if (entry.operation === 'vaultSave') this.service.passwordVault.requireUnlocked();
      const value = this.open(entry.result);
      const entries = this.entries(), stored = entries.find(item => item.id === id); delete stored.result; stored.message = '敏感结果已领取，不再重放'; this.save(entries);
      return { ...summary, value };
    }
    return { ...summary, value: this.open(entry.result) };
  }
  async decide({ id, token, approved }) {
    const entries = this.entries(), entry = entries.find(item => item.id === id); check(entry, '操作请求不存在');
    check(!this.running || entry.operation === 'syncPause' || approved === false, '另一项 Agent 请求正在执行', 'BUSY');
    check(entry.state === 'pending', '操作已处理，不会重复执行', 'CONFLICT');
    const detail = this.detail(id); check(token === detail.token, '确认内容已变化', 'CONFLICT');
    check(typeof approved === 'boolean', '请选择同意或拒绝');
    if (!approved) { entry.state = 'rejected'; delete entry.payload; this.save(entries); return this.summary(entry); }
    this.authorize(entry.grantId);
    check(Date.parse(entry.expiresAt) > Date.now(), '请求已过期，请让 Agent 重新发起', 'CONFLICT');
    const payload = this.open(entry.payload);
    check(!detail.stale, '资料、授权或配置已变化，请让 Agent 重新预览并发起', 'CONFLICT');
    check((!this.service.transport.running || entry.operation === 'syncPause') && !this.service.localTask && !this.service.imports.size, '请等待同步、导入或资料维护结束', 'BUSY');
    check(!(this.store.local('workspace')?.tabs || []).some(tab => tab.dirty)
      && !Object.keys(this.store.local('personalDrafts') || {}).length, '请先保存或放弃未保存的笔记和业务表单', 'UNSAVED');
    const spec = agentOperations[entry.operation];
    if (spec.mode === 'local') {
      entry.state = 'local_action_required'; entry.localToken = uuid(); delete entry.payload; this.save(entries);
      return { ...this.summary(entry), localAction: { method: entry.operation, input: payload.input, token: entry.localToken } };
    }
    if (entry.operation === 'vaultSave') this.service.passwordVault.requireUnlocked();
    this.running++; entry.state = 'executing'; this.save(entries);
    try {
      const value = await this.service.call(entry.operation, payload.input);
      const current = this.entries(), saved = current.find(item => item.id === id);
      if (saved) { saved.state = 'completed'; delete saved.payload;
        // Device encryption keeps administrative results out of ordinary receipts.
        saved.result = this.seal(value ?? null); this.save(current); }
      if (this.service.agents.grants().some(grant => grant.id === entry.grantId)) this.service.agents.audit({ id: entry.grantId, name: entry.agent }, `approved:${entry.operation}`, entry.requestId, 'OK');
      return { ...this.summary({ ...entry, state: 'completed' }) };
    } catch (error) {
      const current = this.entries(), saved = current.find(item => item.id === id);
      if (saved) { saved.state = 'failed'; saved.message = error.code || '操作失败，请在本机核对'; delete saved.payload; this.save(current); }
      throw error;
    } finally { this.running--; }
  }
  finishLocal({ id, token, value, failed = false }) {
    const entries = this.entries(), entry = entries.find(item => item.id === id);
    check(entry?.state === 'local_action_required' && token && token === entry.localToken, '本机流程已结束或无效', 'CONFLICT');
    this.authorize(entry.grantId);
    if (entry.operation === 'vaultUnlock') { this.service.passwordVault.requireUnlocked(); value = { unlocked: true }; }
    check(!['vaultResetMaster', 'updateConfigure', 'updateInstall', 'storageRestart', 'printPdf'].includes(entry.operation), '请在本机专用页面完成此流程');
    check(Buffer.byteLength(JSON.stringify(value ?? null)) <= 1024 * 1024, '返回结果过大');
    entry.state = failed ? 'failed' : 'completed'; delete entry.localToken;
    if (!failed) entry.result = this.seal(value ?? null);
    this.save(entries); return this.summary(entry);
  }
}
