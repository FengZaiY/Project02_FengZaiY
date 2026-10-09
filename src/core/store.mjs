import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { TYPES, PROVIDERS } from './catalog.mjs';
import { uuid, now, sha, canonical, check, isId, isHash, atomicWrite, encrypt, decrypt } from './util.mjs';

const COMMON = ['title', 'domain', 'tags', 'sensitive'];
const FIELDS = {
  note: [...COMMON, 'content', 'format', 'sourceIds', 'assetIds'],
  draft: [...COMMON, 'content', 'format', 'sourceIds', 'assetIds'],
  conversation: [...COMMON, 'messages', 'modelId'],
  source: [...COMMON, 'content', 'format', 'url', 'assetIds'],
  annotation: [...COMMON, 'content', 'noteId', 'quote'],
  relation: [...COMMON, 'from', 'to', 'description'],
  proposal: [...COMMON, 'items', 'content'],
  workspace: [...COMMON, 'tabs', 'selectedTab', 'originDevice'],
  asset: [...COMMON, 'filename', 'size', 'sha256', 'mime', 'priority'],
  provider: [...COMMON, 'providerId', 'protocol'],
  model: [...COMMON, 'providerId', 'modelName', 'inputRate', 'outputRate', 'currency', 'capabilities'],
  usage: [...COMMON, 'callId', 'taskId', 'modelId', 'inputTokens', 'outputTokens', 'usageReported', 'estimatedCost', 'billedCost', 'currency', 'recordedAt'],
  task: [...COMMON, 'content', 'modelId', 'ownerDevice', 'status', 'estimate', 'currency', 'sourceIds']
};

export function cleanData(type, data) {
  check(data && typeof data === 'object' && !Array.isArray(data), 'Invalid record content');
  const result = Object.fromEntries(Object.entries(data).filter(([k]) => FIELDS[type]?.includes(k)));
  check(typeof result.title === 'string' && result.title.length <= 500, 'A title of at most 500 characters is required');
  result.domain = String(result.domain || '通用').slice(0, 100);
  result.tags = Array.isArray(result.tags) ? [...new Set(result.tags.map(String))].slice(0, 100) : [];
  result.sensitive = result.sensitive === true;
  check(Buffer.byteLength(canonical(result)) <= 1024 * 1024, 'A single revision must be smaller than 1 MB');
  if (['note', 'draft', 'source', 'annotation', 'task'].includes(type)) {
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
  if (type === 'proposal') {
    check(Array.isArray(result.items) && result.items.length <= 100, 'Invalid proposal items');
    const ids = new Set();
    result.items = result.items.map(item => {
      check(isId(item.id) && isId(item.targetId) && !ids.has(item.id), 'Invalid or duplicate proposal item');
      ids.add(item.id);
      const body = cleanData('note', item.data);
      check(Array.isArray(item.parents) && item.parents.every(isId), 'Invalid proposal base versions');
      return { id: item.id, targetId: item.targetId, parents: item.parents, data: body,
        status: item.status === 'accepted' ? 'accepted' : 'pending' };
    });
  }
  return result;
}

export function validateEvent(event) {
  check(event && event.schema === 1 && isId(event.id) && isId(event.entityId) && isId(event.deviceId), 'Invalid revision identifiers');
  check(TYPES.includes(event.type) && typeof event.deleted === 'boolean', 'Invalid revision type');
  check(Number.isSafeInteger(event.sequence) && event.sequence > 0 && typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt)), 'Invalid revision metadata');
  check(Array.isArray(event.parents) && event.parents.length <= 100 && event.parents.every(isId)
    && new Set(event.parents).size === event.parents.length && !event.parents.includes(event.id), 'Invalid parent versions');
  const data = cleanData(event.type, event.data);
  check(canonical(data) === canonical(event.data), 'Unexpected or private fields in shared record');
  const { hash, ...content } = event;
  check(Object.keys(content).sort().join() === ['schema', 'id', 'entityId', 'type', 'deviceId', 'sequence', 'createdAt', 'parents', 'deleted', 'data'].sort().join(), 'Unexpected revision fields');
  check(isHash(hash) && sha(canonical(content)) === hash, 'Revision checksum mismatch');
  return event;
}

export class Store {
  constructor(directory, options = {}) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, 'knowledge.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
  get(id) {
    const heads = this.headIds(id).map(head => this.event(head));
    if (!heads.length) return null;
    const selected = heads.find(e => !e.deleted) || heads[0];
    return { id, type: selected.type, data: selected.data, heads: heads.map(e => e.id),
      versions: heads, conflict: heads.length > 1, deleted: heads.every(e => e.deleted),
      updatedAt: heads.map(e => e.createdAt).sort().at(-1), status: this.delivery(id) };
  }
  list({ type, domain, query, trash = false, limit } = {}) {
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
    }).filter(record => record.deleted === trash);
    if (domain) records = records.filter(record => record.versions.some(version => version.data.domain === domain));
    if (query) {
      const term = query.toLocaleLowerCase();
      records = records.filter(record => record.versions.some(version => canonical(version.data).toLocaleLowerCase().includes(term)));
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Number.isSafeInteger(limit) && limit > 0 ? records.slice(0, Math.min(limit, 10000)) : records;
  }
  insert(event, exported) {
    const existing = this.event(event.id);
    if (existing) { check(existing.hash === event.hash, 'Revision ID collision'); return false; }
    const entity = this.db.prepare('SELECT type,json FROM events WHERE entity_id=? LIMIT 1').get(event.entityId);
    if (entity) {
      check(entity.type === event.type, 'Record type cannot change');
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
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)')
      .run(event.id, event.entityId, event.type, event.deviceId, event.createdAt, JSON.stringify(event), exported ? 1 : 0, exported ? 1 : 0);
    for (const parent of event.parents) this.db.prepare('DELETE FROM heads WHERE entity_id=? AND event_id=?').run(event.entityId, parent);
    this.db.prepare('INSERT INTO heads VALUES(?,?)').run(event.entityId, event.id);
    return true;
  }
  writeRaw({ id = uuid(), type = 'note', data, parents = [], deleted = false, allowBranch = false }) {
    check(isId(id) && TYPES.includes(type), 'Invalid record');
    if (allowBranch) {
      check(parents.length > 0 && parents.every(parent => this.event(parent)?.entityId === id), 'A branch requires existing base revisions');
    } else check(canonical([...parents].sort()) === canonical(this.headIds(id)), 'The record changed. Review the current versions before saving.', 'CONFLICT');
    const sequence = Number(this.getMeta('sequence') || 0) + 1;
    const content = { schema: 1, id: uuid(), entityId: id, type, deviceId: this.deviceId, sequence,
      createdAt: now(), parents: [...parents], deleted, data: cleanData(type, data) };
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
  remove(id, parents) {
    const record = this.get(id);
    check(record, 'Record not found');
    return this.write({ id, type: record.type, data: record.data, parents, deleted: true });
  }
  restoreVersion(id, revision, parents) {
    const event = this.event(revision);
    check(event?.entityId === id, 'Version not found');
    return this.write({ id, type: event.type, data: event.data, parents, deleted: false });
  }
  history(id) {
    return this.db.prepare('SELECT json FROM events WHERE entity_id=? ORDER BY created_at DESC, id').all(id).map(row => JSON.parse(row.json));
  }
  importEvents(events) {
    check(Array.isArray(events) && events.length <= 10000, 'Invalid revision batch');
    events.forEach(validateEvent);
    const batch = new Map(events.map(event => [event.id, event]));
    for (const event of events) {
      for (const id of event.parents) {
        const parent = batch.get(id) || this.event(id);
        if (parent) check(parent.entityId === event.entityId && parent.type === event.type, 'Parent belongs to a different record');
      }
    }
    return this.transaction(() => {
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
  }
  assetLocation(id) { return this.db.prepare('SELECT path,pinned FROM assets WHERE id=?').get(id); }
  approve(proposalId, itemIds, parents) {
    return this.transaction(() => {
      const record = this.get(proposalId);
      check(record?.type === 'proposal' && !record.deleted && !record.conflict, 'Proposal must be unambiguous');
      check(canonical(record.heads) === canonical([...parents].sort()), 'Proposal has changed', 'CONFLICT');
      check(Array.isArray(itemIds) && itemIds.length > 0 && itemIds.every(id => record.data.items.some(i => i.id === id)), 'Select valid proposal items');
      const items = structuredClone(record.data.items);
      for (const item of items.filter(i => itemIds.includes(i.id) && i.status !== 'accepted')) {
        this.writeRaw({ id: item.targetId, type: 'note', data: item.data, parents: item.parents });
        item.status = 'accepted';
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
      SELECT e.type,h.entity_id,COUNT(*) AS branches,MIN(json_extract(e.json,'$.deleted')) AS deleted
      FROM heads h JOIN events e ON e.id=h.event_id GROUP BY h.entity_id,e.type)
      SELECT type,SUM(deleted=0) AS active,SUM(deleted=1) AS trash,SUM(branches>1) AS conflicts FROM current GROUP BY type`).all();
    return { deviceId: this.deviceId, deviceName: this.getMeta('deviceName'),
      counts: Object.fromEntries(TYPES.map(type => [type, stats.find(s => s.type === type)?.active || 0])),
      conflicts: stats.reduce((sum, s) => sum + s.conflicts, 0),
      trash: stats.reduce((sum, s) => sum + s.trash, 0), pendingParents: this.db.prepare('SELECT COUNT(*) AS n FROM pending').get().n,
      unexported: this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE exported=0').get().n, providers: PROVIDERS,
      domains: this.db.prepare("SELECT DISTINCT json_extract(e.json,'$.data.domain') AS name FROM heads h JOIN events e ON e.id=h.event_id").all().map(row => row.name),
      lastReceiptAt: this.getMeta('lastReceiptAt') || null };
  }
}
