import { check, canonical } from './util.mjs';
import { PUBLIC_PERSONAL_TYPES, personalReferences } from './personal-schema.mjs';

export function validatePersonalWrite(store, type, data, id, deleted) {
  const current = store.get(id);
  if (deleted) {
    if (type === 'loginAccount') check(!store.local(`vaultDraft:${id}`), '存在未提交密码草稿，请解锁后保存或放弃', 'UNSAVED');
    if (type === 'vaultSecret') check(!store.local(`vaultDraft:${data.accountId}`), '存在未提交密码草稿，请解锁后保存或放弃', 'UNSAVED');
    for (const record of [...store.list(), ...store.list({ trash: true })]) {
      if (record.id !== id && record.type !== 'changeBatch' && !store.revertingIds?.has(record.id) && (PUBLIC_PERSONAL_TYPES.includes(type) || PUBLIC_PERSONAL_TYPES.includes(record.type) || record.type === 'vaultSecret')) check(!record.versions.some(v => personalReferences(v.data).includes(id)), '仍有任务、账目、密码或其他内容引用此记录', 'REFERENCED');
    }
    for (const draft of Object.values(store.local('personalDrafts') || {}).filter(Boolean)) check(draft.id !== id && !personalReferences(draft.data || {}).includes(id), '存在未提交业务表单或引用', 'UNSAVED');
    return;
  }
  if (![...PUBLIC_PERSONAL_TYPES, 'vaultSecret'].includes(type)) return;
  for (const ref of personalReferences(data)) {
    const record = store.get(ref);
    check(record && !record.deleted && !record.conflict && !['vaultConfig', 'vaultSecret', 'changeBatch'].includes(record.type), '关联记录不存在、已回收或有冲突', 'CONFLICT');
  }
  const requireType = (ref, types) => { if (ref) check(types.includes(store.get(ref)?.type), '关联记录类型不符'); };
  for (const ref of data.assetIds || []) requireType(ref, ['asset']);
  for (const ref of data.noteIds || []) requireType(ref, ['note', 'draft']);
  if (type === 'personalTask') {
    requireType(data.projectId, ['personalProject']); requireType(data.parentTaskId, ['personalTask']);
    let next = data.parentTaskId, depth = 1;
    while (next) {
      check(next !== id && ++depth <= 16, '任务层级循环或超过 16 层');
      const parent = store.get(next);
      check((parent.data.projectId || null) === (data.projectId || null), '上级任务应属于同一项目');
      next = parent.data.parentTaskId;
    }
    const tasks = [...store.list({ type: 'personalTask' }), ...store.list({ type: 'personalTask', trash: true })];
    const pending = [{ id, depth }], visited = new Set([id]);
    while (pending.length) {
      const parent = pending.pop();
      for (const child of tasks.filter(r => r.versions.some(v => v.data.parentTaskId === parent.id))) {
        check(!child.conflict && !visited.has(child.id), '子任务存在冲突或循环，请先处理', 'CONFLICT');
        check((child.data.projectId || null) === (data.projectId || null), '请先调整子任务项目');
        check(parent.depth < 16, '移动后任务层级超过 16 层');
        visited.add(child.id); pending.push({ id: child.id, depth: parent.depth + 1 });
      }
    }
  }
  if (type === 'subscription' || type === 'vaultSecret') requireType(data.accountId, ['loginAccount']);
  if (type === 'moneyAccount' && current) {
    check(current.data.currency === data.currency, '已有资金账户不能更换币种，请新建账户');
    for (const record of store.list({ type: 'moneyEntry' })) for (const version of record.versions) {
      const entry = version.data;
      if (entry.accountId === id || entry.kind === 'transfer' && entry.toAccountId === id) check(data.openingDate <= entry.date, '期初日期不能晚于已有账目日期');
    }
  }
  if (type === 'moneyEntry') {
    requireType(data.accountId, ['moneyAccount']); requireType(data.toAccountId, ['moneyAccount']);
    const account = store.get(data.accountId);
    check(account.data.currency === data.currency, '账目币种必须与账户一致');
    check(data.date >= account.data.openingDate && (data.kind !== 'transfer' || data.date >= store.get(data.toAccountId).data.openingDate), '记账日期不能早于账户期初日期');
    if (data.kind === 'transfer' && store.get(data.toAccountId).data.currency === data.currency) check(data.amount === data.toAmount, '同币种转账金额必须相等');
    if (data.kind === 'refund') {
      requireType(data.refundOf, ['moneyEntry']);
      const original = store.get(data.refundOf);
      check(original.data.kind === 'expense' && original.data.currency === data.currency, '退款必须关联同币种支出');
      const refunds = store.list({ type: 'moneyEntry' }).filter(r => r.id !== id && r.versions.some(v => v.data.refundOf === data.refundOf));
      check(refunds.every(r => !r.conflict), '相关退款存在冲突，请先处理', 'CONFLICT');
      check(refunds.reduce((sum, r) => sum + BigInt(r.data.amount), BigInt(data.amount)) <= BigInt(original.data.amount), '累计退款不能超过原支出');
    }
    if (current?.data.kind === 'expense') {
      const refunds = store.list({ type: 'moneyEntry' }).filter(r => r.versions.some(v => v.data.refundOf === id));
      if (refunds.length) check(data.kind === 'expense' && data.currency === current.data.currency && refunds.every(r => !r.conflict)
        && refunds.reduce((sum, r) => sum + BigInt(r.data.amount), 0n) <= BigInt(data.amount), '已有退款不能超过修改后的原支出');
    }
    requireType(data.subscriptionId, ['subscription']);
    for (const other of store.list({ type: 'moneyEntry' })) if (other.id !== id) for (const version of other.versions) {
      check(!data.importKey || version.data.importKey !== data.importKey, '此账目已导入', 'DUPLICATE');
      check(!data.subscriptionId || version.data.subscriptionId !== data.subscriptionId || version.data.period !== data.period, '本期订阅已记录付款', 'DUPLICATE');
    }
  }
  if (type === 'moneyBudget') for (const other of store.list({ type })) if (other.id !== id) check(!other.versions.some(v => canonical([v.data.month, v.data.category, v.data.currency]) === canonical([data.month, data.category, data.currency])), '相同月份、分类及币种已有预算');
}
