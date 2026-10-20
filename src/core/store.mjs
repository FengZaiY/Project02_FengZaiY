import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { filterErased, mergeErasures } from './erasures.mjs';
import { retirementReceipts, retiredAI, replacementWorkspaces } from './retired-ai.mjs';
import { TYPES, CONTENT_TYPES } from './catalog.mjs';
import { richReferences } from './rich-content.mjs';
import { cleanDraftRefs, requireSaved, validateDraftRefs } from './draft-workflow.mjs';
import { validateAssetChange } from './asset-management.mjs';
import { LibraryDirectories, legacyLibraryId } from './library-directories.mjs';
import { folderTree, folderEmpty, placedTypes, validatePlacement } from './hierarchy.mjs';
import { noteTree, hasNoteChildren, validateNotePlacement, validateProposalHierarchy, orderedProposalItems, migrateLegacyHierarchy, legacyNoteId } from './note-hierarchy.mjs';
import { compareNoteOrder, orderBetween, validNoteOrder } from './note-order.mjs';
import { uuid, now, sha, canonical, check, isId, isHash, atomicWrite, encrypt, decrypt } from './util.mjs';
const GLOBAL_SCOPE = '__all_libraries__';

const COMMON = ['title', 'domain', 'tags', 'sensitive'];
const FIELDS = {
  note: [...COMMON, 'content', 'format', 'sourceIds', 'assetIds', 'parentNoteId', 'noteOrder', 'draftOrigin'],
  draft: [...COMMON, 'content', 'format', 'sourceIds', 'assetIds'],
  conversation: [...COMMON, 'messages', 'modelId', 'assetIds'],
  source: [...COMMON, 'content', 'format', 'url', 'assetIds'],
  annotation: [...COMMON, 'content', 'noteId', 'quote'],
  relation: [...COMMON, 'from', 'to', 'description'],
  proposal: [...COMMON, 'items', 'content'],
  workspace: [...COMMON, 'tabs', 'selectedTab', 'originDevice'],
  asset: [...COMMON, 'filename', 'size', 'sha256', 'mime', 'priority'],
  library: [...COMMON, 'description'],
  folder: [...COMMON, 'description', 'parentId'],
  agentPreferences: [...COMMON, 'content'],
  provider: [...COMMON, 'providerId', 'protocol'],
  model: [...COMMON, 'providerId', 'modelName', 'inputRate', 'outputRate', 'currency', 'capabilities'],
  usage: [...COMMON, 'callId', 'taskId', 'modelId', 'inputTokens', 'outputTokens', 'usageReported', 'estimatedCost', 'billedCost', 'currency', 'recordedAt', 'pricing'],
  task: [...COMMON, 'content', 'modelId', 'ownerDevice', 'status', 'estimate', 'currency', 'sourceIds', 'pricing']
};

for (const type of placedTypes) FIELDS[type].push('folderId');

export function cleanData(type, data) {
  check(data && typeof data === 'object' && !Array.isArray(data), 'Invalid record content');
  const result = Object.fromEntries(Object.entries(data).filter(([k]) => FIELDS[type]?.includes(k)));
  check(typeof result.title === 'string' && result.title.length <= 500, 'A title of at most 500 characters is required');
  result.domain = String(result.domain || '通用').slice(0, 100);
  result.tags = Array.isArray(result.tags) ? [...new Set(result.tags.map(String))].slice(0, 100) : [];
  result.sensitive = result.sensitive === true;
  for (const field of ['folderId', 'parentId', 'parentNoteId']) {
    if (Object.hasOwn(result, field)) check(result[field] === null || isId(result[field]), '目录标识无效');
  }
  if (Object.hasOwn(result, 'noteOrder')) check(validNoteOrder(result.noteOrder), '笔记顺序无效或过长');
  if (Object.hasOwn(result, 'draftOrigin')) result.draftOrigin = cleanDraftRefs([result.draftOrigin])[0];
  check(Buffer.byteLength(canonical(result)) <= 1024 * 1024, 'A single revision must be smaller than 1 MB');
  if (type === 'library') {
    check(result.title.trim().length > 0 && result.title.length <= 100, '知识库名称须为 1 至 100 个字符');
    check(typeof result.description === 'string' && result.description.length <= 2000, '知识库说明最多 2000 个字符');
  }
  if (type === 'folder') {
    check(result.title.trim().length > 0 && result.title.length <= 100, '文件夹名称须为 1 至 100 个字符');
    check(result.description === undefined || typeof result.description === 'string' && result.description.length <= 2000, '文件夹说明最多 2000 字');
  }
  if (['note', 'draft', 'source', 'annotation', 'task', 'agentPreferences'].includes(type)) {
    check(result.content === undefined || typeof result.content === 'string', 'Content must be text');
  }
  for (const field of ['sourceIds', 'assetIds']) {
    if (result[field]) check(Array.isArray(result[field]) && result[field].every(isId), 'Invalid attachment/source IDs');
  }
  if (type === 'asset') {
    check(isHash(result.sha256) && Number.isSafeInteger(result.size) && result.size >= 0, 'Invalid attachment metadata');
    check(typeof result.filename === 'string' && result.filename.length <= 255 && !/[\\/\0]/.test(result.filename), 'Invalid attachment name');
    check(['normal', 'large'].includes(result.priority), 'Invalid attachment priority');
  }
  if (type === 'model') {
    check(typeof result.providerId === 'string' && typeof result.modelName === 'string', 'Model and provider are required');
    check(!/[?#@]/.test(result.providerId), 'Invalid provider ID');
    for (const field of ['inputRate', 'outputRate']) check(result[field] === undefined || (Number.isFinite(result[field]) && result[field] >= 0), 'Invalid model price');
    if (Array.isArray(result.capabilities)) check(result.capabilities.length <= 20
      && result.capabilities.every(value => typeof value === 'string' && value.length <= 100), 'Invalid model capabilities');
  }
  if (type === 'provider') {
    check(typeof result.providerId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(result.providerId), 'Invalid provider ID');
    check(['openai', 'gemini', 'ollama'].includes(result.protocol), 'Unsupported provider protocol');
  }
  if (type === 'usage') {
    check(typeof result.callId === 'string' && result.callId.length > 0 && result.callId.length < 200, 'Request identifier required');
    for (const field of ['inputTokens', 'outputTokens']) check(Number.isSafeInteger(result[field]) && result[field] >= 0, 'Invalid token count');
    for (const field of ['estimatedCost', 'billedCost']) check(result[field] == null || (Number.isFinite(result[field]) && result[field] >= 0), 'Invalid cost');
  }
  if (type === 'task') check(isId(result.ownerDevice), 'Task owner is required');
  if (['usage', 'task'].includes(type) && result.pricing !== undefined) {
    const price = result.pricing;
    check(price && ['auto', 'manual', 'unknown', 'local'].includes(price.status), 'Invalid price snapshot');
    check(Object.keys(price).every(key => ['status', 'reason', 'currency', 'inputRate', 'outputRate', 'basis',
      'sourceUrl', 'checkedAt', 'updatedAt'].includes(key)), 'Unexpected price snapshot fields');
    for (const field of ['inputRate', 'outputRate']) check(price[field] === undefined ||
      (Number.isFinite(price[field]) && price[field] >= 0), 'Invalid snapshot rate');
    check(price.currency == null || ['CNY', 'USD'].includes(price.currency), 'Invalid snapshot currency');
    for (const field of ['reason', 'basis', 'sourceUrl', 'checkedAt', 'updatedAt']) {
      check(price[field] == null || (typeof price[field] === 'string' && price[field].length <= 1000), 'Invalid snapshot metadata');
    }
    if (['auto', 'manual'].includes(price.status)) {
      check(Number.isFinite(price.inputRate) && Number.isFinite(price.outputRate) && price.currency, 'Incomplete price snapshot');
    }
    if (price.sourceUrl) {
      const url = new URL(price.sourceUrl);
      check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Invalid price source');
    }
  }
  if (type === 'proposal') {
    check(Array.isArray(result.items) && result.items.length <= 100, 'Invalid proposal items');
    const ids = new Set();
    result.items = result.items.map(item => {
      check(isId(item.id) && isId(item.targetId) && !ids.has(item.id), 'Invalid or duplicate proposal item');
      ids.add(item.id);
      const body = cleanData('note', item.data);
      check(Array.isArray(item.parents) && item.parents.every(isId), 'Invalid proposal base versions');
      check(item.reason === undefined || typeof item.reason === 'string' && item.reason.length <= 4000, '方案理由最多 4000 字');
      check(item.acceptedVersionId === undefined || item.status === 'accepted' && isId(item.acceptedVersionId), '方案确认版本无效');
      return { id: item.id, targetId: item.targetId, parents: item.parents, data: body, ...(item.reason !== undefined ? { reason: item.reason } : {}),
        ...(item.draftRefs !== undefined ? { draftRefs: cleanDraftRefs(item.draftRefs) } : {}),
        ...(item.acceptedVersionId !== undefined ? { acceptedVersionId: item.acceptedVersionId } : {}),
        status: item.status === 'accepted' ? 'accepted' : 'pending' };
    });
  }
  return result;
}

export function validateEvent(event) {
  check(event && event.schema === 1 && isId(event.id) && isId(event.entityId) && isId(event.deviceId), 'Invalid revision identifiers');
  check(TYPES.includes(event.type) && typeof event.deleted === 'boolean', 'Invalid revision type');
  if (Object.hasOwn(event, 'purged')) check(event.purged === true && event.deleted, 'Invalid final deletion marker');
  check(Number.isSafeInteger(event.sequence) && event.sequence > 0 && typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt)), 'Invalid revision metadata');
  check(Array.isArray(event.parents) && event.parents.length <= 100 && event.parents.every(isId)
    && new Set(event.parents).size === event.parents.length && !event.parents.includes(event.id), 'Invalid parent versions');
  const data = cleanData(event.type, event.data);
  check(canonical(data) === canonical(event.data), 'Unexpected or private fields in shared record');
  const { hash, ...content } = event;
  check(Object.keys(content).sort().join() === ['schema', 'id', 'entityId', 'type', 'deviceId', 'sequence', 'createdAt', 'parents', 'deleted', 'data', ...(event.purged ? ['purged'] : [])].sort().join(), 'Unexpected revision fields');
  check(isHash(hash) && sha(canonical(content)) === hash, 'Revision checksum mismatch');
  return event;
}

export class Store {
  constructor(directory, options = {}) {
    this.directory = path.resolve(directory);
    this.directories = new LibraryDirectories(this);
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, 'knowledge.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, type TEXT NOT NULL,
        device_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL, exported INTEGER NOT NULL DEFAULT 0,
        received INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS events_entity ON events(entity_id);
      CREATE TABLE IF NOT EXISTS heads(entity_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id),
        PRIMARY KEY(entity_id,event_id));
      CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rejected(id TEXT PRIMARY KEY, json TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS packets(id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(event_id TEXT NOT NULL, device_id TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(event_id,device_id));
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, path TEXT NOT NULL, pinned INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS local_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS erasures(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, json TEXT NOT NULL);
    `);
    if (!this.getMeta('deviceId')) this.setMeta('deviceId', uuid());
    if (!this.getMeta('deviceName')) this.setMeta('deviceName', options.deviceName || os.hostname());
    this.deviceId = this.getMeta('deviceId');
    if (!this.db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'received')) {
      this.db.exec('ALTER TABLE events ADD COLUMN received INTEGER NOT NULL DEFAULT 0');
      this.db.prepare('UPDATE events SET received=1 WHERE exported=1 AND device_id<>?').run(this.deviceId);
    }
    this.vault = options.vault;
    if (!this.vault) {
      const keyPath = path.join(this.directory, 'device-vault.key');
      if (!fs.existsSync(keyPath)) atomicWrite(keyPath, randomBytes(32));
      const key = fs.readFileSync(keyPath);
      this.vault = {
        seal: value => JSON.stringify(encrypt(Buffer.from(value), key, 'local-device-vault')),
        open: value => decrypt(JSON.parse(value), key, 'local-device-vault').toString()
      };
    }
  }
  close() { this.db.close(); }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, String(value)); }
  local(key, value) {
    if (arguments.length === 2) this.db.prepare('INSERT OR REPLACE INTO local_config VALUES(?,?)').run(key, JSON.stringify(value));
    return JSON.parse(this.db.prepare('SELECT value FROM local_config WHERE key=?').get(key)?.value || 'null');
  }
  setSecret(key, value) { this.local(`secret:${key}`, this.vault.seal(value)); }
  secret(key) { const value = this.local(`secret:${key}`); return value ? this.vault.open(value) : null; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id) { const row = this.db.prepare('SELECT json FROM events WHERE id=?').get(id); return row && JSON.parse(row.json); }
  headIds(id) { return this.db.prepare('SELECT event_id FROM heads WHERE entity_id=? ORDER BY event_id').all(id).map(row => row.event_id); }
  isPurged(id) {
    if (this.db.prepare('SELECT 1 FROM erasures WHERE entity_id=?').get(id)) return true;
    const heads = this.headIds(id);
    return heads.length > 0 && heads.every(head => this.event(head).purged === true);
  }
  isRetiredAI(id) {
    return this.db.prepare('SELECT json FROM erasures WHERE entity_id=?').all(id).some(row => retiredAI(JSON.parse(row.json).type));
  }
  get(id) {
    const heads = this.headIds(id).map(head => this.event(head));
    if (!heads.length || heads.every(event => event.purged)) return null;
    const selected = heads.find(e => !e.deleted) || heads[0];
    return { id, type: selected.type, data: selected.data, heads: heads.map(e => e.id),
      versions: heads, conflict: heads.length > 1, deleted: heads.every(e => e.deleted),
      updatedAt: heads.map(e => e.createdAt).sort().at(-1), status: this.delivery(id) };
  }
  list({ type, domain, query, trash = false, limit, folderId } = {}) {
    const sql = `SELECT e.json,e.exported,e.received,EXISTS(SELECT 1 FROM receipts r WHERE r.event_id=e.id AND r.device_id<>?) AS acknowledged
      FROM heads h JOIN events e ON e.id=h.event_id ${type ? 'WHERE e.type=?' : ''} ORDER BY e.id`;
    const rows = this.db.prepare(sql).all(...(type ? [this.deviceId, type] : [this.deviceId]));
    const grouped = new Map();
    for (const row of rows) {
      const event = JSON.parse(row.json);
      if (!grouped.has(event.entityId)) grouped.set(event.entityId, []);
      grouped.get(event.entityId).push({ ...row, event });
    }
    let records = [...grouped].map(([id, entries]) => {
      const heads = entries.map(entry => entry.event), selected = heads.find(e => !e.deleted) || heads[0];
      const states = entries.map(entry => entry.received || entry.acknowledged ? 'received' : entry.exported ? 'waiting' : 'local');
      return { id, type: selected.type, data: selected.data, heads: heads.map(e => e.id), versions: heads,
        conflict: heads.length > 1, deleted: heads.every(e => e.deleted),
        updatedAt: heads.map(e => e.createdAt).sort().at(-1),
        status: states.includes('local') ? 'local' : states.includes('waiting') ? 'waiting' : 'received' };
    }).filter(record => record.deleted === trash && !record.versions.every(event => event.purged));
    if (domain) records = records.filter(record => record.versions.some(version => version.data.domain === domain));
    if (folderId !== undefined) {
      const usable = new Set(folderTree(this, domain).filter(folder => !folder.issue).map(folder => folder.id));
      records = records.filter(record => record.type !== 'folder' && record.versions.some(version =>
        folderId ? version.data.folderId === folderId : !version.data.folderId || !usable.has(version.data.folderId)));
    }
    if (query) {
      const term = query.toLocaleLowerCase();
      records = records.filter(record => record.versions.some(version => canonical(version.data).toLocaleLowerCase().includes(term)));
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Number.isSafeInteger(limit) && limit > 0 ? records.slice(0, Math.min(limit, 10000)) : records;
  }
  insert(event, exported) {
    check(!this.retiredAI || !retiredAI(event.type), '内置 AI 历史已退役，不再入库', 'RETIRED');
    if (!filterErased([event], this.erasures()).length) return false;
    const existing = this.event(event.id);
    if (existing) { check(existing.hash === event.hash, 'Revision ID collision'); return false; }
    const entity = this.db.prepare('SELECT type,json FROM events WHERE entity_id=? LIMIT 1').get(event.entityId);
    if (entity) {
      check(entity.type === event.type, 'Record type cannot change');
      if (['library', 'folder'].includes(entity.type)) {
        check(JSON.parse(entity.json).data.domain === event.data.domain, '知识库范围标识不可更改');
      }
      if (entity.type === 'asset') {
        const original = JSON.parse(entity.json).data;
        check(original.sha256 === event.data.sha256 && original.size === event.data.size, 'An attachment ID cannot refer to different file contents');
      }
    }
    for (const parentId of event.parents) {
      const parent = this.event(parentId);
      check(parent, 'Missing parent revision', 'MISSING_PARENT');
      check(parent.entityId === event.entityId && parent.type === event.type, 'Parent belongs to a different record');
    }
    if (event.purged) {
      check(event.parents.length > 0 && event.parents.every(id => this.event(id).deleted), 'Only deleted revisions can be cleared');
      check(event.parents.some(id => canonical(this.event(id).data) === canonical(event.data)), 'Final deletion must retain revision integrity');
    } else {
      check(!event.parents.length || !event.parents.every(id => this.event(id).purged), 'Cleared content cannot be restored');
    }
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)')
      .run(event.id, event.entityId, event.type, event.deviceId, event.createdAt, JSON.stringify(event), exported ? 1 : 0, exported ? 1 : 0);
    for (const parent of event.parents) this.db.prepare('DELETE FROM heads WHERE entity_id=? AND event_id=?').run(event.entityId, parent);
    this.db.prepare('INSERT INTO heads VALUES(?,?)').run(event.entityId, event.id);
    this.local('hierarchyDirty', true);
    return true;
  }
  writeRaw({ id = uuid(), type = 'note', data, parents = [], deleted = false, allowBranch = false }) {
    check(!this.retiredAI || !retiredAI(type), '内置 AI 历史已删除，不再创建或恢复', 'RETIRED');
    check(!this.permanentDeleting, '永久删除正在处理，请稍后操作', 'BUSY');
    check(!this.local('v2Journal'), '版本操作尚未恢复，请重启恢复后再编辑', 'RECOVERY_REQUIRED');
    if (['note', 'draft', 'source'].includes(type)) {
      const { assets } = richReferences(data);
      if (assets.length) data = { ...data, assetIds: [...new Set([...(data.assetIds || []), ...assets])] };
    }
    check(isId(id) && TYPES.includes(type), 'Invalid record');
    check(!this.isPurged(id), '此内容已清空，不能再编辑或恢复', 'PURGED');
    if (allowBranch) {
      check(parents.length > 0 && parents.every(parent => this.event(parent)?.entityId === id), 'A branch requires existing base revisions');
    } else check(canonical([...parents].sort()) === canonical(this.headIds(id)), 'The record changed. Review the current versions before saving.', 'CONFLICT');
    const sequence = Number(this.getMeta('sequence') || 0) + 1;
    const content = { schema: 1, id: uuid(), entityId: id, type, deviceId: this.deviceId, sequence,
      createdAt: now(), parents: [...parents], deleted, data: cleanData(type, data) };
    if (!deleted) {
      validatePlacement(this, type, content.data, id);
      validateNotePlacement(this, type, content.data, id);
      if (type === 'proposal') validateProposalHierarchy(this, content.data.items);
    }
    if (deleted && type === 'note') check(!hasNoteChildren(this, id), '此笔记仍有下级笔记（含回收站/待确认方案），请先调整，不会连带删除');
    if (type === 'asset') validateAssetChange(this, id, content.data, deleted);
    const event = { ...content, hash: sha(canonical(content)) };
    validateEvent(event);
    this.insert(event, false);
    this.setMeta('sequence', sequence);
    return event;
  }
  write(input) {
    let event;
    this.transaction(() => { event = this.writeRaw(input); });
    return this.get(event.entityId);
  }
  purgeRaw(id, parents) {
    check(!this.local('v2Journal'), '版本操作尚未恢复，请重启后再操作', 'RECOVERY_REQUIRED');
    const record = this.get(id);
    check(record?.deleted && !record.conflict, '只能清空无冲突的回收站内容');
    check(canonical([...parents].sort()) === canonical(record.heads), '内容已变化，请重新确认', 'CONFLICT');
    const sequence = Number(this.getMeta('sequence') || 0) + 1;
    const content = { schema: 1, id: uuid(), entityId: id, type: record.type, deviceId: this.deviceId,
      sequence, createdAt: now(), parents: [...parents], deleted: true, data: record.data, purged: true };
    const event = { ...content, hash: sha(canonical(content)) };
    validateEvent(event); this.insert(event, false); this.setMeta('sequence', sequence);
    return event;
  }
  remove(id, parents) {
    const record = this.get(id);
    check(record, 'Record not found');
    if (record.type === 'library') {
      const library = this.libraries().find(item => item.id === id);
      check(!library?.contentCount, '知识库仍有资料（含回收站），请先迁移资料；不会连带删除内容');
    }
    if (record.type === 'folder') check(folderEmpty(this, id), '目录仍有子目录或内容（含回收站/待确认方案），请先移出，不会级联删除');
    return this.write({ id, type: record.type, data: record.data, parents, deleted: true });
  }
  libraries() {
    const records = [...this.list(), ...this.list({ trash: true })];
    const libraries = records.filter(record => record.type === 'library');
    const scopes = new Map();
    const noteIds = new Set(records.filter(record => record.type === 'note').map(record => record.id));
    for (const record of records.filter(record => CONTENT_TYPES.includes(record.type))) {
      if (record.type === 'folder' && noteIds.has(legacyNoteId(record.id))) continue;
      for (const scope of new Set(record.versions.map(version => version.data.domain))) {
        if (scope === GLOBAL_SCOPE) continue;
        const count = scopes.get(scope) || { active: 0, total: 0 };
        count.total++;
        if (!record.deleted) count.active++;
        scopes.set(scope, count);
      }
    }
    // Legacy catalogs are a read-only projection until the user explicitly edits one.
    for (const scope of scopes.keys()) {
      if (libraries.some(record => record.data.domain === scope)) continue;
      const id = legacyLibraryId(scope);
      libraries.push({ id, type: 'library', heads: [], versions: [], conflict: false, deleted: false,
        legacy: true, data: { title: scope, domain: scope, description: '', tags: [], sensitive: false } });
    }
    return libraries.map(record => ({ ...record,
      contentCount: scopes.get(record.data.domain)?.total || 0,
      activeCount: scopes.get(record.data.domain)?.active || 0
    })).sort((a, b) => a.data.title.localeCompare(b.data.title, 'zh-CN'));
  }
  saveLibrary({ id, title, description = '', parents = [] }) {
    check(typeof title === 'string' && title.trim(), '请输入知识库名称');
    const libraries = this.libraries();
    const existing = id && libraries.find(record => record.id === id);
    check(!id || existing, '知识库不存在');
    check(!existing?.deleted, '请先恢复知识库');
    check(!libraries.some(record => record.id !== id && !record.deleted
      && record.data.title.normalize('NFKC').toLocaleLowerCase() === title.trim().normalize('NFKC').toLocaleLowerCase()), '已存在同名知识库');
    const libraryId = existing?.id || uuid();
    return this.transaction(() => {
      this.writeRaw({ id: libraryId, type: 'library', parents,
        data: { title: title.trim(), description, domain: existing?.data.domain || libraryId } });
      const record = this.get(libraryId);
      this.directories.ensure(record);
      return record;
    });
  }
  folders(domain) { return folderTree(this, domain); }
  noteTree(domain) { return noteTree(this, domain); }
  migrateNoteHierarchy() { return migrateLegacyHierarchy(this, cleanData); }
  moveNote({ id, parentNoteId = null, parents, data, notePlacement }) {
    return this.transaction(() => {
      const record = this.get(id), placementUpdates = [];
      check(record?.type === 'note' && !record.deleted && !record.conflict, '请选择无冲突的正式笔记');
      check(canonical([...(parents || [])].sort()) === canonical(record.heads), 'The record changed. Review the current versions before saving.', 'CONFLICT');
      let next = { ...(data || record.data), folderId: null, parentNoteId };
      check(next.domain === record.data.domain, '拖动不能跨知识库');
      if ((record.data.parentNoteId || null) !== parentNoteId) next.noteOrder = null;
      if (notePlacement) {
        const { targetId, side, context } = notePlacement;
        check(['before', 'after'].includes(side) && targetId !== id, '请选择其他笔记的前方或后方');
        const nodes = this.noteTree(record.data.domain);
        const source = nodes.find(node => node.id === id), target = nodes.find(node => node.id === targetId);
        check(source && !source.issue && target && !target.issue && target.parentNoteId === parentNoteId, '目标层级已变化，请重新拖动', 'CONFLICT');
        const siblings = nodes.filter(node => node.id !== id && node.parentNoteId === parentNoteId).sort(compareNoteOrder);
        check(siblings.every(node => !node.issue && !node.conflict), '请先处理同级笔记的层级或版本冲突');
        const snapshot = siblings.map(node => ({ id: node.id, heads: node.heads })).sort((a, b) => a.id.localeCompare(b.id));
        check(Array.isArray(context) && canonical(context) === canonical(snapshot), '目标层笔记已变化，请刷新后重新拖动', 'CONFLICT');
        validateNotePlacement(this, 'note', next, id);
        const index = siblings.findIndex(node => node.id === targetId) + (side === 'after' ? 1 : 0);
        // Preserve the existing sequence when the requested position is already occupied.
        const original = nodes.filter(node => node.parentNoteId === parentNoteId).map(node => node.id);
        const desired = siblings.map(node => node.id); desired.splice(index, 0, id);
        if (canonical(original) === canonical(desired)) {
          if (canonical(cleanData('note', next)) === canonical(record.data)) return record;
          this.writeRaw({ id, type: 'note', parents, data: next });
          return this.get(id);
        }
        let last = null;
        const orders = new Map();
        for (const sibling of siblings) {
          last = sibling.data.noteOrder || orderBetween(last, null);
          orders.set(sibling.id, last);
        }
        let left = orders.get(siblings[index - 1]?.id), right = orders.get(siblings[index]?.id);
        if (left && right && compareNoteOrder({ id: '', data: { noteOrder: left } }, { id: '', data: { noteOrder: right } }) === 0) {
          // Concurrent insertions can share a rank; normalize only after validating the whole level.
          siblings.forEach((sibling, i) => orders.set(sibling.id, `${i}/1`));
          left = orders.get(siblings[index - 1]?.id); right = orders.get(siblings[index]?.id);
        }
        next.noteOrder = orderBetween(left, right);
        check(validNoteOrder(next.noteOrder), '此处排序过于密集，请先调整到其他位置');
        for (const sibling of siblings) {
          const noteOrder = orders.get(sibling.id);
          if (sibling.data.noteOrder === noteOrder) continue;
          this.writeRaw({ id: sibling.id, type: 'note', parents: sibling.heads, data: { ...sibling.data, noteOrder } });
          placementUpdates.push({ id: sibling.id, parents: sibling.heads, heads: this.headIds(sibling.id), noteOrder });
        }
      }
      this.writeRaw({ id, type: 'note', parents, data: next });
      return { ...this.get(id), placementUpdates };
    });
  }
  saveFolder({ id = uuid(), title, description = '', domain, parentId = null, parents = [] }) {
    const library = this.libraries().find(item => item.data.domain === domain);
    check(library && !library.deleted && !library.conflict, '请先选择可用知识库');
    check(typeof title === 'string', '请输入目录名称');
    return this.write({ id, type: 'folder', parents, data: { title: title.trim(), description, domain, parentId } });
  }
  moveRecord({ id, folderId = null, parents }) {
    const record = this.get(id);
    check(record && placedTypes.includes(record.type) && !record.deleted && !record.conflict, '请先恢复内容或处理冲突');
    return this.write({ id, type: record.type, parents, data: { ...record.data, folderId } });
  }
  restoreVersion(id, revision, parents) {
    check(!this.isPurged(id), '此内容已永久清空，不能恢复', 'PURGED');
    const event = this.event(revision);
    check(event?.entityId === id, 'Version not found');
    return this.write({ id, type: event.type, data: event.data, parents, deleted: false });
  }
  history(id) {
    if (this.isPurged(id)) return [];
    return this.db.prepare('SELECT json FROM events WHERE entity_id=? ORDER BY created_at DESC, id').all(id).map(row => JSON.parse(row.json));
  }
  importEvents(events) {
    check(Array.isArray(events) && events.length <= 10000, 'Invalid revision batch');
    events.forEach(validateEvent);
    return this.transaction(() => {
      const retirement = retirementReceipts(this, events);
      if (retirement.length) this.eraseRaw(retirement);
      events = [...filterErased(events, this.erasures()), ...replacementWorkspaces(events, this.erasures())];
      events.forEach(validateEvent);
      const batch = new Map(events.map(event => [event.id, event]));
      for (const event of events) {
        for (const id of event.parents) {
          const parent = batch.get(id) || this.event(id);
          if (parent) check(parent.entityId === event.entityId && parent.type === event.type, 'Parent belongs to a different record');
        }
      }
      for (const event of events) {
        const existing = this.event(event.id);
        if (existing) check(existing.hash === event.hash, 'Revision ID collision');
        const pending = this.db.prepare('SELECT json FROM pending WHERE id=?').get(event.id);
        if (pending) check(JSON.parse(pending.json).hash === event.hash, 'Pending revision ID collision');
        if (!existing) this.db.prepare('INSERT OR IGNORE INTO pending VALUES(?,?)').run(event.id, JSON.stringify(event));
      }
      let count = 0, changed;
      const rejected = [];
      do {
        changed = false;
        for (const row of this.db.prepare('SELECT * FROM pending').all()) {
          const event = JSON.parse(row.json);
          if (event.parents.every(parent => this.event(parent))) {
            try {
              this.insert(event, true);
              this.db.prepare('DELETE FROM rejected WHERE id=?').run(event.id);
              count++;
            } catch (error) {
              this.db.prepare('INSERT OR REPLACE INTO rejected VALUES(?,?,?)').run(event.id, row.json, error.message);
              rejected.push({ id: event.id, message: error.message });
            }
            this.db.prepare('DELETE FROM pending WHERE id=?').run(event.id);
            changed = true;
          }
        }
      } while (changed);
      return { count, pending: this.db.prepare('SELECT COUNT(*) AS n FROM pending').get().n, rejected };
    });
  }
  erasures() { return this.db.prepare('SELECT json FROM erasures ORDER BY id').all().map(row => JSON.parse(row.json)); }
  eraseRaw(receipts) {
    const merged = mergeErasures(this.erasures(), receipts);
    filterErased(this.allEvents(), merged);
    for (const table of ['pending', 'rejected']) {
      filterErased(this.db.prepare(`SELECT json FROM ${table}`).all().map(row => JSON.parse(row.json)), merged);
    }
    for (const receipt of receipts) {
      this.db.prepare('INSERT OR IGNORE INTO erasures VALUES(?,?,?)').run(receipt.id, receipt.entityId, JSON.stringify(receipt));
      this.db.prepare('DELETE FROM receipts WHERE event_id IN (SELECT id FROM events WHERE entity_id=?)').run(receipt.entityId);
      this.db.prepare('DELETE FROM heads WHERE entity_id=?').run(receipt.entityId);
      this.db.prepare('DELETE FROM events WHERE entity_id=?').run(receipt.entityId);
      for (const table of ['pending', 'rejected']) this.db.prepare(`DELETE FROM ${table} WHERE json_extract(json,'$.entityId')=?`).run(receipt.entityId);
    }
    this.local('hierarchyDirty', true);
  }
  allEvents() { return this.db.prepare('SELECT json FROM events ORDER BY rowid').all().map(row => JSON.parse(row.json)); }
  unexported() { return this.db.prepare('SELECT json FROM events WHERE exported=0 ORDER BY rowid').all().map(row => JSON.parse(row.json)); }
  markExported(ids) { this.transaction(() => ids.forEach(id => this.db.prepare('UPDATE events SET exported=1 WHERE id=?').run(id))); }
  receipt(ids, deviceId, at) {
    check(isId(deviceId) && typeof at === 'string', 'Invalid receipt');
    check(ids.length <= 10000 && ids.every(isId), 'Invalid receipt IDs');
    this.transaction(() => ids.forEach(id => this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?,?)').run(id, deviceId, at)));
    this.setMeta('lastReceiptAt', now());
  }
  delivery(id) {
    const heads = this.headIds(id);
    const states = heads.map(head => {
      const row = this.db.prepare('SELECT exported,received FROM events WHERE id=?').get(head);
      if (row.received) return 'received';
      if (this.db.prepare('SELECT 1 FROM receipts WHERE event_id=? AND device_id<>?').get(head, this.deviceId)) return 'received';
      return row.exported ? 'waiting' : 'local';
    });
    return states.includes('local') ? 'local' : states.includes('waiting') ? 'waiting' : 'received';
  }
  bindAsset(id, file, pinned = false) {
    this.db.prepare('INSERT OR REPLACE INTO assets VALUES(?,?,?)').run(id, path.resolve(file), pinned ? 1 : 0);
    this.local('hierarchyDirty', true);
  }
  assetLocation(id) { return this.db.prepare('SELECT path,pinned FROM assets WHERE id=?').get(id); }
  approve(proposalId, itemIds, parents) {
    return this.transaction(() => {
      const record = this.get(proposalId);
      check(record?.type === 'proposal' && !record.deleted && !record.conflict, 'Proposal must be unambiguous');
      check(canonical(record.heads) === canonical([...parents].sort()), 'Proposal has changed', 'CONFLICT');
      check(Array.isArray(itemIds) && itemIds.length > 0 && itemIds.every(id => record.data.items.some(i => i.id === id)), 'Select valid proposal items');
      const items = structuredClone(record.data.items);
      const selected = orderedProposalItems(this, items, itemIds);
      if (!selected.length) return record;
      for (const item of selected) {
        validateDraftRefs(this, item.draftRefs);
        requireSaved(this, [item.targetId]);
        check(item.data.domain !== GLOBAL_SCOPE, '请先为方案选择目标知识库');
        const library = this.libraries().find(entry => entry.data.domain === item.data.domain);
        check(!library || (!library.deleted && !library.conflict), '方案目标知识库已删除或存在冲突');
        if (item.draftRefs?.length) {
          item.data.sourceIds = [...new Set([...(item.data.sourceIds || []), ...item.draftRefs.map(ref => ref.id)])];
          item.data.sensitive ||= item.draftRefs.some(ref => this.get(ref.id).data.sensitive);
        }
        const event = this.writeRaw({ id: item.targetId, type: 'note', data: item.data, parents: item.parents });
        item.status = 'accepted';
        if (item.draftRefs?.length) item.acceptedVersionId = event.id;
      }
      this.writeRaw({ id: proposalId, type: 'proposal', data: { ...record.data, items }, parents: record.heads });
      return this.get(proposalId);
    });
  }
  usage() {
    const records = this.list({ type: 'usage' }), seen = new Map(), totals = {}, duplicates = [];
    for (const record of records) {
      const data = record.data;
      if (seen.has(data.callId)) { duplicates.push(data.callId); continue; }
      seen.set(data.callId, data);
      const currency = data.currency || 'CNY';
      totals[currency] ||= { estimated: 0, billed: 0, inputTokens: 0, outputTokens: 0, requests: 0, unknownUsage: 0, unknownCost: 0 };
      const total = totals[currency];
      total.estimated += data.estimatedCost || 0;
      total.billed += data.billedCost || 0;
      total.inputTokens += data.inputTokens; total.outputTokens += data.outputTokens; total.requests++;
      if (data.usageReported === false) total.unknownUsage++;
      if (data.estimatedCost == null) total.unknownCost++;
    }
    return { totals, duplicates, asOf: records.map(r => r.updatedAt).sort().at(-1) || null,
      lastReceiptAt: this.getMeta('lastReceiptAt') || null, realtime: false };
  }
  summary() {
    const stats = this.db.prepare(`WITH current AS (
      SELECT e.type,h.entity_id,COUNT(*) AS branches,MIN(json_extract(e.json,'$.deleted')) AS deleted,
        MIN(COALESCE(json_extract(e.json,'$.purged'),0)) AS purged
      FROM heads h JOIN events e ON e.id=h.event_id GROUP BY h.entity_id,e.type)
      SELECT type,SUM(deleted=0) AS active,SUM(deleted=1) AS trash,SUM(branches>1) AS conflicts FROM current WHERE purged=0 GROUP BY type`).all();
    return { deviceId: this.deviceId, deviceName: this.getMeta('deviceName'),
      counts: Object.fromEntries(TYPES.map(type => [type, stats.find(s => s.type === type)?.active || 0])),
      conflicts: stats.reduce((sum, s) => sum + s.conflicts, 0),
      trash: stats.reduce((sum, s) => sum + s.trash, 0), pendingParents: this.db.prepare('SELECT COUNT(*) AS n FROM pending').get().n,
      unexported: this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE exported=0').get().n,
      domains: this.db.prepare("SELECT DISTINCT json_extract(e.json,'$.data.domain') AS name FROM heads h JOIN events e ON e.id=h.event_id").all().map(row => row.name),
      lastReceiptAt: this.getMeta('lastReceiptAt') || null };
  }
}
