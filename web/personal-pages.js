import './personal-pages.css';

export const businessLabels = { personalTask: '任务', personalProject: '项目', loginAccount: '账号', subscription: '订阅', moneyAccount: '资金账户', moneyEntry: '收支与转账', moneyBudget: '预算', materialCollection: '用途集合' };
const groups = { tasks: ['personalTask', 'personalProject'], accounts: ['loginAccount', 'subscription'], finance: ['overview', 'moneyEntry', 'moneyAccount', 'moneyBudget'], materials: ['materialCollection'] };
const views = { tasks: '任务管理', accounts: '账号与订阅', finance: '财务管理', materials: '用途集合' };
const digits = { CNY: 2, USD: 2, EUR: 2, HKD: 2, JPY: 0, GBP: 2, AUD: 2, CAD: 2, SGD: 2, TWD: 2, KRW: 0, CHF: 2, KWD: 3, BHD: 3 };
const currencies = Object.fromEntries(Object.keys(digits).map(code => [code, code]));
const statusLabels = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消', active: '使用中', archived: '已归档', paused: '已暂停' };
const kinds = { income: '收入', expense: '支出', transfer: '转账', refund: '退款', adjustment: '估值调整' };
const fields = {
  personalTask: [['status', '状态', 'select', { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }], ['priority', '优先级', 'select', { normal: '普通', high: '高', low: '低' }], ['projectId', '所属项目', 'ref', 'personalProject'], ['parentTaskId', '上级任务', 'ref', 'personalTask'], ['startDate', '开始日期', 'date'], ['dueDate', '截止日期', 'date'], ['content', '任务说明', 'textarea'], ['noteIds', '关联笔记', 'multi', 'note'], ['assetIds', '关联资料', 'multi', 'asset']],
  personalProject: [['status', '状态', 'select', { active: '进行中', archived: '已归档' }], ['description', '项目说明', 'textarea']],
  loginAccount: [['website', '网站地址', 'url'], ['username', '用户名', 'text'], ['email', '邮箱', 'email'], ['content', '非秘密备注', 'textarea'], ['assetIds', '关联资料', 'multi', 'asset']],
  subscription: [['accountId', '关联账号', 'ref', 'loginAccount'], ['amount', '每期金额', 'money'], ['currency', '币种', 'select', currencies], ['cycle', '订阅周期', 'select', { monthly: '每月', quarterly: '每季度', yearly: '每年', weekly: '每周', once: '一次性' }], ['nextDate', '下次付款日期', 'date'], ['status', '状态', 'select', { active: '使用中', paused: '暂停', cancelled: '已取消' }], ['content', '备注', 'textarea'], ['assetIds', '关联资料', 'multi', 'asset']],
  moneyAccount: [['kind', '账户性质', 'select', { cash: '现金 / 银行', asset: '其他资产', liability: '负债（欠款记负数）' }], ['currency', '币种', 'select', currencies], ['opening', '期初余额', 'money'], ['openingDate', '期初日期', 'date'], ['rate', '折算汇率（1 外币兑人民币）', 'text'], ['content', '备注', 'textarea']],
  moneyEntry: [['kind', '账目类型', 'select', kinds], ['accountId', '资金账户', 'ref', 'moneyAccount'], ['amount', '金额', 'money'], ['currency', '币种', 'select', currencies], ['date', '记账日期', 'date'], ['category', '分类', 'text'], ['rate', '本次人工汇率（外币填写）', 'text'], ['toAccountId', '转入账户（转账）', 'ref', 'moneyAccount'], ['toAmount', '到账金额（转账）', 'money'], ['refundOf', '原支出（退款）', 'ref', 'expense'], ['content', '备注', 'textarea'], ['assetIds', '票据 / 关联资料', 'multi', 'asset']],
  moneyBudget: [['month', '预算月份', 'month'], ['category', '支出分类', 'text'], ['amount', '预算金额', 'money'], ['currency', '币种', 'select', currencies]],
  materialCollection: [['description', '用途说明', 'textarea']]
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export function moneyText(value = 0, currency = 'CNY') {
  if (value === null) return '待核对';
  const n = BigInt(value), text = (n < 0n ? -n : n).toString().padStart((digits[currency] ?? 2) + 1, '0'), p = digits[currency] ?? 2;
  return `${n < 0n ? '-' : ''}${p ? `${text.slice(0, -p)}.${text.slice(-p)}` : text}`;
}
function moneyValue(text, currency) {
  const p = digits[currency];
  if (p === undefined || !new RegExp(`^-?\\d+(?:\\.\\d{1,${p || 1}})?$`).test(text) || !p && text.includes('.')) throw new Error('请检查金额的小数位数');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.'), n = (BigInt(whole) * 10n ** BigInt(p) + BigInt(fraction.padEnd(p, '0') || '0')) * (text.startsWith('-') ? -1n : 1n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出范围');
  return Number(n);
}
export function createPersonalUI({ api, esc, icon, toast, confirmBox, openModal, redrawIcons, openRecord, navigate, native }) {
  const $ = (selector, root = document) => root.querySelector(selector);
  let view, query = '', all = [], drafts = {}, serial = 0, activeForm, pending = Promise.resolve(), saving = false;
  let ui = {}, secretDialog, secretBusy = false, savePromise;
  try { ui = JSON.parse(localStorage.getItem('fengzai-personal-ui') || '{}'); } catch {}
  const state = name => ui[name] ||= { type: groups[name]?.[0], selected: null, filter: '', status: '', month: today().slice(0, 7), scroll: 0 };
  const remember = () => { try { localStorage.setItem('fengzai-personal-ui', JSON.stringify(ui)); } catch {} };
  const run = fn => Promise.resolve().then(fn).catch(error => toast(error.message, true));
  const refs = type => all.filter(r => !r.deleted && !r.conflict && (type === 'expense' ? r.type === 'moneyEntry' && r.data.kind === 'expense' : r.type === type));
  const options = (values, selected, blank = false) => `${blank ? '<option value="">无 / 未指定</option>' : ''}${Object.entries(values).map(([id, label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('')}`;
  const refOptions = (type, selected, self) => options(Object.fromEntries(refs(type).filter(r => r.id !== self).map(r => [r.id, r.data.title])), selected, true);
  const enqueue = fn => { pending = pending.catch(() => {}).then(fn); pending.catch(error => toast(`草稿保存失败：${error.message}`, true)); return pending; };
  async function init() { for (const name of Object.keys(groups)) drafts[name] = await api('personalDraft', { view: name }); }
  async function flush() { capture(); await pending; }
  function capture() {
    if (!activeForm?.isConnected || !view || !activeForm.dataset.changed) return;
    const data = Object.fromEntries(new FormData(activeForm));
    data.sensitive = activeForm.elements.sensitive.checked;
    for (const select of activeForm.querySelectorAll('select[multiple]')) data[select.name] = [...select.selectedOptions].map(o => o.value);
    const previous = drafts[view] || JSON.parse(activeForm.dataset.record);
    drafts[view] = { ...previous, data: { ...previous.data, ...data }, raw: true };
    const name = view, value = structuredClone(drafts[view]);
    enqueue(() => api('personalDraft', { view: name, value }));
    delete activeForm.dataset.changed;
    const badge = $('#personal-save-state'); if (badge) badge.textContent = '未提交 · 本机草稿';
  }
  const snapshot = () => Object.values(drafts).filter(Boolean).map(d => ({ title: d.data.title || businessLabels[d.type], state: saving ? 'saving' : 'queued' }));
  function defaults(type) {
    const d = { title: '', tags: [], sensitive: false };
    for (const [key, , kind, values] of fields[type]) {
      d[key] = kind === 'select' ? Object.keys(values)[0] : kind === 'multi' ? [] : kind === 'money' ? 0 : kind === 'date' && ['date', 'openingDate', 'nextDate'].includes(key) ? today() : kind === 'month' ? today().slice(0, 7) : '';
    }
    return d;
  }
  function formData(record) {
    const data = { ...record.data }, raw = record.raw;
    for (const [key, , kind] of fields[record.type]) {
      if (kind === 'money' && !raw && data[key] != null) data[key] = moneyText(data[key], key === 'toAmount' ? all.find(r => r.id === data.toAccountId)?.data.currency || data.currency : data.currency);
    }
    if (!raw) data.tags = (data.tags || []).join('，');
    return data;
  }
  function converted(draft) {
    const data = { ...draft.data }; delete data._submit;
    data.tags = typeof data.tags === 'string' ? data.tags.split(/[,，]/).map(v => v.trim()).filter(Boolean) : data.tags || [];
    data.sensitive = data.sensitive === true || data.sensitive === 'on';
    for (const [key, , kind] of fields[draft.type]) {
      if (kind === 'money' && draft.raw) {
        if (data[key] === '' || data[key] === undefined) delete data[key];
        else data[key] = moneyValue(String(data[key]), key === 'toAmount' ? all.find(r => r.id === data.toAccountId)?.data.currency || data.currency : data.currency);
      } else if (kind === 'ref' && !data[key]) delete data[key];
    }
    if (draft.type === 'moneyEntry') {
      if (data.kind !== 'transfer') { delete data.toAccountId; delete data.toAmount; }
      if (data.kind !== 'refund') delete data.refundOf;
    }
    return data;
  }
  function save(name = view) {
    if (savePromise) return savePromise.then(() => save(name));
    savePromise = commit(name).finally(() => { savePromise = null; });
    return savePromise;
  }
  async function commit(name) {
    saving = true;
    try {
      capture(); await pending; const draft = drafts[name]; if (!draft) return;
      const frozen = JSON.stringify(draft);
      const result = await api('personalSave', { id: draft.id || undefined, type: draft.type, parents: draft.parents || [], data: converted(draft) });
      capture(); await pending;
      if (JSON.stringify(drafts[name]) === frozen) { drafts[name] = null; await api('personalDraft', { view: name, clear: true }); }
      else if (drafts[name]) { drafts[name].id = result.id; drafts[name].parents = result.heads; await api('personalDraft', { view: name, value: drafts[name] }); }
      state(name).selected = result.id; remember(); toast('已保存，修改历史已保留');
      if (view === name && $('#main')?.classList.contains('personal-page')) await show(name, query);
    } finally { saving = false; }
  }
  async function saveAll() { await flush(); for (const name of Object.keys(groups)) if (drafts[name]) await save(name); }
  async function select(record) {
    await flush();
    const target = Object.keys(groups).find(name => groups[name].includes(record.type));
    if (!target) return;
    if (drafts[target] && drafts[target].id !== record.id) { toast('此板块还有未提交表单，请先保存或放弃'); await navigate(target); return; }
    state(target).type = record.type; state(target).selected = record.id; remember();
    if (view === target) await show(target, query);
    else await navigate(target);
  }
  async function create(type) {
    if (savePromise) await savePromise;
    await flush(); const name = Object.keys(groups).find(name => groups[name].includes(type));
    if (drafts[name]) { toast('请先保存或放弃当前表单'); return; }
    const data = defaults(type); if (type === 'personalTask' && state(name).filter) data.projectId = state(name).filter;
    drafts[name] = { type, parents: [], data, raw: false }; state(name).type = type; state(name).selected = null;
    await api('personalDraft', { view: name, value: drafts[name] }); await show(name, query); $('#personal-form [name=title]')?.focus();
  }
  function fieldMarkup([key, label, kind, values], data, record) {
    const value = data[key] ?? '', long = ['textarea', 'multi'].includes(kind);
    let control;
    if (kind === 'select') control = `<select name="${key}">${options(values, value)}</select>`;
    else if (kind === 'ref') control = `<select name="${key}">${refOptions(values, value, record.id)}</select>`;
    else if (kind === 'multi') control = `<select multiple name="${key}" size="3">${refs(values).map(r => `<option value="${r.id}" ${(value || []).includes(r.id) ? 'selected' : ''}>${esc(r.data.title)}</option>`).join('')}</select><small>按住 Ctrl 可多选</small>`;
    else if (kind === 'textarea') control = `<textarea name="${key}" rows="4">${esc(value)}</textarea>`;
    else control = `<input name="${key}" type="${kind === 'money' ? 'text' : kind}" ${kind === 'money' ? 'inputmode="decimal"' : ''} value="${esc(value)}">`;
    return `<label class="${long ? 'wide' : ''}">${label}${control}</label>`;
  }
  function editor(record) {
    if (!record) return `<section class="personal-empty">${icon('panel-right')}<h2>选择一条记录</h2><p>在这里查看、编辑和关联资料。</p></section>`;
    const data = formData(record), dirty = !!drafts[view], current = all.find(r => r.id === record.id) || record;
    return `<section class="personal-detail"><div class="personal-detail-heading"><div><small>${businessLabels[record.type]}</small><h2>${esc(data.title || '新建记录')}</h2></div><span id="personal-save-state">${dirty ? '未提交 · 本机草稿' : current?.conflict ? '存在并发版本' : '已保存'}</span></div>
      ${current?.conflict ? `<div class="notice amber">存在 ${current.heads.length} 个并发版本。<button type="button" data-personal="conflict">对照版本并选择编辑基础</button></div>` : ''}
      ${current?.deleted ? '<div class="notice amber">此记录已回收。<button type="button" data-personal="restore">恢复记录</button></div>' : ''}
      <form id="personal-form" class="personal-form" data-record="${esc(JSON.stringify({ id: record.id, type: record.type, parents: record.parents || record.heads || [], data: record.data }))}">
        <label class="wide">名称<input name="title" required maxlength="500" value="${esc(data.title)}"></label>
        ${fields[record.type].map(field => fieldMarkup(field, data, record)).join('')}
        <label class="wide">标签<input name="tags" value="${esc(data.tags)}" placeholder="用逗号分隔"></label>
        <label class="wide personal-sensitive"><input type="checkbox" name="sensitive" ${data.sensitive ? 'checked' : ''}>标记为敏感内容（仍可由已授权 Agent 访问；密码请使用独立密码库）</label>
        <div class="personal-form-actions wide"><button class="primary" type="submit" ${current?.deleted || current?.conflict && !dirty ? 'disabled' : ''}>${icon('save')}保存</button><button class="secondary" type="button" data-personal="discard">放弃表单编辑</button>
          ${record.id ? `<button class="text-button" type="button" data-personal="history">修改历史</button>${current.deleted ? '' : '<button class="text-button danger-action" type="button" data-personal="delete">移入回收站</button>'}` : ''}</div>
      </form>
      ${record.type === 'loginAccount' && record.id && !current.deleted ? `<div class="personal-secret-card">${icon('lock-keyhole')}<div><strong>独立密码库</strong><small>密码、恢复码和秘密备注独立加密</small></div><button class="secondary" data-personal="secret">打开密码</button></div>` : ''}
      ${record.type === 'subscription' && record.id && !current.deleted ? '<button class="secondary" data-personal="pay">确认已付款并记录支出</button>' : ''}
      ${record.id ? `<details class="personal-relations"><summary>关联内容</summary>${[...(record.data.noteIds || []), ...(record.data.assetIds || [])].map(id => `<button class="text-button" data-open-linked="${id}">${esc(all.find(r => r.id === id)?.data.title || '查看关联内容')}</button>`).join('') || '<p class="muted">暂无关联内容</p>'}</details>` : ''}</section>`;
  }
  async function show(name, text = '') {
    capture(); activeForm = null; view = name; query = text; const request = ++serial;
    const records = await api('records'); if (request !== serial || view !== name) return;
    all = records;
    const s = state(name), draft = drafts[name]; if (draft) { s.type = draft.type; s.selected = draft.id; }
    const type = s.type, isOverview = type === 'overview';
    let selected = draft || all.find(r => r.id === s.selected);
    if (!selected && s.selected) selected = await api('record', { id: s.selected });
    if (request !== serial) return;
    let rows = all.filter(r => r.type === type && (!text || JSON.stringify(r.data).toLocaleLowerCase().includes(text.toLocaleLowerCase())));
    if (s.status) rows = rows.filter(r => r.data.status === s.status);
    if (s.filter) rows = rows.filter(r => name === 'tasks' ? r.data.projectId === s.filter : name === 'finance' ? r.data.accountId === s.filter || r.data.toAccountId === s.filter : r.data.accountId === s.filter);
    const main = $('#main'); main.className = 'personal-page';
    main.innerHTML = `<aside class="personal-nav"><div class="personal-nav-title">${views[name]}</div>${groups[name].map(key => `<button data-personal-type="${key}" class="${key === type ? 'selected' : ''}">${icon(({ overview: 'chart-no-axes-combined', personalTask: 'list-checks', personalProject: 'folder-kanban', moneyAccount: 'wallet', moneyEntry: 'arrow-left-right', moneyBudget: 'chart-pie', loginAccount: 'contact-round', subscription: 'repeat-2', materialCollection: 'folders' })[key])}<span>${businessLabels[key] || '财务概览'}</span><small>${all.filter(r => r.type === key).length || ''}</small></button>`).join('')}
      ${name === 'accounts' ? '<div class="personal-nav-bottom"><button data-personal="vault">管理密码库</button><button data-personal="lock">立即锁定密码库</button></div>' : ''}
      ${!isOverview && ['personalTask', 'moneyEntry', 'subscription'].includes(type) ? `<label class="personal-filter">${name === 'tasks' ? '项目范围' : name === 'finance' ? '资金账户' : '账号范围'}<select id="personal-filter">${refOptions(name === 'tasks' ? 'personalProject' : name === 'finance' ? 'moneyAccount' : 'loginAccount', s.filter)}</select></label>` : ''}
      ${type === 'personalTask' ? `<label class="personal-filter">任务状态<select id="personal-status">${options({ '': '全部状态', todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }, s.status)}</select></label>` : ''}
      <div class="personal-nav-note">本地保存<br>修改自动保留历史</div></aside><div class="personal-body">
      <div class="personal-page-heading"><div><small>FengZaiY / ${views[name]}</small><h1>${businessLabels[type] || '财务概览'}</h1></div><div class="inline-actions">${name === 'finance' ? '<button class="secondary" data-personal="csv">CSV 导入</button><button class="secondary" data-personal="export">导出 CSV</button>' : ''}<button class="primary" data-personal="new">${icon('plus')}新建${businessLabels[type] || '账目'}</button></div></div>
      ${isOverview ? '<div id="finance-overview"></div>' : `<div class="personal-split"><section class="personal-list"><div class="personal-list-label">${rows.length} 条记录${draft ? ' · 有未提交表单' : ''}</div>${rows.map(record => `<button class="personal-row ${record.id === selected?.id ? 'selected' : ''}" data-personal-id="${record.id}"><span class="personal-row-icon">${icon(name === 'tasks' ? record.data.status === 'done' ? 'circle-check' : 'circle' : name === 'finance' ? 'receipt-text' : 'bookmark')}</span><span><strong>${esc(record.data.title)}</strong><small>${esc(record.conflict ? '存在冲突 · 请核对' : record.type === 'moneyEntry' ? `${kinds[record.data.kind]} · ${moneyText(record.data.amount, record.data.currency)} ${record.data.currency}` : [statusLabels[record.data.status], record.data.dueDate || record.data.nextDate || record.data.website || record.data.category || ''].filter(Boolean).join(' · '))}</small></span>${record.data.priority === 'high' ? '<b class="priority-high">高</b>' : ''}${record.type === 'subscription' && record.data.status === 'active' && record.data.nextDate <= today() ? '<b class="priority-high">待续费</b>' : ''}</button>`).join('') || '<div class="personal-empty"><p>还没有记录</p><small>从右上角新建开始</small></div>'}</section>${editor(selected)}</div>`}</div>`;
    activeForm = $('#personal-form');
    if (activeForm) {
      const form = activeForm;
      if (selected?.deleted || selected?.conflict && !draft) activeForm.querySelectorAll('input,textarea,select').forEach(control => { control.disabled = true; });
      activeForm.oninput = () => { if (activeForm !== form || !form.isConnected) return; form.dataset.changed = 'true'; capture(); };
      activeForm.onchange = activeForm.oninput;
      activeForm.onsubmit = event => { event.preventDefault(); if (activeForm !== form || !form.isConnected) return; form.dataset.changed = 'true'; capture(); run(() => save(name)); };
    }
    main.querySelectorAll('[data-personal-type]').forEach(button => button.onclick = () => run(async () => {
      await flush(); if (drafts[name]) { toast('请先保存或放弃当前表单'); return; } s.type = button.dataset.personalType; s.selected = null; s.filter = ''; s.status = ''; remember(); await show(name, query);
    }));
    main.querySelectorAll('[data-personal-id]').forEach(button => button.onclick = () => run(async () => { await select(all.find(r => r.id === button.dataset.personalId)); }));
    main.querySelectorAll('[data-open-linked]').forEach(button => button.onclick = () => run(() => openRecord(button.dataset.openLinked)));
    for (const [id, key] of [['personal-filter', 'filter'], ['personal-status', 'status']]) if ($(`#${id}`)) $(`#${id}`).onchange = event => run(async () => { s[key] = event.target.value; remember(); await show(name, query); });
    main.querySelectorAll('[data-personal]').forEach(button => button.onclick = () => run(() => action(button.dataset.personal, selected)));
    const body = $('.personal-body'); body.scrollTop = s.scroll || 0; body.onscroll = () => { s.scroll = body.scrollTop; remember(); };
    if (isOverview) await overview(name, request); redrawIcons();
  }
  async function action(action, selected) {
    const name = view;
    if (action === 'new') return create(state(name).type === 'overview' ? 'moneyEntry' : state(name).type);
    if (action === 'discard') {
      if (saving) { toast('正在保存，请稍后处理表单'); return; }
      if (drafts[name] && !await confirmBox('放弃表单编辑', '<p>仅放弃当前未提交的表单，已保存记录保留。</p>', '放弃编辑')) return;
      drafts[name] = null; activeForm = null; await api('personalDraft', { view: name, clear: true }); return show(name, query);
    }
    if (action === 'delete') {
      if (!selected?.id) return;
      if (drafts[name]) throw new Error('请先保存或放弃表单');
      if (await confirmBox('移入回收站', `<p>${esc(selected.data.title)}将保留历史，存在引用时会阻止回收。</p>`, '移入回收站')) { await api('personalDelete', { id: selected.id, parents: selected.heads }); state(name).selected = null; return show(name, query); }
    }
    if (action === 'restore') { await api('personalRestore', { id: selected.id, parents: selected.heads, revision: (await api('history', { id: selected.id })).find(r => !r.deleted)?.id }); return show(name, query); }
    if (action === 'history' || action === 'conflict') return history(selected, action === 'conflict');
    if (action === 'vault') return vault();
    if (action === 'lock') { await api('vaultLock'); clearSecret(); toast('密码库已锁定'); }
    if (action === 'secret') return secret(selected.id);
    if (action === 'pay') return pay(selected);
    if (action === 'csv') return csv();
    if (action === 'export') download(await api('financeCsvExport'), `FengZaiY-账目-${today()}.csv`, 'text/csv;charset=utf-8');
  }
  async function history(record, conflict) {
    const events = conflict ? record.versions : await api('history', { id: record.id });
    const dialog = openModal(`${record.data.title} · ${conflict ? '对照并发版本' : '修改历史'}`, `<p>选择版本填入表单，核对后点击保存才会产生新记录。</p>${events.map(e => `<details><summary>${new Date(e.createdAt).toLocaleString()} · ${e.deleted ? '回收' : '保存'}</summary><pre class="personal-diff">${esc(JSON.stringify(e.data, null, 2))}</pre>${!e.deleted ? `<button class="secondary" data-use-version="${e.id}">使用此版本编辑</button>` : ''}</details>`).join('')}`);
    dialog.querySelectorAll('[data-use-version]').forEach(button => button.onclick = () => run(async () => {
      if (drafts[view]) throw new Error('请先保存或放弃当前表单');
      drafts[view] = { id: record.id, type: record.type, parents: record.heads, data: events.find(e => e.id === button.dataset.useVersion).data };
      await api('personalDraft', { view, value: drafts[view] }); dialog.close(); await show(view, query);
    }));
  }
  async function overview(name, request) {
    const s = state(name), r = await api('financeReport', { month: s.month }); if (request !== serial || !$('#finance-overview')) return;
    $('#finance-overview').innerHTML = `<div class="finance-period"><label>报表月份 <input id="finance-month" type="month" value="${s.month}"></label><span>人民币汇总 · 手工汇率</span></div>${r.complete ? '' : `<div class="notice amber">统计不完整：${r.problems.map(esc).join('；')}</div>`}
      <div class="finance-cards">${[['本月收入', r.income], ['本月支出（扣退款）', r.expense], ['净资产', r.netAssets], ['负债', r.liabilities]].map(([label, amount]) => `<article><small>${label}</small><strong><span>¥</span>${moneyText(amount)}</strong></article>`).join('')}</div>
      <div class="finance-grid"><section class="finance-panel"><h2>支出分类</h2>${r.categories.map(row => `<div class="finance-bar"><span>${esc(row.category)}</span><strong>¥ ${moneyText(row.amount)}</strong><progress max="${Math.max(...r.categories.map(v => v.amount), 1)}" value="${Math.max(row.amount, 0)}"></progress></div>`).join('') || '<p class="muted">本月暂无支出</p>'}</section>
      <section class="finance-panel"><h2>分类预算</h2>${r.budgets.map(row => `<div class="finance-bar"><span>${esc(row.data.category)} · ${row.data.currency}</span><strong>${moneyText(row.used, row.data.currency)} / ${moneyText(row.data.amount, row.data.currency)}</strong><progress max="${row.data.amount || 1}" value="${Math.max(row.used || 0, 0)}"></progress><small>${row.remaining === null ? '存在冲突' : `剩余 ${moneyText(row.remaining, row.data.currency)}`}</small></div>`).join('') || '<p class="muted">尚未设置本月预算</p>'}</section>
      <section class="finance-panel"><h2>资产与负债账户</h2>${r.accounts.map(row => `<div class="finance-line"><span>${esc(row.data.title)}</span><strong>${moneyText(row.balance, row.data.currency)} ${row.data.currency}</strong></div>`).join('') || '<p class="muted">先新建资金账户，再记录账目</p>'}</section>
      <section class="finance-panel"><h2>每日收支</h2><table class="data-table"><thead><tr><th>日期</th><th>收入</th><th>支出</th></tr></thead><tbody>${r.days.map(row => `<tr><td>${row.date}</td><td>${moneyText(row.income)}</td><td>${moneyText(row.expense)}</td></tr>`).join('')}</tbody></table></section></div>`;
    $('#finance-month').onchange = event => run(async () => { s.month = event.target.value; remember(); await overview(name, request); });
  }
  async function pay(record) {
    if (drafts.accounts) throw new Error('请先保存订阅表单');
    const dialog = openModal('确认订阅付款', `<form class="personal-form" id="payment-form"><p class="wide">${esc(record.data.title)} · 账期 ${esc(record.data.nextDate)}。仅记录已完成的付款。</p><label class="wide">付款账户<select name="accountId" required>${refOptions('moneyAccount')}</select></label><label>金额<input name="amount" value="${moneyText(record.data.amount, record.data.currency)}" required></label><label>日期<input type="date" name="date" value="${today()}" required></label><label class="wide">汇率<input name="rate"></label><button class="primary wide">确认付款并记账</button></form>`);
    $('#payment-form', dialog).onsubmit = event => { event.preventDefault(); const form = event.target, input = Object.fromEntries(new FormData(form)); run(async () => { form.querySelector('button').disabled = true; try { await api('subscriptionPay', { ...input, amount: moneyValue(input.amount, record.data.currency), id: record.id, parents: record.heads }); dialog.close(); await show('accounts', query); toast('已记录支出并更新续费日期'); } finally { if (form.isConnected) form.querySelector('button').disabled = false; } }); };
  }
  function download(content, name, type) { const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  async function csv() {
    const dialog = openModal('导入账目 CSV', `<p>先匹配列名并预览。账户应为已有资金账户的名称或标识，金额使用十进制。最多 2000 条。</p><input id="finance-file" type="file" accept=".csv"><div id="csv-mapping" class="personal-form"></div><button id="csv-preview" class="secondary" disabled>检查并预览</button><div id="csv-result"></div>`);
    let content, preview;
    $('#finance-file', dialog).onchange = event => run(async () => {
      content = await event.target.files[0]?.text(); if (!content) return;
      const initial = await api('financeCsvPreview', { csv: content });
      $('#csv-mapping', dialog).innerHTML = Object.entries({ date: '日期', title: '名称', kind: '类型', account: '资金账户', amount: '金额', currency: '币种', category: '分类', rate: '汇率', toAccount: '转入账户', toAmount: '到账金额', refundOf: '原支出标识（退款）', subscriptionId: '订阅标识', period: '订阅账期', importKey: '导入去重标识', content: '备注' }).map(([key, label]) => `<label>${label}<select data-csv-field="${key}">${options(Object.fromEntries(initial.headers.map(h => [h, h])), key, true)}</select></label>`).join('');
      $('#csv-preview', dialog).disabled = false; $('#csv-result', dialog).innerHTML = '';
    });
    const mapping = () => Object.fromEntries([...dialog.querySelectorAll('[data-csv-field]')].filter(s => s.value).map(s => [s.dataset.csvField, s.value]));
    $('#csv-preview', dialog).onclick = () => run(async () => {
      const map = mapping(); preview = await api('financeCsvPreview', { csv: content, mapping: map });
      $('#csv-result', dialog).innerHTML = `<p>${preview.rows.length} 条有效记录，${preview.rows.filter(r => r.duplicate).length} 条重复，${preview.errors.length} 条错误</p>${preview.errors.map(e => `<p class="error">第 ${e.line} 行：${esc(e.message)}</p>`).join('')}<div class="csv-preview-scroll"><table class="data-table"><thead><tr><th>行</th><th>名称</th><th>金额</th><th>处理</th></tr></thead><tbody>${preview.rows.map(r => `<tr><td>${r.line}</td><td>${esc(r.data.title)}</td><td>${moneyText(r.data.amount, r.data.currency)} ${r.data.currency}</td><td>${r.duplicate ? '跳过重复' : '待导入'}</td></tr>`).join('')}</tbody></table></div><button id="csv-import" class="primary" ${preview.errors.length ? 'disabled' : ''}>确认本批导入</button>`;
      $('#csv-import', dialog).onclick = () => run(async () => { const button = $('#csv-import', dialog); button.disabled = true; try { const result = await api('financeCsvImport', { csv: content, mapping: map, token: preview.token }); dialog.close(); toast(`已导入 ${result.count} 条，跳过 ${result.skipped} 条`); await show('finance', query); } finally { if (button.isConnected) button.disabled = false; } });
    });
  }
  function protectSecretDialog(dialog) {
    secretDialog = dialog;
    const body = dialog.querySelector('.modal-body');
    dialog.addEventListener('close', () => {
      // A queued close event can arrive after another modal has opened in the same dialog.
      if (body !== dialog.querySelector('.modal-body') || dialog.open) return;
      body.querySelectorAll('input,textarea').forEach(input => { input.value = ''; input.defaultValue = ''; });
      body.replaceChildren(); if (secretDialog === dialog) secretDialog = null;
    }, { once: true });
  }
  function clearSecret() { if (secretDialog) { secretDialog.querySelectorAll('input,textarea').forEach(input => { input.value = ''; input.defaultValue = ''; }); secretDialog.querySelector('.modal-body')?.replaceChildren(); secretDialog.close(); secretDialog = null; } }
  async function vault(after) {
    const status = await api('vaultStatus');
    if (status.conflict) return resolveVault(status, after);
    if (status.unlocked && after) return after();
    if (status.unlocked) {
      const dialog = openModal('密码库已解锁', '<p>闲置十分钟、系统锁屏或退出时自动锁定。恢复密钥可用于重设主密码。</p><form id="vault-reset" class="settings-form"><label>新主密码<input name="password" type="password" minlength="12" required autocomplete="new-password"></label><button class="primary">重设主密码</button></form>');
      protectSecretDialog(dialog); $('#vault-reset', dialog).onsubmit = event => { event.preventDefault(); const password = new FormData(event.target).get('password'); run(async () => { await api('vaultResetMaster', { password }); clearSecret(); toast('主密码已更新'); }); }; return;
    }
    const dialog = openModal(status.initialized ? '解锁独立密码库' : '初始化独立密码库', `<form id="vault-access" class="settings-form">${status.initialized ? '<label>解锁方式<select name="mode"><option value="password">主密码</option><option value="recoveryKey">恢复密钥</option></select></label>' : '<p>主密码至少 12 个字符。下一步会显示一次性恢复密钥，请妥善保存。</p>'}<label>${status.initialized ? '主密码 / 恢复密钥' : '设置主密码'}<input name="secret" type="password" autocomplete="off" required></label><button class="primary">${status.initialized ? '解锁' : '下一步'}</button><p class="vault-error" role="alert"></p></form>`);
    protectSecretDialog(dialog);
    $('#vault-access', dialog).onsubmit = event => {
      event.preventDefault(); const form = event.target, value = Object.fromEntries(new FormData(form));
      run(async () => {
        form.querySelector('button').disabled = true; secretBusy = true;
        try {
          if (status.initialized) { await api('vaultUnlock', { [value.mode]: value.secret }); clearSecret(); if (after) await after(); else toast('密码库已解锁'); }
          else {
            const setup = await api('vaultSetup', { password: value.secret });
            if (!dialog.open) { await api('vaultLock'); return; }
            dialog.querySelector('.modal-body').innerHTML = `<p>恢复密钥仅此一次显示。请保存在系统外；遗失主密码与恢复密钥将无法恢复秘密。</p><pre class="vault-recovery">${esc(setup.recoveryKey)}</pre><label class="check-row"><input id="vault-confirm" type="checkbox">我已另行保存恢复密钥</label><button id="vault-finish" class="primary" disabled>完成设置</button>`;
            $('#vault-confirm', dialog).onchange = e => { $('#vault-finish', dialog).disabled = !e.target.checked; };
            $('#vault-finish', dialog).onclick = () => run(async () => { await api('vaultSetupConfirm', { token: setup.token, confirmed: true }); clearSecret(); if (after) await after(); else toast('密码库已启用'); });
          }
        } catch (error) { if (form.isConnected) $('.vault-error', form).textContent = error.message; }
        finally { secretBusy = false; if (form.isConnected) form.querySelector('button').disabled = false; }
      });
    };
  }
  async function resolveVault(status, after) {
    const dialog = openModal('合并并发密码库配置', `<p>需要分别解锁每个配置，再设置合并后的主密码。原密码历史和密文均保留。</p><form id="vault-merge" class="settings-form">${status.configurations.map((c, index) => `<fieldset><legend>配置 ${index + 1} · ${esc(new Date(c.createdAt).toLocaleString())}</legend><label>解锁方式<select name="mode-${c.id}"><option value="password">主密码</option><option value="recoveryKey">恢复密钥</option></select></label><label>解锁信息<input name="credential-${c.id}" type="password" autocomplete="off" required></label></fieldset>`).join('')}<label>合并后的新主密码<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><button class="primary">解锁全部配置并合并</button><p class="vault-error" role="alert"></p></form>`);
    protectSecretDialog(dialog);
    $('#vault-merge', dialog).onsubmit = event => {
      event.preventDefault(); const form = event.target, input = new FormData(form);
      run(async () => {
        secretBusy = true; form.querySelector('button').disabled = true;
        try {
          const setup = await api('vaultResolveSetup', { password: input.get('password'), credentials: status.configurations.map(c => ({ revision: c.id, [input.get(`mode-${c.id}`)]: input.get(`credential-${c.id}`) })) });
          if (!dialog.open) { await api('vaultLock'); return; }
          dialog.querySelector('.modal-body').innerHTML = `<p>请保存新的恢复密钥。确认后合并配置，历史秘密仍可解锁。</p><pre class="vault-recovery">${esc(setup.recoveryKey)}</pre><label class="check-row"><input id="vault-confirm" type="checkbox">我已另行保存新恢复密钥</label><button id="vault-finish" class="primary" disabled>确认合并</button>`;
          $('#vault-confirm', dialog).onchange = e => { $('#vault-finish', dialog).disabled = !e.target.checked; };
          $('#vault-finish', dialog).onclick = () => run(async () => { await api('vaultSetupConfirm', { token: setup.token, confirmed: true }); clearSecret(); if (after) await after(); else toast('密码库配置已合并'); });
        } catch (error) { if (form.isConnected) $('.vault-error', form).textContent = error.message; }
        finally { secretBusy = false; if (form.isConnected) form.querySelector('button').disabled = false; }
      });
    };
  }
  async function secret(accountId, revision) {
    if (!(await api('vaultStatus')).unlocked) return vault(() => secret(accountId, revision));
    let saved;
    try { saved = await api('vaultRead', { accountId, revision }); }
    catch (error) { if (error.code !== 'CONFLICT') throw error; return secretHistory(accountId); }
    const draft = !revision && await api('vaultDraft', { accountId }), initial = draft || saved;
    const dialog = openModal('密码与恢复信息', `<form id="secret-form" class="personal-form" autocomplete="off"><p class="wide">${draft ? '已恢复本机密文草稿。' : ''}${saved.conflict ? '选择的版本将作为编辑内容；保存后合并当前分支。' : ''}未提交编辑仅保存为本机密文。</p><label class="wide">密码<input type="password" name="password" autocomplete="new-password"></label><div class="wide inline-actions"><button type="button" class="secondary" id="secret-generate">生成密码</button><button type="button" class="secondary" id="secret-show">显示 / 隐藏</button><button type="button" class="secondary" id="secret-copy" ${native ? '' : 'disabled'}>复制（30 秒后清理）</button></div><label class="wide">恢复码<textarea name="recoveryCodes" rows="3"></textarea></label><label class="wide">秘密备注<textarea name="secretNotes" rows="3"></textarea></label><div class="wide inline-actions"><button class="primary" type="submit">保存密码</button><button class="secondary" type="button" id="secret-history">密码历史</button><button class="text-button" type="button" id="secret-discard">放弃密文草稿</button></div><small class="wide" id="secret-status">${native ? '' : '浏览器预览不提供密码剪贴板操作。'}</small></form>`);
    protectSecretDialog(dialog); let queue = Promise.resolve();
    const form = $('#secret-form', dialog), read = () => Object.fromEntries(new FormData(form));
    for (const field of ['password', 'recoveryCodes', 'secretNotes']) form.elements[field].value = initial.value[field] || '';
    const stashSecret = () => { const value = read(); queue = queue.catch(() => {}).then(() => api('vaultDraft', { accountId, parents: initial.parents, value })); queue.catch(error => { if (form.isConnected) $('#secret-status', dialog).textContent = error.message; }); };
    form.oninput = stashSecret;
    form.onsubmit = event => {
      event.preventDefault(); if (secretBusy) return;
      const value = read(), controls = [...form.querySelectorAll('input,textarea,button')].map(control => [control, control.disabled]);
      secretBusy = true; controls.forEach(([control]) => { control.disabled = true; });
      $('#secret-status', form).textContent = '正在加密保存';
      run(async () => {
        try { await queue; await api('vaultSave', { accountId, parents: initial.parents, value }); if (form.isConnected) clearSecret(); toast('密码已加密保存'); }
        finally { secretBusy = false; if (form.isConnected) { controls.forEach(([control, disabled]) => { control.disabled = disabled; }); $('#secret-status', form).textContent = ''; } }
      });
    };
    $('#secret-generate', dialog).onclick = () => run(async () => { const value = await api('vaultGenerate'); if (!form.isConnected) return; form.elements.password.value = value; stashSecret(); });
    $('#secret-show', dialog).onclick = () => { form.elements.password.type = form.elements.password.type === 'password' ? 'text' : 'password'; };
    $('#secret-copy', dialog).onclick = () => run(async () => { await api('vaultCopy', { value: form.elements.password.value }); toast('已复制；30 秒后仅清理本次剪贴板内容'); });
    $('#secret-history', dialog).onclick = () => run(async () => { await queue; clearSecret(); await secretHistory(accountId); });
    $('#secret-discard', dialog).onclick = () => run(async () => { await queue; await api('vaultDraft', { accountId, clear: true }); clearSecret(); });
    dialog.addEventListener('close', () => { form.querySelectorAll('input,textarea').forEach(input => { input.value = ''; }); }, { once: true });
  }
  async function secretHistory(accountId) {
    const events = await api('vaultHistory', { accountId });
    const dialog = openModal('密码修改历史', `<p>解锁后才能查看。选择一个版本，核对并保存后生成新修改。</p>${events.filter(e => !e.deleted).map(e => `<button class="personal-row" data-secret-version="${e.id}">${esc(new Date(e.createdAt).toLocaleString())} · ${esc(e.deviceId.slice(0, 8))}</button>`).join('')}`);
    protectSecretDialog(dialog); dialog.querySelectorAll('[data-secret-version]').forEach(button => button.onclick = () => run(() => secret(accountId, button.dataset.secretVersion)));
  }
  window.desktop?.onVaultLocked?.(clearSecret);
  setInterval(() => { if (secretDialog?.open && !secretBusy && $('#secret-form,.vault-recovery,#vault-reset')) api('vaultStatus').then(status => { if (!status.unlocked && !status.pendingSetup) { clearSecret(); toast('密码库已自动锁定'); } }).catch(() => clearSecret()); }, 1000);
  async function changes(offset = 0) {
    capture(); activeForm = null; view = 'changes'; ++serial;
    const request = serial;
    const result = await api('changeList', { offset, limit: 100 }); if (view !== 'changes' || serial !== request) return;
    const main = $('#main'); main.className = 'settings-view personal-history';
    main.innerHTML = `<div class="page-heading"><div><h1>修改记录</h1><p class="muted">查看用户与外部 Agent 的操作。整批撤回会产生新的修改记录。</p></div><span>${result.total} 批</span></div><div class="change-list">${result.rows.map(row => `<button class="change-row" data-change-id="${row.id}">${icon(row.reversalOf ? 'undo-2' : 'history')}<span><strong>${esc(row.title)}</strong><small>${esc(row.actor)} · ${new Date(row.at).toLocaleString()}</small></span><b>${row.count} 个对象</b>${icon('chevron-right')}</button>`).join('') || '<div class="personal-empty">暂无修改批次。升级前的记录仍可从各对象历史查看。</div>'}</div>`;
    const pager = document.createElement('div'); pager.className = 'inline-actions';
    pager.innerHTML = `<button class="secondary" id="changes-prev" ${offset ? '' : 'disabled'}>上一页</button><span>${result.total ? offset + 1 : 0}–${Math.min(offset + 100, result.total)} / ${result.total}</span><button class="secondary" id="changes-next" ${offset + 100 >= result.total ? 'disabled' : ''}>下一页</button>`;
    main.append(pager);
    $('#changes-prev', main).onclick = () => run(() => changes(Math.max(0, offset - 100)));
    $('#changes-next', main).onclick = () => run(() => changes(offset + 100));
    main.querySelectorAll('[data-change-id]').forEach(button => button.onclick = () => run(async () => {
      const detail = await api('changeDetail', { id: button.dataset.changeId });
      if (view !== 'changes' || serial !== request) return;
      const dialog = openModal(detail.data.title, `<p>操作来源：${esc(detail.data.actor)}。已有后续修改、冲突或新增引用时会阻止直接撤回。</p>${detail.items.map(item => `<details><summary>${esc(item.title)}${item.available ? '' : ' · 历史已清理'}</summary>${item.secret ? '<p>密码版本仅可在独立密码库解锁后查看与恢复。</p>' : `<div class="change-diff"><div><h3>修改前</h3><pre>${esc(JSON.stringify(item.before.map(e => e?.data), null, 2))}</pre></div><div><h3>修改后</h3><pre>${esc(JSON.stringify(item.after.map(e => e?.data), null, 2))}</pre></div></div>`}</details>`).join('')}`, '<button class="primary" id="change-undo">撤回整批操作</button>');
      $('#change-undo', dialog).onclick = () => run(async () => { const control = $('#change-undo', dialog); control.disabled = true; try { await api('changeUndo', { id: detail.id }); dialog.close(); toast('整批操作已撤回，原历史保留'); await changes(); } finally { if (control.isConnected) control.disabled = false; } });
    })); redrawIcons();
  }
  return { init, show, changes, select, create, flush, save, saveAll, snapshot, dirty: () => snapshot().length > 0 || secretBusy, clearSecret, openVault: vault,
    createCurrent: () => action('new'),
    leave: () => { capture(); activeForm = null; view = null; serial++; } };
}
