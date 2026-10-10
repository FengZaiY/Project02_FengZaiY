import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { check, uuid, now, sha, canonical, atomicWrite, noSymlink, prettyError } from './util.mjs';
import { richReferences } from './rich-content.mjs';

const skillRoot = fileURLToPath(new URL('../../skills/studyself-organize/', import.meta.url));
const skillNames = ['SKILL.md', 'references/preferences.md', 'references/api.md', 'scripts/client.mjs'];
const preferenceId = 'becb64b1-215f-46ed-b332-ae0b36613126';
const readableTypes = ['library', 'note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'asset', 'conversation'];
const permissions = { bootstrap: 'read', libraries: 'read', search: 'read', record: 'read', history: 'read', assetRead: 'read',
  draftCreate: 'collect', sourceCreate: 'collect', draftUpdate: 'collect', assetWrite: 'collect',
  propose: 'propose', proposalRevise: 'propose', noteUpdate: 'edit', relationCreate: 'edit', trash: 'trash' };
const mutations = new Set(['draftCreate', 'sourceCreate', 'draftUpdate', 'assetWrite', 'propose', 'proposalRevise', 'noteUpdate', 'relationCreate', 'trash']);
const maxAsset = 16 * 1024 * 1024;

export class AgentAccess {
  constructor(store) {
    this.store = store;
    this.server = null;
    this.closed = false;
    this.error = null;
    store.db.exec('CREATE TABLE IF NOT EXISTS agent_requests(grant_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(grant_id,request_id))');
  }
  skillFiles() { return Object.fromEntries(skillNames.map(name => [name, fs.readFileSync(path.join(skillRoot, name), 'utf8')])); }
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
      error: this.error, grants: this.grants().map(({ hash, ...grant }) => grant),
      audit: this.store.local('agentAudit') || [], preferences: this.preferences(), protocolVersion: 1 };
  }
  createGrant({ name, domains, edit = false, trash = false, sensitive = false, days = 30 }) {
    check(typeof name === 'string' && name.trim() && name.length <= 100, '请输入 Agent 名称');
    check(Array.isArray(domains) && domains.length > 0 && domains.length <= 100, '请选择授权知识库');
    const libraries = this.store.libraries();
    check(domains.every(domain => libraries.some(record => record.data.domain === domain && !record.deleted && !record.conflict)), '授权范围包含不可用知识库');
    check(Number.isInteger(days) && days >= 1 && days <= 365, '有效期应为 1 至 365 天');
    check(this.grants().filter(grant => !grant.revoked).length < 100, '请先撤销不再使用的授权');
    const token = randomBytes(32).toString('hex');
    const grant = { id: uuid(), name: name.trim(), domains: [...new Set(domains)], permissions: ['read', 'collect', 'propose', ...(edit ? ['edit'] : []), ...(trash ? ['trash'] : [])],
      sensitive: sensitive === true, createdAt: now(), expiresAt: new Date(Date.now() + days * 86400000).toISOString(), hash: sha(token) };
    this.store.local('agentGrants', [...this.grants(), grant]);
    const { hash, ...publicGrant } = grant;
    return { ...publicGrant, token };
  }
  revoke(id) {
    check(this.grants().some(grant => grant.id === id), '授权不存在');
    this.store.local('agentGrants', this.grants().map(grant => grant.id === id ? { ...grant, revoked: true } : grant));
    return this.status();
  }
  authenticate(token) {
    check(!this.closed && this.server?.listening, 'Agent 接口未启用', 'UNAUTHORIZED');
    check(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), '访问凭证无效', 'UNAUTHORIZED');
    const grant = this.grants().find(item => item.hash === sha(token));
    check(grant && !grant.revoked && Date.parse(grant.expiresAt) > Date.now(), '授权已撤销、过期或不存在', 'UNAUTHORIZED');
    return grant;
  }
  scope(grant, domain) {
    check(grant.domains.includes(domain), '该知识库未授权', 'FORBIDDEN');
    check(this.store.libraries().some(item => item.data.domain === domain && !item.deleted && !item.conflict), '知识库已删除或存在冲突', 'FORBIDDEN');
  }
  checkData(grant, data, seen = new Set()) {
    this.scope(grant, data.domain);
    check(!data.sensitive || grant.sensitive, '敏感资料未授权', 'FORBIDDEN');
    const refs = [...(data.sourceIds || []), ...(data.assetIds || []), ...richReferences(data).refs, ...[data.noteId, data.from, data.to].filter(Boolean)];
    for (const id of refs) this.readable(grant, this.store.get(id), seen);
    for (const item of data.items || []) {
      this.checkData(grant, item.data, seen);
      if (this.store.get(item.targetId)) this.readable(grant, this.store.get(item.targetId), seen);
    }
  }
  readable(grant, record, seen = new Set()) {
    check(record && readableTypes.includes(record.type), '资料不存在或不可访问', 'FORBIDDEN');
    if (seen.has(record.id)) return record;
    check(seen.size < 2000, '引用过多，请缩小范围');
    seen.add(record.id);
    for (const version of record.versions.length ? record.versions : [{ data: record.data }]) this.checkData(grant, version.data, seen);
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
          this.readable(grant, this.store.get(result.id));
          this.readable(grant, result);
          this.audit(grant, method, requestId, 'REPLAY');
          return result;
        }
        const prefs = this.preferences();
        check(!prefs.conflict && input.preferencesVersion === prefs.version, '整理偏好已变化或存在冲突，请重新读取 bootstrap', 'PREFERENCES_CHANGED');
        const result = this.mutate(grant, method, input);
        this.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)').run(grant.id, requestId, digest, JSON.stringify(result));
        this.audit(grant, method, requestId, 'OK');
        return result;
      });
    } catch (error) { this.audit(grant, method, requestId, error.code || 'INVALID'); throw error; }
  }
  read(grant, method, input) {
    if (method === 'bootstrap') {
      const files = this.skillFiles();
      return { protocolVersion: 1, skillVersion: sha(canonical(files)), skill: files['SKILL.md'], apiReference: files['references/api.md'],
        preferences: this.preferences(), access: { domains: grant.domains, permissions: grant.permissions, sensitive: grant.sensitive, expiresAt: grant.expiresAt } };
    }
    if (method === 'libraries') return this.store.libraries().filter(item => this.canRead(grant, item)).map(({ id, data, heads, conflict }) => ({ id, data, heads, conflict }));
    if (method === 'search') {
      if (input.domain) this.scope(grant, input.domain);
      check(!input.type || readableTypes.includes(input.type), '不支持的内容类型');
      const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 100)) : 50;
      const offset = Number.isInteger(input.offset) ? Math.max(0, input.offset) : 0;
      const records = this.store.list({ type: input.type, domain: input.domain, query: String(input.query || '').slice(0, 500), trash: input.trash === true }).filter(record => this.canRead(grant, record));
      return { total: records.length, offset, records: records.slice(offset, offset + limit).map(record => ({ id: record.id, type: record.type, heads: record.heads,
        domain: record.data.domain, title: record.data.title, tags: record.data.tags, updatedAt: record.updatedAt, conflict: record.conflict, deleted: record.deleted })) };
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
        size: bytes.length, sha256: hash, priority: 'normal', sensitive: input.sensitive === true };
      this.checkData(grant, data);
      const target = this.store.directories.assetPath(input.domain, hash);
      noSymlink(target);
      atomicWrite(target, bytes);
      const record = write('asset', data);
      this.store.bindAsset(record.id, target);
      return record;
    }
    if (method === 'propose') {
      check(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 100, '方案需要 1 至 100 项');
      const items = input.items.map(item => this.proposalItem(grant, item));
      return write('proposal', { title: input.title || '外部 Agent 整理方案', domain: input.domain, content: input.content || '', items });
    }
    const record = this.readable(grant, this.store.get(input.id));
    check(!record.conflict && !record.deleted, '请先在系统内处理冲突或恢复资料', 'CONFLICT');
    check(Array.isArray(input.parents) && canonical([...input.parents].sort()) === canonical(record.heads), '内容已变化，请读取最新版本', 'CONFLICT');
    if (method === 'trash') {
      check(['note', 'draft', 'source', 'annotation', 'relation', 'proposal'].includes(record.type), '不允许删除该类型');
      this.store.writeRaw({ id: record.id, type: record.type, data: record.data, parents: input.parents, deleted: true });
      return this.store.get(record.id);
    }
    if (method === 'proposalRevise') {
      check(record.type === 'proposal' && Array.isArray(input.items) && input.items.length > 0, '请选择待确认方案项');
      const updates = new Map();
      for (const item of input.items) {
        const old = record.data.items.find(entry => entry.id === item.id);
        check(old && old.status === 'pending' && !updates.has(item.id), '不能改写已确认项或重复修改同一项');
        const targetId = this.store.get(old.targetId) ? old.targetId : undefined;
        updates.set(item.id, { ...this.proposalItem(grant, { ...item, targetId, parents: old.parents }), id: old.id, targetId: old.targetId });
      }
      return write('proposal', { ...record.data, items: record.data.items.map(item => updates.get(item.id) || item) }, record.id, input.parents);
    }
    check(record.type === (method === 'noteUpdate' ? 'note' : 'draft'), '记录类型不符');
    check(input.data.domain === record.data.domain, '改换知识库请提交方案，不直接移动');
    return write(record.type, input.data, record.id, input.parents);
  }
  proposalItem(grant, item) {
    this.checkData(grant, item.data);
    const target = item.targetId && this.store.get(item.targetId);
    check(!item.targetId || target, '更新目标不存在');
    if (target) {
      this.readable(grant, target);
      check(target.type === 'note' && !target.deleted && !target.conflict, '目标必须是无冲突的正式笔记');
      check(Array.isArray(item.parents) && canonical([...item.parents].sort()) === canonical(target.heads), '目标基础版本已变化', 'CONFLICT');
    } else check(!item.parents?.length, '新笔记不应指定父版本');
    const data = target ? { ...item.data, sensitive: target.data.sensitive || item.data.sensitive === true,
      sourceIds: [...new Set([...(target.data.sourceIds || []), ...(item.data.sourceIds || [])])],
      assetIds: [...new Set([...(target.data.assetIds || []), ...(item.data.assetIds || [])])] } : item.data;
    return { id: uuid(), targetId: target?.id || uuid(), parents: target?.heads || [], data, status: 'pending' };
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
        check(req.method === 'POST' && req.url === '/v1/rpc', 'Unsupported endpoint');
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        this.authenticate(token);
        check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Expected application/json');
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          check(size <= 23 * 1024 * 1024, 'Request too large');
          chunks.push(chunk);
        }
        const grant = this.authenticate(token);
        const value = this.dispatch(grant, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ value }));
      } catch (error) {
        res.writeHead(error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403 : ['CONFLICT', 'PREFERENCES_CHANGED'].includes(error.code) ? 409 : 400,
          { 'Content-Type': 'application/json; charset=utf-8' });
        const known = ['INVALID', 'CONFLICT', 'PREFERENCES_CHANGED', 'UNAUTHORIZED', 'FORBIDDEN', 'ASSET_UNAVAILABLE'];
        res.end(JSON.stringify({ error: known.includes(error.code) ? prettyError(error) : { code: 'ERROR', message: '请求未完成，请检查参数或在系统内核对文件状态' } }));
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
