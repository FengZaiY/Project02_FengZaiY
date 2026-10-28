import { check, isId, canonical } from './util.mjs';

export const PERSONAL_SCOPE = '__personal__';
export const MATERIAL_SCOPE = '__materials__';
export const PERSONAL_FIELDS = {
  materialCategory: ['description'],
  materialTopic: ['description', 'materialCategoryId'],
  materialCollection: ['description'],
  personalProject: ['description', 'status'],
  personalTask: ['content', 'projectId', 'parentTaskId', 'status', 'priority', 'startDate', 'dueDate', 'noteIds', 'assetIds'],
  loginAccount: ['website', 'username', 'email', 'content', 'assetIds'],
  subscription: ['accountId', 'amount', 'currency', 'cycle', 'nextDate', 'status', 'content', 'assetIds'],
  moneyAccount: ['currency', 'kind', 'opening', 'openingDate', 'rate', 'content'],
  moneyEntry: ['kind', 'accountId', 'toAccountId', 'amount', 'toAmount', 'currency', 'rate', 'date', 'category', 'refundOf', 'subscriptionId', 'period', 'content', 'assetIds', 'importKey'],
  moneyBudget: ['month', 'category', 'amount', 'currency'],
  vaultConfig: ['kdf', 'salt', 'passwordBox', 'recoveryBox', 'keyId', 'keyBoxes'],
  vaultSecret: ['accountId', 'keyId', 'box'],
  changeBatch: ['actor', 'entries', 'reversalOf']
};
export const PERSONAL_TYPES = Object.keys(PERSONAL_FIELDS);
export const SECRET_TYPES = ['vaultConfig', 'vaultSecret'];
export const PUBLIC_PERSONAL_TYPES = PERSONAL_TYPES.filter(type => !SECRET_TYPES.includes(type) && type !== 'changeBatch');
export const currencyDigits = { CNY: 2, USD: 2, EUR: 2, HKD: 2, JPY: 0, GBP: 2, AUD: 2, CAD: 2, SGD: 2, TWD: 2, KRW: 0, CHF: 2, KWD: 3, BHD: 3 };
export function currency(value) { check(Object.hasOwn(currencyDigits, value), '不支持的币种'); return value; }
export function minorUnits(value, code = 'CNY') {
  const digits = currencyDigits[currency(code)], text = String(value).trim();
  check(new RegExp(`^-?\\d+(?:\\.\\d{1,${digits || 1}})?$`).test(text) && (digits || !text.includes('.')), '金额格式或小数位数无效');
  const negative = text.startsWith('-'), [whole, decimal = ''] = text.replace(/^-/, '').split('.');
  const amount = BigInt(whole) * 10n ** BigInt(digits) + BigInt(decimal.padEnd(digits, '0') || 0);
  check(amount <= BigInt(Number.MAX_SAFE_INTEGER), '金额超出范围');
  return Number(negative ? -amount : amount);
}
export function convertMoney(amount, code, rate) {
  currency(code);
  if (code === 'CNY') return amount;
  if (!rate) return null;
  check(/^\d+(?:\.\d{1,8})?$/.test(rate) && Number(rate) > 0 && Number(rate) <= 1000000, '汇率必须为正数，最多八位小数');
  const [whole, fraction = ''] = rate.split('.'), numerator = BigInt(whole + fraction.padEnd(8, '0'));
  const denominator = 10n ** BigInt(currencyDigits[code]) * 100000000n;
  const raw = BigInt(amount) * numerator * 100n, sign = raw < 0 ? -1n : 1n;
  const result = sign * ((raw * sign + denominator / 2n) / denominator);
  check(result <= BigInt(Number.MAX_SAFE_INTEGER) && result >= -BigInt(Number.MAX_SAFE_INTEGER), '折算金额超出范围');
  return Number(result);
}
export function decimalMoney(amount, code = 'CNY') {
  check(Number.isSafeInteger(amount), '金额必须使用最小单位整数');
  const digits = currencyDigits[currency(code)], value = BigInt(amount), text = (value < 0n ? -value : value).toString().padStart(digits + 1, '0');
  return `${value < 0n ? '-' : ''}${digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text}`;
}
export function personalReferences(data) {
  return [...new Set([...(data.noteIds || []), ...(data.assetIds || []), ...(data.collectionIds || []),
    data.projectId, data.parentTaskId, data.accountId, data.toAccountId, data.refundOf, data.subscriptionId,
    data.materialCategoryId, data.materialTopicId,
    ...(data.materialItems || []).flatMap(item => [item.targetId, ...personalReferences(item.data)])].filter(isId))];
}
export function dateOnly(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function box(value) {
  check(value && Object.keys(value).sort().join() === 'data,iv,tag' && [value.data, value.iv, value.tag].every(v => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v))
    && Buffer.from(value.iv, 'base64').length === 12 && Buffer.from(value.tag, 'base64').length === 16 && value.data.length < 100000, '密码库密文格式无效');
}
export function cleanPersonal(type, data) {
  const fields = PERSONAL_FIELDS[type];
  check(fields, '不支持的个人管理记录');
  check(Object.keys(data).every(key => ['title', 'domain', 'tags', 'sensitive', ...fields].includes(key)), '包含不支持的字段，请勿在普通记录中保存密码');
  check(typeof data.title === 'string' && data.title.trim() && data.title.length <= 500, '请输入名称（最多 500 字）');
  const result = { ...data, title: data.title.trim(), domain: PERSONAL_SCOPE, tags: data.tags || [], sensitive: data.sensitive === true };
  check(Array.isArray(result.tags) && result.tags.length <= 100 && result.tags.every(t => typeof t === 'string' && t.length <= 100), '标签无效');
  for (const field of ['content', 'description', 'username', 'email', 'category']) check(result[field] === undefined || typeof result[field] === 'string' && result[field].length <= 30000, '文本字段过长');
  for (const field of ['projectId', 'parentTaskId', 'accountId', 'toAccountId', 'refundOf', 'subscriptionId', 'keyId', 'reversalOf', 'materialCategoryId']) check(result[field] == null || isId(result[field]), '关联标识无效');
  if (type === 'materialTopic') check(isId(result.materialCategoryId), '资料主题必须属于一个分类');
  for (const field of ['assetIds', 'noteIds']) check(result[field] === undefined || Array.isArray(result[field]) && result[field].length <= 200 && result[field].every(isId), '关联列表无效');
  for (const field of ['startDate', 'dueDate', 'openingDate', 'nextDate', 'date']) check(!result[field] || dateOnly(result[field]), '日期必须为有效的 YYYY-MM-DD');
  if (result.currency !== undefined) currency(result.currency);
  if (result.rate) convertMoney(1, 'USD', result.rate);
  for (const field of ['amount', 'toAmount', 'opening']) check(result[field] === undefined || Number.isSafeInteger(result[field]), '金额必须使用最小单位整数');
  if (type === 'personalTask') {
    check(['todo', 'doing', 'done', 'cancelled'].includes(result.status) && ['low', 'normal', 'high'].includes(result.priority), '任务状态或优先级无效');
    check(!result.startDate || !result.dueDate || result.startDate <= result.dueDate, '截止日期不能早于开始日期');
  }
  if (type === 'personalProject') check(['active', 'archived'].includes(result.status), '项目状态无效');
  if (type === 'loginAccount' && result.website) { const url = new URL(result.website); check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, '请输入不含登录凭证的网站地址'); }
  if (type === 'subscription') {
    check(['monthly', 'quarterly', 'yearly', 'weekly', 'once'].includes(result.cycle) && ['active', 'paused', 'cancelled'].includes(result.status), '订阅周期或状态无效');
    check(Number.isSafeInteger(result.amount) && result.amount >= 0 && result.currency && dateOnly(result.nextDate), '订阅金额、币种和日期不完整');
  }
  if (type === 'moneyAccount') check(['cash', 'asset', 'liability'].includes(result.kind) && result.currency && Number.isSafeInteger(result.opening) && dateOnly(result.openingDate), '资金账户信息不完整');
  if (type === 'moneyEntry') {
    check(['income', 'expense', 'transfer', 'refund', 'adjustment'].includes(result.kind) && isId(result.accountId) && result.currency && dateOnly(result.date), '账目类型、账户或日期无效');
    check(Number.isSafeInteger(result.amount) && result.amount !== 0 && (result.kind === 'adjustment' || result.amount > 0), '账目金额无效');
    if (result.kind === 'transfer') check(isId(result.toAccountId) && result.toAccountId !== result.accountId && Number.isSafeInteger(result.toAmount) && result.toAmount > 0, '转账目标与到账金额无效');
    if (result.kind === 'refund') check(isId(result.refundOf), '退款必须关联原支出');
    if (result.subscriptionId) check(typeof result.period === 'string' && dateOnly(result.period), '订阅付款缺少账期');
    check(result.importKey === undefined || /^[a-f0-9]{64}$/.test(result.importKey), '导入去重标识无效');
  }
  if (type === 'moneyBudget') check(/^\d{4}-(0[1-9]|1[0-2])$/.test(result.month) && typeof result.category === 'string' && result.category.trim() && result.currency && Number.isSafeInteger(result.amount) && result.amount >= 0, '月度预算信息无效');
  if (type === 'vaultConfig') {
    check(canonical(result.kdf) === canonical({ name: 'scrypt', N: 131072, r: 8, p: 1 }) && /^[a-f0-9]{32}$/.test(result.salt) && isId(result.keyId), '密码库派生参数无效');
    box(result.passwordBox); box(result.recoveryBox);
    if (result.keyBoxes !== undefined) {
      check(Array.isArray(result.keyBoxes) && result.keyBoxes.length <= 100 && new Set(result.keyBoxes.map(item => item.keyId)).size === result.keyBoxes.length, '密码库历史密钥无效');
      for (const item of result.keyBoxes) { check(Object.keys(item).sort().join() === 'box,keyId' && isId(item.keyId) && item.keyId !== result.keyId, '历史密钥身份无效'); box(item.box); }
    }
  }
  if (type === 'vaultSecret') { check(isId(result.accountId) && isId(result.keyId), '密码关联无效'); box(result.box); }
  if (type === 'changeBatch') {
    check(typeof result.actor === 'string' && result.actor.length <= 200 && Array.isArray(result.entries) && result.entries.length <= 2500, '修改批次无效');
    const ids = new Set();
    for (const entry of result.entries) {
      check(entry && Object.keys(entry).sort().join() === 'after,before,id' && isId(entry.id) && !ids.has(entry.id), '批次记录重复或无效'); ids.add(entry.id);
      for (const values of [entry.before, entry.after]) check(Array.isArray(values) && values.length <= 100 && values.every(isId), '批次版本无效');
    }
  }
  check(Buffer.byteLength(canonical(result)) <= 1024 * 1024, '记录内容过大');
  return result;
}
