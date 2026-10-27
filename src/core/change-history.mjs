import { canonical, check } from './util.mjs';
import { references } from './trash.mjs';
import { SECRET_TYPES } from './personal-schema.mjs';

export class ChangeHistory {
  constructor(store, vault) { this.store = store; this.vault = vault; }
  list({ offset = 0, limit = 100 } = {}) {
    check(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 200, '分页无效');
    const batches = this.store.list({ type: 'changeBatch' });
    return { total: batches.length, rows: batches.slice(offset, offset + limit).map(record => ({ id: record.id, title: record.data.title,
      at: record.updatedAt, actor: record.data.actor, count: record.data.entries.length, reversalOf: record.data.reversalOf || null })) };
  }
  detail(id) {
    const batch = this.store.get(id); check(batch?.type === 'changeBatch' && !batch.conflict, '修改批次不存在或有冲突');
    return { ...batch, items: batch.data.entries.map(entry => {
      const before = entry.before.map(id => this.store.event(id)), after = entry.after.map(id => this.store.event(id));
      const secret = [...before, ...after].some(v => v && SECRET_TYPES.includes(v.type));
      return { id: entry.id, title: secret ? '密码库修改' : after[0]?.data.title || before[0]?.data.title || '已永久清理',
        secret, before: secret ? null : before, after: secret ? null : after,
        current: this.store.headIds(entry.id), available: after.every(Boolean) && before.every(Boolean) };
    }) };
  }
  undo({ id }) {
    const batch = this.store.get(id); check(batch?.type === 'changeBatch' && !batch.conflict, '修改批次不存在或有冲突');
    check(!this.store.list({ type: 'changeBatch' }).some(r => r.data.reversalOf === id), '此批次已撤回', 'CONFLICT');
    const entries = batch.data.entries, ids = new Set(entries.map(e => e.id));
    for (const entry of entries) {
      check(canonical(this.store.headIds(entry.id)) === canonical([...entry.after].sort()), '内容已有后续修改，请查看差异后处理', 'CONFLICT');
      check(entry.before.length <= 1 && entry.before.every(id => this.store.event(id)) && entry.after.every(id => this.store.event(id)), '原版本缺失或涉及合并，请逐条恢复', 'CONFLICT');
      const current = this.store.get(entry.id);
      check(current && !this.store.isPurged(entry.id), '记录已永久清理，不能撤回');
      if (SECRET_TYPES.includes(current.type)) this.vault.requireUnlocked();
      check(current.type !== 'vaultConfig', '主密码变更请使用密码库恢复功能');
      check(!(this.store.local('workspace')?.tabs || []).some(t => t.recordId === entry.id && t.dirty), '请先处理未保存内容', 'UNSAVED');
      check(!Object.values(this.store.local('personalDrafts') || {}).some(d => d.id === entry.id), '请先保存或放弃未保存表单', 'UNSAVED');
      for (const record of [...this.store.list(), ...this.store.list({ trash: true })]) {
        if (ids.has(record.id) || record.type === 'changeBatch') continue;
        if (!entry.before.length) check(!record.versions.some(v => references(v.data).has(entry.id)), '新增记录已被其他内容引用，不能撤回', 'REFERENCED');
      }
    }
    return this.store.change(`撤回：${batch.data.title}`, '用户', () => {
      const records = [];
      this.store.revertingIds = ids;
      try {
      for (const entry of [...entries].reverse()) {
        const current = this.store.get(entry.id), previous = entry.before.length ? this.store.event(entry.before[0]) : null;
        this.store.writeRaw({ id: entry.id, type: current.type, data: previous?.data || current.data, parents: current.heads, deleted: previous ? previous.deleted : true });
        records.push(entry.id);
      }
      return { ids: records };
      } finally { this.store.revertingIds = null; }
    }, id);
  }
}
