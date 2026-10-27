import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { check, uuid, now, sha, canonical, atomicWrite, noSymlink, prettyError } from './util.mjs';
import { richReferences } from './rich-content.mjs';
import { cleanDraftRefs, validateDraftRefs } from './draft-workflow.mjs';
import { handleMcp } from './agent-mcp.mjs';
import { PUBLIC_PERSONAL_TYPES, PERSONAL_SCOPE, MATERIAL_SCOPE, personalReferences } from './personal-schema.mjs';
import { PersonalManager } from './personal-manager.mjs';
import { MaterialCenter } from './material-center.mjs';

const skillRoot = fileURLToPath(new URL('../../skills/studyself-organize/', import.meta.url));
const skillNames = ['SKILL.md', 'references/preferences.md', 'references/api.md', 'scripts/client.mjs'];
const preferenceId = 'becb64b1-215f-46ed-b332-ae0b36613126';
const readableTypes = ['library', 'folder', 'note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'asset', ...PUBLIC_PERSONAL_TYPES];
const permissions = { bootstrap: 'read', libraries: 'read', search: 'read', record: 'read', history: 'read', assetRead: 'read',
  draftCreate: 'collect', sourceCreate: 'collect', draftUpdate: 'collect', assetWrite: 'collect',
  propose: 'propose', proposalRevise: 'propose', noteUpdate: 'edit', relationCreate: 'edit', trash: 'trash', personalList: 'read', financeReport: 'read',
  taskSave: 'edit', projectSave: 'edit', accountSave: 'edit', subscriptionSave: 'edit', moneyAccountSave: 'edit', moneyEntrySave: 'edit', budgetSave: 'edit', collectionSave: 'edit', personalBatch: 'edit', subscriptionPay: 'edit', materialUpdate: 'edit' };
const mutations = new Set(['draftCreate', 'sourceCreate', 'draftUpdate', 'assetWrite', 'propose', 'proposalRevise', 'noteUpdate', 'relationCreate', 'trash']);
for (const method of Object.keys(permissions)) if (permissions[method] === 'edit') mutations.add(method);
const businessMethods = { taskSave: 'personalTask', projectSave: 'personalProject', accountSave: 'loginAccount', subscriptionSave: 'subscription', moneyAccountSave: 'moneyAccount', moneyEntrySave: 'moneyEntry', budgetSave: 'moneyBudget', collectionSave: 'materialCollection' };
const maxAsset = 16 * 1024 * 1024;
const allPermissions = ['read', 'collect', 'propose', 'edit', 'trash'];

export class AgentAccess {
  constructor(store) {
    this.store = store;
    this.personal = new PersonalManager(store); this.materials = new MaterialCenter(store);
    this.server = null;
    this.closed = false;
    this.error = null;
    store.db.exec('CREATE TABLE IF NOT EXISTS agent_requests(grant_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(grant_id,request_id))');
    this.removeGrants(this.grants().filter(grant => grant.revoked).map(grant => grant.id));
    const grants = this.grants();
    const upgraded = grants.map(grant => ({ ...grant, scope: 'all', domains: [], permissions: [...allPermissions], sensitive: true }));
    if (canonical(grants) !== canonical(upgraded)) store.local('agentGrants', upgraded);
  }
  skillFiles() { return Object.fromEntries(skillNames.map(name => [name, fs.readFileSync(path.join(skillRoot, name), 'utf8')])); }
  skillPackage() {
    const files = this.skillFiles(), preferences = this.preferences();
    const skillVersion = sha(canonical(files));
    return { files, preferences, skillVersion, exportVersion: sha(canonical({ skillVersion, preferencesVersion: preferences.version })),
      lastGenerated: this.store.local('skillLastGenerated') || null };
  }
  exportSkill() {
    const result = this.skillPackage();
    check(!result.preferences.conflict, '请先合并整理偏好冲突，再导出 Skill', 'CONFLICT');
    result.lastGenerated = { at: now(), version: result.exportVersion, skillVersion: result.skillVersion, preferencesVersion: result.preferences.version };
    this.store.local('skillLastGenerated', result.lastGenerated);
    return result;
  }
  preferences() {
    const record = this.store.get(preferenceId);
    const baseline = fs.readFileSync(path.join(skillRoot, 'references/preferences.md'), 'utf8');
    return { id: preferenceId, heads: record?.heads || [], conflict: !!record?.conflict, baseline,
      content: record?.data.content || '', versions: record?.versions || [],
      version: sha(canonical({ baseline, heads: record?.heads || [] })) };
  }
  savePreferences({ content, parents }) {
    check(typeof content === 'string' && content.length <= 30000 && Array.isArray(parents), '偏好最多 30000 字，保存时必须提供基础版本');
    this.store.write({ id: preferenceId, type: 'agentPreferences', parents,
      data: { title: '外部 Agent 整理偏好', domain: '__settings__', content } });
    return this.preferences();
  }
  grants() { return this.store.local('agentGrants') || []; }
  status() {
    return { enabled: !!this.server?.listening, requestedEnabled: this.store.local('agentEnabled') === true,
      url: this.server?.listening ? `http://127.0.0.1:${this.server.address().port}` : null,
      mcpUrl: this.server?.listening ? `http://127.0.0.1:${this.server.address().port}/mcp` : null,
      error: this.error, grants: this.grants().map(({ hash, ...grant }) => grant),
      audit: this.store.local('agentAudit') || [], preferences: this.preferences(), protocolVersion: 1 };
  }
  createGrant({ name, days = 30 }) {
    check(typeof name === 'string' && name.trim() && name.length <= 100, '请输入 Agent 名称');
    check(Number.isInteger(days) && days >= 1 && days <= 365, '有效期应为 1 至 365 天');
    check(this.grants().filter(grant => !grant.revoked).length < 100, '请先撤销不再使用的授权');
    const token = randomBytes(32).toString('hex');
    const grant = { id: uuid(), name: name.trim(), scope: 'all', domains: [], permissions: [...allPermissions],
      sensitive: true, createdAt: now(), expiresAt: new Date(Date.now() + days * 86400000).toISOString(), hash: sha(token) };
    this.store.local('agentGrants', [...this.grants(), grant]);
    const { hash, ...publicGrant } = grant;
    return { ...publicGrant, token };
  }
  revoke(id) {
    check(typeof id === 'string' && id.length > 0, '请选择需要撤销的授权');
    this.removeGrants([id]);
    return this.status();
  }
  removeGrants(ids) {
    if (!ids.length) return;
    const removed = new Set(ids);
    this.store.transaction(() => {
      this.store.local('agentGrants', this.grants().filter(grant => !removed.has(grant.id)));
      this.store.local('agentAudit', (this.store.local('agentAudit') || []).filter(item => !removed.has(item.grantId)));
      const erase = this.store.db.prepare('DELETE FROM agent_requests WHERE grant_id=?');
      for (const id of removed) erase.run(id);
    });
  }
  authenticate(token) {
    check(!this.closed && this.server?.listening, 'Agent 接口未启用', 'UNAUTHORIZED');
    check(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), '访问凭证无效', 'UNAUTHORIZED');
    const grant = this.grants().find(item => item.hash === sha(token));
    check(grant && !grant.revoked && Date.parse(grant.expiresAt) > Date.now(), '授权已撤销、过期或不存在', 'UNAUTHORIZED');
    return grant;
  }
  scope(grant, domain) {
    if ([PERSONAL_SCOPE, MATERIAL_SCOPE].includes(domain)) return;
    check(this.store.libraries().some(item => item.data.domain === domain && !item.deleted && !item.conflict), '知识库已删除或存在冲突', 'FORBIDDEN');
  }
  checkData(grant, data, seen = new Set(), virtual = new Map()) {
    this.scope(grant, data.domain);
    check(!data.sensitive || grant.sensitive, '敏感资料未授权', 'FORBIDDEN');
    if (data.items) virtual = new Map(data.items.map(item => [item.targetId, { id: item.targetId, type: 'note', data: item.data, versions: [{ data: item.data }] }]));
    const refs = [...(data.sourceIds || []), ...personalReferences(data), ...richReferences(data).refs, ...[data.noteId, data.from, data.to, data.folderId, data.parentId].filter(Boolean)];
    for (const id of refs) {
      if (this.store.isRetiredAI(id)) continue;
      this.readable(grant, this.store.get(id), seen, virtual);
    }
    const checkDraft = ref => {
      this.readable(grant, this.store.get(ref.id), seen, virtual);
      const event = this.store.event(ref.versionId), key = `version:${ref.versionId}`;
      check(event?.entityId === ref.id && event.type === 'draft', '来源草稿版本不可访问', 'FORBIDDEN');
      if (!seen.has(key)) { seen.add(key); this.checkData(grant, event.data, seen, virtual); }
    };
    if (data.draftOrigin) checkDraft(data.draftOrigin);
    if (data.parentNoteId) this.readable(grant, this.store.get(data.parentNoteId) || virtual.get(data.parentNoteId), seen, virtual);
    for (const item of data.items || []) {
      for (const ref of item.draftRefs || []) checkDraft(ref);
      this.checkData(grant, item.data, seen, virtual);
      if (this.store.get(item.targetId)) this.readable(grant, this.store.get(item.targetId), seen);
    }
  }
  readable(grant, record, seen = new Set(), virtual = new Map()) {
    check(record && readableTypes.includes(record.type), '资料不存在或不可访问', 'FORBIDDEN');
    if (seen.has(record.id)) return record;
    check(seen.size < 2000, '引用过多，请缩小范围');
    seen.add(record.id);
    for (const version of record.versions.length ? record.versions : [{ data: record.data }]) this.checkData(grant, version.data, seen, virtual);
    return record;
  }
  canRead(grant, record) { try { this.readable(grant, record); return true; } catch { return false; } }
  audit(grant, method, requestId, code) {
    const items = this.store.local('agentAudit') || [];
    items.unshift({ at: now(), grantId: grant.id, name: grant.name, method: String(method).slice(0, 80), requestId: String(requestId || '').slice(0, 100), result: code });
    this.store.local('agentAudit', items.slice(0, 200));
  }
  dispatch(grant, { method, input = {}, requestId }) {
    try {
      check(Object.hasOwn(permissions, method), '未授权的操作', 'FORBIDDEN');
      const current = this.grants().find(item => item.id === grant.id && item.hash === grant.hash);
      check(current && !current.revoked && Date.parse(current.expiresAt) > Date.now(), '授权已撤销、过期或不存在', 'UNAUTHORIZED');
      check(!this.store.materialMigrating && !this.store.permanentDeleting, '资料维护正在进行', 'BUSY');
      check(Object.hasOwn(permissions, method) && grant.permissions.includes(permissions[method]), '未授权的操作', 'FORBIDDEN');
      check(input && typeof input === 'object' && !Array.isArray(input), 'Invalid input');
      if (!mutations.has(method)) {
        const value = this.read(grant, method, input);
        this.audit(grant, method, requestId, 'OK');
        return value;
      }
      check(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(requestId), '写入必须提供唯一 requestId');
      const digest = sha(canonical({ method, input }));
      return this.store.transaction(() => {
        const prior = this.store.db.prepare('SELECT digest,result FROM agent_requests WHERE grant_id=? AND request_id=?').get(grant.id, requestId);
        if (prior) {
          check(prior.digest === digest, '同一 requestId 不能用于不同内容', 'CONFLICT');
          const result = JSON.parse(prior.result);
          for (const record of result.records || [result]) { this.readable(grant, this.store.get(record.id)); this.readable(grant, record); }
          this.audit(grant, method, requestId, 'REPLAY');
          return result;
        }
        const prefs = this.preferences();
        check(!prefs.conflict && input.preferencesVersion === prefs.version, '整理偏好已变化或存在冲突，请重新读取 bootstrap', 'PREFERENCES_CHANGED');
        const result = this.store.change(`Agent · ${method}`, `Agent：${grant.name}`, () => this.mutate(grant, method, input));
        this.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)').run(grant.id, requestId, digest, JSON.stringify(result));
        this.audit(grant, method, requestId, 'OK');
        return result;
      });
    } catch (error) { if (this.grants().some(item => item.id === grant.id)) this.audit(grant, method, requestId, error.code || 'INVALID'); throw error; }
  }
  read(grant, method, input) {
    if (method === 'bootstrap') {
      const files = this.skillFiles();
      return { protocolVersion: 1, product: 'FengZai·Y', capabilities: { mcp: { transport: 'streamable-http', toolPrefix: 'studyself_' }, personalTypes: PUBLIC_PERSONAL_TYPES, syncFormat: 7, secrets: false }, skillVersion: sha(canonical(files)), skill: files['SKILL.md'], apiReference: files['references/api.md'],
        preferences: this.preferences(), access: { scope: 'all', domains: this.store.libraries().filter(item => !item.deleted && !item.conflict).map(item => item.data.domain),
          permissions: grant.permissions, sensitive: grant.sensitive, expiresAt: grant.expiresAt } };
    }
    if (method === 'libraries') return this.store.libraries().filter(item => this.canRead(grant, item)).map(({ id, data, heads, conflict }) => ({ id, data, heads, conflict }));
    if (method === 'personalList') return this.personal.list(input).filter(record => this.canRead(grant, record));
    if (method === 'financeReport') return this.personal.report(input);
    if (method === 'search') {
      if (input.domain) this.scope(grant, input.domain);
      check(!input.type || readableTypes.includes(input.type), '不支持的内容类型');
      const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 100)) : 50;
      const offset = Number.isInteger(input.offset) ? Math.max(0, input.offset) : 0;
      const records = this.store.list({ type: input.type, domain: input.domain, folderId: input.folderId, query: String(input.query || '').slice(0, 500), trash: input.trash === true }).filter(record => this.canRead(grant, record));
      return { total: records.length, offset, records: records.slice(offset, offset + limit).map(record => ({ id: record.id, type: record.type, heads: record.heads,
        domain: record.data.domain, folderId: record.data.folderId, parentId: record.data.parentId, parentNoteId: record.data.parentNoteId, noteOrder: record.data.noteOrder,
        title: record.data.title, tags: record.data.tags, updatedAt: record.updatedAt, conflict: record.conflict, deleted: record.deleted })) };
    }
    const record = this.readable(grant, this.store.get(input.id));
    if (method === 'record') return record;
    if (method === 'history') {
      const events = this.store.history(record.id);
      for (const event of events) this.checkData(grant, event.data);
      return events;
    }
    check(record.type === 'asset' && !record.deleted && !record.conflict, '请选择完整附件');
    const location = this.store.assetLocation(record.id);
    check(location && fs.existsSync(location.path), '原文件尚未完整接收，请检查同步进度或关联已有本机文件', 'ASSET_UNAVAILABLE');
    check(record.data.size <= maxAsset, '接口单个附件上限 16 MiB，大文件请在系统内导入和查阅');
    noSymlink(location.path);
    check(fs.statSync(location.path).size === record.data.size, '附件完整性校验失败');
    const data = fs.readFileSync(location.path);
    check(sha(data) === record.data.sha256, '附件完整性校验失败');
    return { id: record.id, filename: record.data.filename, mime: record.data.mime, sha256: record.data.sha256, data: data.toString('base64') };
  }
  mutate(grant, method, input) {
    if (businessMethods[method]) {
      check(Array.isArray(input.parents), '请提供基础版本；新记录使用空数组');
      return this.personal.save({ ...input, type: businessMethods[method] }, `Agent：${grant.name}`);
    }
    if (method === 'personalBatch') {
      check(input.items?.every(item => Array.isArray(item.parents)), '每项须提供基础版本');
      return this.personal.batch(input, `Agent：${grant.name}`);
    }
    if (method === 'subscriptionPay') return this.personal.paySubscription(input, `Agent：${grant.name}`);
    if (method === 'materialUpdate') return this.materials.update(input, `Agent：${grant.name}`);
    const write = (type, data, id = uuid(), parents = []) => {
      this.checkData(grant, data);
      this.store.writeRaw({ type, data, id, parents });
      return this.store.get(id);
    };
    if (method === 'draftCreate' || method === 'sourceCreate' || method === 'relationCreate') {
      return write({ draftCreate: 'draft', sourceCreate: 'source', relationCreate: 'relation' }[method], input.data);
    }
    if (method === 'assetWrite') {
      this.scope(grant, input.domain);
      check(typeof input.filename === 'string' && input.filename.length > 0 && input.filename.length <= 255 && !/[\\/\0]/.test(input.filename), 'Invalid filename');
      check(typeof input.data === 'string' && input.data.length <= Math.ceil(maxAsset / 3) * 4, 'Invalid base64 attachment');
      const bytes = Buffer.from(input.data, 'base64'), hash = sha(bytes);
      check(bytes.toString('base64') === input.data, 'Invalid base64 attachment');
      check(bytes.length <= maxAsset && hash === input.sha256, '附件哈希或大小不符');
      const data = { title: input.filename, domain: input.domain, filename: input.filename, mime: String(input.mime || 'application/octet-stream').slice(0, 200),
        ...(this.store.personalSystem || input.domain === MATERIAL_SCOPE ? { centralized: true, collectionIds: [], libraryDomains: input.domain === MATERIAL_SCOPE ? [] : [input.domain] } : {}),
        size: bytes.length, sha256: hash, priority: 'normal', sensitive: input.sensitive === true,
        ...(input.folderId ? { folderId: input.folderId } : {}) };
      this.checkData(grant, data);
      const target = this.store.directories.assetPath(input.domain, hash);
      noSymlink(target);
      if (fs.existsSync(target)) check(sha(fs.readFileSync(target)) === hash, '资料目标已变化，停止写入');
      else fs.writeFileSync(target, bytes, { flag: 'wx' });
      const record = write('asset', data);
      this.store.bindAsset(record.id, target);
      return record;
    }
    if (method === 'propose') {
      check(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 100, '方案需要 1 至 100 项');
      const keys = new Map();
      for (const item of input.items) if (item.key !== undefined) {
        check(typeof item.key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.key) && !keys.has(item.key), '方案 key 必须唯一且只含字母、数字、下划线或短横线');
        keys.set(item.key, item.targetId || uuid());
      }
      const items = input.items.map(item => {
        if (item.parentKey !== undefined) check(keys.has(item.parentKey), '方案引用了不存在的上级 key');
        const entry = this.proposalItem(grant, { ...item, data: { ...item.data,
          ...(item.parentKey !== undefined ? { parentNoteId: keys.get(item.parentKey) } : {}) } });
        if (!item.targetId && item.key) entry.targetId = keys.get(item.key);
        return entry;
      });
      return write('proposal', { title: input.title || '外部 Agent 整理方案', domain: input.domain, content: input.content || '', items });
    }
    const record = this.readable(grant, this.store.get(input.id));
    check(!record.conflict && !record.deleted, '请先在系统内处理冲突或恢复资料', 'CONFLICT');
    check(Array.isArray(input.parents) && canonical([...input.parents].sort()) === canonical(record.heads), '内容已变化，请读取最新版本', 'CONFLICT');
    if (method === 'trash') {
      check(['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'asset', ...PUBLIC_PERSONAL_TYPES].includes(record.type), '不允许删除该类型');
      this.store.writeRaw({ id: record.id, type: record.type, data: record.data, parents: input.parents, deleted: true });
      return this.store.get(record.id);
    }
    if (method === 'proposalRevise') {
      check(record.type === 'proposal' && Array.isArray(input.items) && input.items.length > 0, '请选择待确认方案项');
      const updates = new Map();
      for (const item of input.items) {
        const old = record.data.items.find(entry => entry.id === item.id);
        check(old && old.status === 'pending' && !updates.has(item.id), '不能改写已确认项或重复修改同一项');
        check(item.draftRefs === undefined || (old.draftRefs || []).every(ref => item.draftRefs.some(next => next.id === ref.id)),
          '不能移除待确认项的来源草稿关联');
        const targetId = this.store.get(old.targetId) ? old.targetId : undefined;
        updates.set(item.id, { ...this.proposalItem(grant, { ...item, data: item.data, draftRefs: item.draftRefs ?? old.draftRefs,
          reason: item.reason ?? old.reason, targetId, parents: old.parents }), id: old.id, targetId: old.targetId });
      }
      return write('proposal', { ...record.data, items: record.data.items.map(item => updates.get(item.id) || item) }, record.id, input.parents);
    }
    check(record.type === (method === 'noteUpdate' ? 'note' : 'draft'), '记录类型不符');
    check(input.data.domain === record.data.domain, '改换知识库请提交方案，不直接移动');
    check((input.data.folderId || null) === (record.data.folderId || null), '调整目录归属请提交整理方案，由用户确认');
    check((input.data.parentNoteId || null) === (record.data.parentNoteId || null), '调整知识体系请提交整理方案，由用户确认');
    check(input.data.noteOrder === undefined || input.data.noteOrder === record.data.noteOrder, '笔记排序由用户界面管理，请保留已有顺序');
    check(input.data.draftOrigin === undefined || canonical(input.data.draftOrigin) === canonical(record.data.draftOrigin), '归档来源由用户确认，不允许 Agent 设置');
    return write(record.type, { ...input.data, ...(record.data.draftOrigin ? { draftOrigin: record.data.draftOrigin } : {}),
      ...(record.data.noteOrder !== undefined ? { noteOrder: record.data.noteOrder } : {}) }, record.id, input.parents);
  }
  proposalItem(grant, item) {
    const target = item.targetId && this.store.get(item.targetId);
    check(!item.targetId || target, '更新目标不存在');
    if (target) {
      this.readable(grant, target);
      check(target.type === 'note' && !target.deleted && !target.conflict, '目标必须是无冲突的正式笔记');
      check(Array.isArray(item.parents) && canonical([...item.parents].sort()) === canonical(target.heads), '目标基础版本已变化', 'CONFLICT');
    } else check(!item.parents?.length, '新笔记不应指定父版本');
    check(item.data.draftOrigin === undefined || canonical(item.data.draftOrigin) === canonical(target?.data.draftOrigin), '归档来源由用户确认，不允许 Agent 设置');
    const draftRefs = item.draftRefs !== undefined ? cleanDraftRefs(item.draftRefs) : undefined;
    if (draftRefs) {
      validateDraftRefs(this.store, draftRefs);
      for (const ref of draftRefs) this.readable(grant, this.store.get(ref.id));
    }
    const data = target ? { ...(target.data.folderId !== undefined ? { folderId: target.data.folderId } : {}),
      ...(target.data.parentNoteId !== undefined ? { parentNoteId: target.data.parentNoteId } : {}), ...item.data, sensitive: target.data.sensitive || item.data.sensitive === true,
      sourceIds: [...new Set([...(target.data.sourceIds || []), ...(item.data.sourceIds || [])])],
      assetIds: [...new Set([...(target.data.assetIds || []), ...(item.data.assetIds || [])])] } : item.data;
    if (target?.data.draftOrigin) data.draftOrigin = target.data.draftOrigin;
    if (draftRefs?.some(ref => this.store.get(ref.id).data.sensitive)) data.sensitive = true;
    check(item.data.noteOrder === undefined || item.data.noteOrder === target?.data.noteOrder, '笔记排序由用户界面管理，请保留已有顺序');
    if (target?.data.noteOrder !== undefined) data.noteOrder = (data.parentNoteId || null) === (target.data.parentNoteId || null) && data.domain === target.data.domain ? target.data.noteOrder : null;
    return { id: uuid(), targetId: target?.id || uuid(), parents: target?.heads || [], data,
      ...(draftRefs !== undefined ? { draftRefs } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}), status: 'pending' };
  }
  async configure(enabled) {
    check(!this.starting, '接口正在启动，请稍后');
    if (!enabled) { this.stop(); this.error = null; this.store.local('agentEnabled', false); return this.status(); }
    await this.start();
    this.store.local('agentEnabled', true);
    return this.status();
  }
  async resume() {
    if (this.store.local('agentEnabled')) {
      try { await this.start(); } catch (error) { this.error = error.message; }
    }
  }
  async start() {
    if (this.server?.listening) return;
    check(!this.starting, '接口正在启动，请稍后');
    this.starting = true;
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        check(req.headers.host === `127.0.0.1:${server.address()?.port}` && !req.headers.origin, '仅接受本机 Agent 请求，不允许浏览器跨域', 'FORBIDDEN');
        if (req.url !== '/mcp') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '仅提供 /mcp 连接，旧 HTTP RPC 接口已停用' } }));
          return;
        }
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        this.authenticate(token);
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '只支持 POST；本机 MCP 不提供独立 SSE 或会话删除接口' } }));
          return;
        }
        check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Expected application/json');
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          check(size <= 23 * 1024 * 1024, 'Request too large');
          chunks.push(chunk);
        }
        this.authenticate(token);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 格式无效' } }));
          return;
        }
        if (Array.isArray(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '每次 MCP 请求只允许一条消息' } }));
          return;
        }
        await handleMcp(this, token, req, res, body);
      } catch (error) {
        if (res.headersSent || res.destroyed) { if (!res.destroyed) res.end(); return; }
        res.writeHead(error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403 : ['CONFLICT', 'PREFERENCES_CHANGED'].includes(error.code) ? 409 : 400,
          { 'Content-Type': 'application/json; charset=utf-8' });
        const known = ['INVALID', 'CONFLICT', 'PREFERENCES_CHANGED', 'UNAUTHORIZED', 'FORBIDDEN', 'ASSET_UNAVAILABLE'];
        const failure = known.includes(error.code) ? prettyError(error) : { code: 'ERROR', message: '请求未完成，请检查参数或在系统内核对文件状态' };
        res.end(JSON.stringify(req.url === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32000, message: failure.message, data: { code: failure.code } } } : { error: failure }));
      }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 16;
    this.server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.store.local('agentPort') || 0, '127.0.0.1', resolve); });
      this.store.local('agentPort', server.address().port);
      this.error = null;
    } catch (error) { this.server = null; this.error = error.message; throw error; }
    finally { this.starting = false; }
  }
  stop() { if (this.server) { this.server.close(); this.server.closeAllConnections(); this.server = null; } }
  close() { this.closed = true; this.stop(); }
}
