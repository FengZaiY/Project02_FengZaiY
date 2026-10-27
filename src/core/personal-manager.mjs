import { check, uuid, canonical, sha } from './util.mjs';
import { PUBLIC_PERSONAL_TYPES, PERSONAL_FIELDS, SECRET_TYPES, minorUnits, convertMoney, decimalMoney, cleanPersonal } from './personal-schema.mjs';
import { validatePersonalWrite } from './personal-records.mjs';

const stableId = value => { const text = sha(value); return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`; };
const ledgerId = data => data.subscriptionId ? stableId(`subscription:${data.subscriptionId}:${data.period}`) : data.importKey ? stableId(`ledger-import:${data.importKey}`) : undefined;
const sum = (a, b) => { const result = a + b; check(Number.isSafeInteger(result), '汇总金额超出安全范围'); return result; };
const csvIdentity = data => sha(canonical(Object.fromEntries(['title', 'date', 'kind', 'accountId', 'currency', 'amount', 'rate', 'category', 'content', 'toAccountId', 'toAmount', 'refundOf', 'subscriptionId', 'period'].filter(key => data[key] !== undefined && data[key] !== '').map(key => [key, data[key]]))));
export function parseCsv(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= 5 * 1024 * 1024, 'CSV 最大 5 MiB');
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (quoted) {
      check(char !== undefined, 'CSV 引号未闭合');
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === '"') { check(!field && !closed, 'CSV 引号位置无效'); quoted = true; }
    else if (char === ',' || char === '\n' || char === '\r' || char === undefined) {
      row.push(field); field = ''; closed = false;
      if (char !== ',') { if (row.some(v => v !== '')) rows.push(row); row = []; if (char === '\r' && text[i + 1] === '\n') i++; }
    } else { check(!closed, 'CSV 引号之后应为分隔符'); field += char; }
    check(rows.length <= 2001 && row.length <= 50, 'CSV 最多 2000 条记录、50 列');
  }
  return rows;
}
export class PersonalManager {
  constructor(store) { this.store = store; }
  list({ type, query = '', trash = false } = {}) {
    check(!type || PUBLIC_PERSONAL_TYPES.includes(type), '该记录不属于公开个人管理数据', 'FORBIDDEN');
    return this.store.list({ type, query: String(query).slice(0, 500), trash }).filter(r => PUBLIC_PERSONAL_TYPES.includes(r.type));
  }
  search({ query = '', limit = 100 } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 200, '分页无效');
    return this.store.list({ query: String(query).slice(0, 500) }).filter(r => !SECRET_TYPES.includes(r.type) && !['changeBatch', 'workspace', 'agentPreferences'].includes(r.type))
      .slice(0, limit).map(({ id, type, data, heads, conflict }) => ({ id, type, title: data.title, domain: data.domain, heads, conflict }));
  }
  save(input, actor = '用户') {
    check(PUBLIC_PERSONAL_TYPES.includes(input.type), '该类型不能通过普通业务接口修改', 'FORBIDDEN');
    const data = input.data;
    check(data && typeof data === 'object', '请填写记录');
    let id = input.id || uuid();
    if (!input.id && input.type === 'moneyEntry') id = ledgerId(data) || id;
    return this.store.change(`保存${({ personalTask: '任务', personalProject: '项目', loginAccount: '账号', subscription: '订阅', moneyAccount: '资金账户', moneyEntry: '账目', moneyBudget: '预算', materialCollection: '资料集合' })[input.type]}`, actor,
      () => this.store.write({ id, type: input.type, data, parents: input.parents || [] }));
  }
  batch({ items, title = '批量修改' }, actor = '用户') {
    check(Array.isArray(items) && items.length > 0 && items.length <= 200, '批次需要 1 至 200 项');
    return this.store.change(String(title).slice(0, 500), actor, () => ({ records: items.map(item => this.save(item, actor)) }));
  }
  remove({ id, parents }, actor = '用户') {
    const record = this.store.get(id); check(record && PUBLIC_PERSONAL_TYPES.includes(record.type), '不可回收此类型');
    return this.store.change('移入回收站', actor, () => this.store.remove(id, parents));
  }
  restore({ id, revision, parents }, actor = '用户') {
    const record = this.store.get(id); check(record && PUBLIC_PERSONAL_TYPES.includes(record.type), '不可恢复此类型');
    return this.store.change('恢复修改版本', actor, () => this.store.restoreVersion(id, revision, parents));
  }
  draft({ view, value, clear = false }) {
    check(['finance', 'accounts', 'tasks', 'materials'].includes(view), '表单位置无效');
    const drafts = this.store.local('personalDrafts') || {};
    if (clear) delete drafts[view];
    else if (value !== undefined) {
      check(value && PUBLIC_PERSONAL_TYPES.includes(value.type) && typeof value.data === 'object', '不允许持久化秘密表单');
      check(Object.keys(value).every(k => ['id', 'type', 'parents', 'data', 'raw'].includes(k)) && Object.keys(value.data).every(k => ['title', 'domain', 'tags', 'sensitive', ...PERSONAL_FIELDS[value.type]].includes(k)), '表单包含不支持的字段');
      // Incomplete form values remain local; secrets only use encrypted vault drafts.
      check(!JSON.stringify(value).match(/"(?:password|recoveryKey|recoveryCodes|secretNotes|box)"\s*:/i), '密码请在独立密码库中编辑');
      check(Buffer.byteLength(canonical(value)) < 100000, '表单草稿过大'); drafts[view] = value;
    }
    if (value !== undefined || clear) this.store.local('personalDrafts', drafts);
    return drafts[view] || null;
  }
  report({ month = new Date().toISOString().slice(0, 7) } = {}) {
    check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), '月份无效');
    const accounts = this.list({ type: 'moneyAccount' }), entries = this.list({ type: 'moneyEntry' }), problems = [];
    const balances = new Map(accounts.filter(r => !r.conflict).map(r => [r.id, r.data.opening]));
    let income = 0, expense = 0, assets = 0, liabilities = 0;
    const categories = new Map(), days = new Map(), budgets = this.list({ type: 'moneyBudget' }).filter(r => r.data.month === month);
    const invalidBudgets = new Set(budgets.filter(r => r.conflict || budgets.some(other => other.id !== r.id && canonical([other.data.month, other.data.category, other.data.currency]) === canonical([r.data.month, r.data.category, r.data.currency]))).map(r => r.id));
    for (const budget of budgets) if (invalidBudgets.has(budget.id)) problems.push(`${budget.data.title}存在预算冲突或重复分类预算`);
    for (const account of accounts) if (account.conflict) problems.push(`${account.data.title}存在账户冲突`);
    const valid = [];
    const invalidRefunds = new Set();
    for (const original of entries.filter(r => r.data.kind === 'expense')) {
      const refunds = entries.filter(r => r.versions.some(v => v.data.refundOf === original.id));
      if (refunds.some(r => r.conflict || r.data.currency !== original.data.currency) || refunds.reduce((total, r) => total + BigInt(r.data.amount), 0n) > BigInt(original.data.amount)) for (const refund of refunds) invalidRefunds.add(refund.id);
    }
    for (const record of entries) {
      const e = record.data, account = accounts.find(a => a.id === e.accountId), target = accounts.find(a => a.id === e.toAccountId);
      const duplicate = entries.some(other => other.id !== record.id && (e.importKey && other.data.importKey === e.importKey || e.subscriptionId && other.data.subscriptionId === e.subscriptionId && other.data.period === e.period));
      if (record.conflict || duplicate || invalidRefunds.has(record.id) || !balances.has(e.accountId) || e.date < account?.data.openingDate || e.kind === 'transfer' && (!balances.has(e.toAccountId) || e.date < target?.data.openingDate || e.currency === target?.data.currency && e.amount !== e.toAmount)
        || account?.data.currency !== e.currency || e.kind === 'refund' && !entries.some(r => r.id === e.refundOf && !r.conflict && r.data.kind === 'expense')) {
        problems.push(`${e.title}存在冲突或无效关联，未计入统计`); continue;
      }
      valid.push(record);
      const delta = ['expense', 'transfer'].includes(e.kind) ? -e.amount : e.amount;
      balances.set(e.accountId, sum(balances.get(e.accountId), delta));
      if (e.kind === 'transfer') balances.set(target.id, sum(balances.get(target.id), e.toAmount));
      if (!e.date.startsWith(month) || !['income', 'expense', 'refund'].includes(e.kind)) continue;
      const converted = convertMoney(e.amount, e.currency, e.rate);
      if (converted === null) { problems.push(`${e.title}缺少汇率，未计入人民币报表`); continue; }
      const day = days.get(e.date) || { date: e.date, income: 0, expense: 0 };
      if (e.kind === 'income') { income = sum(income, converted); day.income = sum(day.income, converted); }
      else {
        const amount = e.kind === 'refund' ? -converted : converted;
        expense = sum(expense, amount); day.expense = sum(day.expense, amount);
        const category = e.kind === 'refund' ? entries.find(r => r.id === e.refundOf)?.data.category || e.category : e.category;
        categories.set(category || '未分类', sum(categories.get(category || '未分类') || 0, amount));
      }
      days.set(e.date, day);
    }
    const rows = accounts.map(account => {
      const balance = balances.get(account.id), value = balance === undefined ? null : convertMoney(balance, account.data.currency, account.data.rate);
      if (value === null) problems.push(`${account.data.title}未计入资产汇总`);
      else if (account.data.kind === 'liability') liabilities = sum(liabilities, -value);
      else assets = sum(assets, value);
      return { ...account, balance: balance ?? null, value };
    });
    return { month, currency: 'CNY', income, expense, netIncome: sum(income, -expense), assets, liabilities, netAssets: sum(assets, -liabilities), accounts: rows,
      categories: [...categories].map(([category, amount]) => ({ category, amount })), days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      budgets: budgets.map(record => {
        const used = valid.filter(r => r.data.date.startsWith(month) && r.data.currency === record.data.currency).reduce((total, r) => {
          const original = r.data.kind === 'refund' && entries.find(e => e.id === r.data.refundOf);
          if ((original ? original.data.category : r.data.category) !== record.data.category) return total;
          return sum(total, r.data.kind === 'expense' ? r.data.amount : r.data.kind === 'refund' ? -r.data.amount : 0);
        }, 0);
        return { ...record, used: invalidBudgets.has(record.id) ? null : used, remaining: invalidBudgets.has(record.id) ? null : sum(record.data.amount, -used) };
      }), problems: [...new Set(problems)], complete: !problems.length };
  }
  paySubscription({ id, parents, accountId, date, amount, rate }, actor = '用户') {
    const subscription = this.store.get(id);
    check(subscription?.type === 'subscription' && !subscription.deleted && !subscription.conflict && canonical(subscription.heads) === canonical([...(parents || [])].sort()), '订阅已变化，请重新读取', 'CONFLICT');
    const data = subscription.data, period = data.nextDate, entryId = stableId(`subscription:${id}:${period}`);
    check(data.status === 'active', '请先恢复订阅，再记录付款');
    return this.store.change('记录订阅付款', actor, () => {
      const previous = this.store.get(entryId);
      check(!previous || previous.deleted && !previous.conflict, '本期付款已有记录或存在冲突，请先核对', 'CONFLICT');
      const entry = this.save({ id: entryId, parents: previous?.heads || [], type: 'moneyEntry', data: { title: `${data.title} · 续费`, kind: 'expense', accountId,
        amount: amount ?? data.amount, currency: data.currency, date, rate: rate || '', category: '订阅', subscriptionId: id, period, assetIds: data.assetIds || [] } }, actor);
      const due = new Date(`${period}T00:00:00Z`), day = due.getUTCDate();
      if (data.cycle === 'weekly') due.setUTCDate(day + 7);
      else if (data.cycle !== 'once') {
        due.setUTCDate(1); due.setUTCMonth(due.getUTCMonth() + ({ monthly: 1, quarterly: 3, yearly: 12 })[data.cycle]);
        const last = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate(); due.setUTCDate(Math.min(day, last));
      }
      this.save({ id, type: 'subscription', parents, data: { ...data, nextDate: due.toISOString().slice(0, 10), ...(data.cycle === 'once' ? { status: 'cancelled' } : {}) } }, actor);
      return entry;
    });
  }
  csvPreview({ csv, mapping = {} }) {
    const parsed = parseCsv(csv); check(parsed.length > 0, 'CSV 为空'); const headers = parsed[0];
    check(new Set(headers).size === headers.length, 'CSV 列名不能重复');
    const accounts = this.list({ type: 'moneyAccount' }).filter(r => !r.conflict), rows = [], errors = [], seen = new Set();
    const existing = new Set(this.list({ type: 'moneyEntry' }).flatMap(r => r.versions.flatMap(v => [v.data.importKey, csvIdentity(v.data)]).filter(Boolean)));
    for (let index = 1; index < parsed.length; index++) {
      try {
        check(parsed[index].length === headers.length, '列数与表头不一致');
        const raw = Object.fromEntries(headers.map((name, i) => [name, parsed[index][i]]));
        const cell = name => raw[mapping[name] || name] || '';
        const findAccount = name => { const matches = accounts.filter(r => r.id === name || r.data.title === name); check(matches.length === 1, `账户不存在或重名：${name}`); return matches[0]; };
        const account = findAccount(cell('account')), code = cell('currency') || account.data.currency, kind = cell('kind') || 'expense';
        check(['income', 'expense', 'transfer', 'adjustment', 'refund'].includes(kind), 'CSV 类型应为 income、expense、transfer、refund 或 adjustment');
        const data = { title: cell('title') || cell('category') || '导入账目', date: cell('date'), kind, accountId: account.id,
          currency: code, amount: minorUnits(cell('amount'), code), rate: cell('rate'), category: cell('category'), content: cell('content') };
        if (kind === 'transfer') { const target = findAccount(cell('toAccount')); data.toAccountId = target.id; data.toAmount = minorUnits(cell('toAmount') || cell('amount'), target.data.currency); }
        if (kind === 'refund') data.refundOf = cell('refundOf');
        if (cell('subscriptionId')) { data.subscriptionId = cell('subscriptionId'); data.period = cell('period'); }
        const key = cell('importKey') || csvIdentity(data); data.importKey = key;
        const cleaned = cleanPersonal('moneyEntry', data);
        const id = ledgerId(cleaned), previous = this.store.get(id);
        check(!this.store.isPurged(id), '此账目已永久清理，不能重新导入', 'PURGED');
        if (!existing.has(key)) {
          check(!previous || previous.deleted && !previous.conflict, '账目身份已有记录或存在冲突，请先核对', 'CONFLICT');
          validatePersonalWrite(this.store, 'moneyEntry', cleaned, id, false);
        }
        const duplicate = existing.has(key) || seen.has(key); seen.add(key);
        rows.push({ line: index + 1, id, parents: previous?.heads || [], data, duplicate });
      } catch (error) { errors.push({ line: index + 1, message: error.message }); }
    }
    return { headers, rows, errors, token: sha(canonical({ csv, mapping, accounts: accounts.map(r => [r.id, r.heads]), existing: [...existing].sort(), versions: rows.map(r => [r.id, r.parents]) })) };
  }
  csvImport({ csv, mapping, token }, actor = '用户') {
    const preview = this.csvPreview({ csv, mapping }); check(preview.token === token && !preview.errors.length, '导入预览已过期或存在错误，请重新检查', 'CONFLICT');
    const rows = preview.rows.filter(r => !r.duplicate); check(rows.length <= 2000, '单次导入最多 2000 条');
    return this.store.change('CSV 导入账目', actor, () => ({ count: rows.length, skipped: preview.rows.length - rows.length,
      ids: rows.map(r => this.save({ id: r.id, parents: r.parents, type: 'moneyEntry', data: r.data }, actor).id) }));
  }
  csvExport() {
    const header = ['date', 'title', 'kind', 'account', 'toAccount', 'amount', 'toAmount', 'currency', 'rate', 'category', 'content', 'importKey', 'refundOf', 'subscriptionId', 'period'];
    const rows = this.list({ type: 'moneyEntry' }).filter(r => !r.conflict).map(r => {
      const d = r.data; return [d.date, d.title, d.kind, d.accountId, d.toAccountId || '', decimalMoney(d.amount, d.currency), d.toAmount ? decimalMoney(d.toAmount, this.store.get(d.toAccountId).data.currency) : '', d.currency, d.rate || '', d.category || '', d.content || '', d.importKey || csvIdentity(d), d.refundOf || '', d.subscriptionId || '', d.period || ''];
    });
    const escape = (value, index) => { const text = String(value); return `"${([5, 6].includes(index) ? text : text.replace(/^[=+@-]/, "'$&")).replaceAll('"', '""')}"`; };
    return '\uFEFF' + [header, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
  }
}
