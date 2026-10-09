import { createIcons, icons } from 'lucide';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<i data-lucide="${name}"></i>`;
const button = (name, action, title, extra = '') => `<button class="icon-button" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon(name)}</button>`;
const uid = () => crypto.randomUUID();
const markdownConverter = new TurndownService({ headingStyle: 'atx' });
markdownConverter.use(gfm);
const token = $('meta[name=local-token]').content;
const native = !!window.desktop;
const api = async (method, input = {}) => {
  if (native) return window.desktop.call(method, input);
  const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StudySelf-Token': token }, body: JSON.stringify({ method, input }) });
  const result = await response.json();
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
};
const formatTime = time => time ? new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无记录';
const bytes = size => size > 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : size > 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil((size || 0) / 1024)} KB`;
const label = { local: '已本地保存', waiting: '等待客户端传输', received: '另一台已接收' };
const typeLabel = { note: '正式笔记', draft: '草稿', conversation: '对话', source: '来源', annotation: '备注', proposal: '整理方案', workspace: '工作区', asset: '附件', model: '模型', task: '任务', usage: '用量' };
const navs = [
  ['notes', 'library', '知识库'], ['drafts', 'inbox', '收集与草稿'], ['proposals', 'list-checks', '整理方案'],
  ['conversations', 'messages-square', '对话历史'], ['assets', 'paperclip', '资料与附件'],
  ['conflicts', 'git-merge', '版本冲突'], ['trash', 'trash-2', '回收站'],
  ['models', 'cpu', '模型管理'], ['sync', 'refresh-cw', '多电脑同步'], ['backup', 'archive', '独立备份']
];
const state = { view: 'notes', domain: '', query: '', snapshot: null, rows: [], tabs: [], selectedTab: null,
  selected: null, editor: null, aiVisible: true, sourceVisible: false, models: [], activeConversation: null, busy: false, listLimit: 150 };
let persistTimer, queryTimer, refreshTimer, modalCleanup;
function toast(message, error = false) {
  const element = $('#toast'); element.textContent = message; element.className = `show ${error ? 'error' : ''}`;
  clearTimeout(element.timer); element.timer = setTimeout(() => element.className = '', 5000);
}
function safeHtml(text, format) {
  const clean = DOMPurify.sanitize(format === 'html' ? text || '' : marked.parse(text || ''), { FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'style', 'input', 'form'] });
  return clean;
}
function excerpt(record) {
  const html = safeHtml(record.data.content || '', record.data.format);
  const temp = document.createElement('div'); temp.innerHTML = html;
  return temp.textContent.slice(0, 85) || (record.type === 'conversation' ? record.data.messages?.at(-1)?.content?.slice(0, 85) : '') || '暂无正文';
}
function redrawIcons() { createIcons({ icons, attrs: { 'stroke-width': 1.7 } }); }
function currentTab() { return state.tabs.find(t => t.id === state.selectedTab); }
function stash() {
  const tab = currentTab();
  if (tab && state.editor && state.selected?.id === tab.recordId) {
    tab.scroll = $('.editor-scroll')?.scrollTop || 0;
    if (tab.dirty) {
      tab.draft = { ...state.selected.data, title: $('#note-title')?.value || state.selected.data.title,
        content: state.editor.getHTML(), format: 'html' };
    }
  }
}
async function persist() {
  stash();
  await api('workspaceSave', { tabs: state.tabs, selectedTab: state.selectedTab });
}
function changed() {
  const tab = currentTab(); if (!tab) return;
  if (!tab.dirty) tab.baseHeads = [...state.selected.heads];
  tab.dirty = true;
  const badge = $('#save-state'); if (badge) badge.textContent = '尚未保存';
  clearTimeout(persistTimer); persistTimer = setTimeout(() => persist().catch(error => toast(error.message, true)), 500);
}
async function loadState() {
  state.snapshot = await api('state');
  state.models = await api('models');
}
async function refreshRows() {
  const type = ({ notes: 'note', drafts: 'draft', proposals: 'proposal', conversations: 'conversation' })[state.view];
  state.rows = await api('records', { type, domain: state.domain || undefined, query: state.query || undefined,
    trash: state.view === 'trash', limit: state.listLimit, preview: true });
  if (state.view === 'conflicts') state.rows = state.rows.filter(row => row.conflict);
}
function domainOptions(selected = '', all = true) {
  const domains = [...new Set(['AI', '金融', '英语', '电商', '足球分析', '区块链', '通用', ...(state.snapshot.domains || []), ...state.tabs.map(t => t.domain), ...state.rows.map(r => r.data.domain)].filter(Boolean))];
  return `${all ? '<option value="">全部领域</option>' : ''}${domains.map(d => `<option ${selected === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}`;
}
function countFor(view) {
  if (view === 'conflicts') return state.snapshot.conflicts;
  if (view === 'trash') return state.snapshot.trash;
  return state.snapshot.counts[({ notes: 'note', drafts: 'draft', proposals: 'proposal', conversations: 'conversation', assets: 'asset', models: 'model' })[view]] || 0;
}
function shell() {
  const active = navs.find(n => n[0] === state.view);
  $('#app').innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="#" data-action="home"><span class="brand-mark">${icon('notebook-pen')}</span><span>StudySelf<small>个人知识工作区</small></span></a>
      <button class="new-note primary" data-action="new">${icon('plus')}新建笔记</button>
      <nav>${navs.map(([id, i, text], index) => `${index === 7 ? '<div class="nav-divider">工作区管理</div>' : ''}<button class="nav-item ${state.view === id ? 'active' : ''}" data-nav="${id}">${icon(i)}<span>${text}</span>${countFor(id) ? `<b>${countFor(id)}</b>` : ''}</button>`).join('')}</nav>
      <div class="device"><span class="device-icon">${icon('monitor')}</span><div><strong>${esc(state.snapshot.deviceName)}</strong><small>本地工作区 · v${state.snapshot.version}</small></div>${button('settings-2', 'device-name', '设备名称')}</div>
      <button class="sidebar-status" data-nav="sync"><span class="status-dot ${state.snapshot.sync.configured ? '' : 'amber'}"></span>${state.snapshot.sync.configured ? '文件夹同步 · 待双机验证' : '同步尚未配置'}${icon('chevron-right')}</button>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb">${icon(active[1])}<strong>${active[2]}</strong><span>/</span><select id="domain-filter" aria-label="知识领域">${domainOptions(state.domain)}</select></div>
        <div class="top-actions"><label class="search">${icon('search')}<input id="search" placeholder="搜索当前范围" value="${esc(state.query)}" aria-label="搜索笔记"></label>${button('panel-right', 'toggle-ai', '显示或隐藏 AI 面板')}${button('refresh-cw', 'sync-now', '同步一次')}</div>
      </header>
      <div class="work-tabs">${state.tabs.map(tab => `<div class="work-tab ${tab.id === state.selectedTab ? 'selected' : ''}" data-tab="${tab.id}" title="${esc(tab.domain)} / ${esc(tab.title)}">${icon('file-text')}<span>${esc(tab.title)}${tab.dirty ? ' ·' : ''}</span><small>${esc(tab.domain)}</small><button data-close-tab="${tab.id}" aria-label="关闭标签">${icon('x')}</button></div>`).join('')}<button class="tab-add" data-action="new" title="新建笔记" aria-label="新建笔记">${icon('plus')}</button><div class="tab-spacer"></div>${button('upload', 'publish-workspace', '发布当前工作区')}${button('panels-top-left', 'adopt-workspace', '接续其他电脑的工作区')}</div>
      <main id="main"></main>
      <footer class="statusbar"><span>${icon('hard-drive')}本地保存</span><span>${state.snapshot.unexported} 条待生成传输记录</span><span>${state.snapshot.pendingParents} 条等待前置版本</span><span class="status-right">云端上传状态：未核验</span></footer>
    </div>`;
  $('#domain-filter').addEventListener('change', async e => { await persist(); state.domain = e.target.value; await refreshRows(); await renderView(); });
  $('#search').addEventListener('input', e => {
    state.query = e.target.value;
    clearTimeout(queryTimer); queryTimer = setTimeout(async () => { await refreshRows(); await renderView(); }, 200);
  });
}
async function render() {
  stash(); state.editor?.destroy(); state.editor = null;
  await loadState(); await refreshRows(); shell(); await renderView(); redrawIcons();
}
async function renderView() {
  stash(); state.editor?.destroy(); state.editor = null;
  if (['notes', 'drafts', 'conflicts', 'trash', 'conversations', 'proposals'].includes(state.view)) await renderLibrary();
  else if (state.view === 'sync') renderSync();
  else if (state.view === 'backup') renderBackup();
  else if (state.view === 'models') renderModels();
  else if (state.view === 'assets') await renderAssets();
  redrawIcons();
}
async function renderLibrary() {
  const title = navs.find(n => n[0] === state.view)[2];
  $('#main').className = 'library-layout';
  $('#main').innerHTML = `<section class="record-list"><div class="list-heading"><strong>${title}</strong><span>${state.rows.length}</span>${button('plus', state.view === 'proposals' ? 'proposal-new' : 'new', '新建')}</div>
    <div class="list-rows">${state.rows.length ? state.rows.map(row => `<button class="record-row ${state.selected?.id === row.id ? 'selected' : ''}" data-record="${row.id}">
    <div class="row-kicker"><span>${esc(row.data.domain)}</span><time>${formatTime(row.updatedAt)}</time></div><strong>${row.conflict ? icon('git-merge') : ''}${esc(row.data.title)}</strong>
    <p>${esc(excerpt(row))}</p><div class="row-tags">${(row.data.tags || []).slice(0, 2).map(tag => `<span>${esc(tag)}</span>`).join('')}<small class="delivery ${row.status}">${label[row.status]}</small></div></button>`).join('') : '<div class="list-empty">暂无内容</div>'}${state.rows.length >= state.listLimit ? '<button class="text-button load-more" data-action="load-more">加载更多</button>' : ''}</div></section>
    <section class="document-area" id="document-area"></section>`;
  if (state.selected) {
    const latest = await api('record', { id: state.selected.id });
    if (latest) { state.selected = latest; await renderDocument(latest); return; }
  }
  $('#document-area').innerHTML = `<div class="empty-state">${icon('notebook-pen')}<h2>${state.view === 'trash' ? '回收站为空' : '从一条知识开始'}</h2><button class="primary" data-action="new">${icon('plus')}新建笔记</button></div>`;
}
async function renderDocument(record) {
  const tab = currentTab();
  const data = tab?.recordId === record.id && tab.draft ? tab.draft : record.data;
  const editable = ['note', 'draft', 'source', 'annotation'].includes(record.type) && !record.deleted && !record.conflict;
  $('#document-area').innerHTML = `
    <div class="document-top"><span class="document-type">${icon(record.type === 'conversation' ? 'messages-square' : 'file-text')}${typeLabel[record.type] || record.type}</span><span id="save-state" class="muted">${tab?.dirty ? '尚未保存' : label[record.status]}</span>
      <div class="document-actions">${button('panel-left-open', 'toggle-source', '原资料')}${button('history', 'history', '历史版本')}${button('message-square-plus', 'annotate', '添加备注')}${button('download', 'export', '导出 Markdown')}${button('printer', 'pdf', '导出 PDF')}${button('trash-2', 'delete', '移入回收站')}${editable || tab?.dirty ? `<button class="primary compact" data-action="save">${icon('save')}保存</button>` : ''}</div></div>
    ${record.conflict ? `<div class="notice amber">${icon('git-merge')}存在 ${record.versions.length} 个并发版本，未自动覆盖。<button data-action="resolve">对照处理</button></div>` : ''}
    ${record.deleted ? `<div class="notice amber">${icon('trash-2')}此内容已进入回收站。<button data-action="restore">恢复内容</button></div>` : ''}
    <div class="reading-layout ${state.aiVisible ? 'with-ai' : ''} ${state.sourceVisible ? 'with-source' : ''}">
      ${state.sourceVisible ? '<aside class="source-pane" id="source-pane"></aside>' : ''}
      <article class="editor-panel">
        <div class="document-heading"><div class="document-breadcrumb">${esc(data.domain)}<span>/</span>${typeLabel[record.type] || '知识'}</div>
          ${editable ? `<input id="note-title" class="note-title" value="${esc(data.title)}" aria-label="笔记标题">` : `<h1>${esc(data.title)}</h1>`}
          <div class="note-meta"><button data-action="metadata" class="metadata-button">${icon('tags')}${data.tags?.length ? data.tags.map(esc).join(' · ') : '标签与领域'}</button>${data.sensitive ? `<span class="sensitive">${icon('shield-check')}不交给云端 AI</span>` : ''}<time>${formatTime(record.updatedAt)}</time></div>
        </div>
        ${editable ? `<div class="editor-toolbar">${button('bold', 'fmt-bold', '加粗')}${button('italic', 'fmt-italic', '斜体')}${button('heading-2', 'fmt-heading', '标题')}${button('list', 'fmt-list', '无序列表')}${button('list-ordered', 'fmt-ordered', '有序列表')}${button('quote', 'fmt-quote', '引用')}${button('code-2', 'fmt-code', '代码块')}${button('table-2', 'fmt-table', '插入表格')}<span class="toolbar-divider"></span>${button('undo-2', 'fmt-undo', '撤销')}${button('redo-2', 'fmt-redo', '重做')}${button('paperclip', 'attach', '关联附件')}</div>` : ''}
        <div class="editor-scroll"><div id="editor-content" class="document-content"></div><div id="annotations"></div></div>
      </article>
      ${state.aiVisible ? '<aside class="ai-panel" id="ai-panel"></aside>' : ''}
    </div>`;
  if (editable) {
    state.editor = new Editor({
      element: $('#editor-content'), extensions: [StarterKit.configure({ link: { openOnClick: false } }), TableKit.configure({ table: { resizable: true } })],
      content: safeHtml(data.content || '', data.format), editorProps: { attributes: { 'aria-label': '笔记正文', role: 'textbox', 'aria-multiline': 'true' } },
      onUpdate: changed
    });
    $('#note-title').addEventListener('input', changed);
    $('.editor-scroll').addEventListener('scroll', () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => persist().catch(() => {}), 500); });
    $('.editor-scroll').scrollTop = tab?.scroll || 0;
  } else if (record.type === 'conversation') {
    $('#editor-content').innerHTML = (data.messages || []).map(message => `<section class="message ${message.role}"><div class="message-role">${message.role === 'user' ? '我' : 'AI'}<small>${formatTime(message.at)}</small></div><div>${safeHtml(message.content)}</div></section>`).join('') + '<button class="secondary" data-action="conversation-to-draft">选定内容整理入库</button>';
  } else if (record.type === 'proposal') {
    $('#editor-content').innerHTML = `<div class="proposal-items">${data.items.map(item => `<section class="proposal-item"><label class="check-row"><input type="checkbox" data-proposal-item="${item.id}" ${item.status === 'accepted' ? 'disabled checked' : ''}><strong>${esc(item.data.title)}</strong><span class="pill ${item.status === 'accepted' ? 'green' : ''}">${item.status === 'accepted' ? '已确认' : '待确认'}</span></label><div class="prose">${safeHtml(item.data.content, item.data.format)}</div></section>`).join('')}</div><div class="sticky-actions"><button class="primary" data-action="approve">确认选中部分</button><button class="secondary" data-action="proposal-edit">修改待确认部分</button></div>`;
  } else $('#editor-content').innerHTML = safeHtml(data.content || '', data.format);
  if (['note', 'draft', 'source'].includes(record.type)) {
    const annotations = (await api('records', { type: 'annotation' })).filter(item => item.data.noteId === record.id);
    $('#annotations').innerHTML = annotations.length ? `<h3>备注 <small>${annotations.length}</small></h3>${annotations.map(item => `<div class="annotation">${item.data.quote ? `<blockquote>${esc(item.data.quote)}</blockquote>` : ''}<div>${esc(item.data.content)}</div><small>${formatTime(item.updatedAt)}</small></div>`).join('')}` : '';
  }
  if (state.sourceVisible) await renderSources(record);
  if (state.aiVisible) await renderAI(record);
}
async function renderSources(record) {
  const assets = await api('assets');
  const linked = assets.filter(a => record.data.assetIds?.includes(a.id));
  const sources = (await api('records', { type: 'source' })).filter(s => record.data.sourceIds?.includes(s.id));
  $('#source-pane').innerHTML = `<div class="panel-heading">${icon('files')}原资料${button('paperclip', 'attach', '添加附件')}</div>
    <div class="source-list">${linked.map(a => `<button class="source-item" data-preview-asset="${a.id}">${icon(a.data.mime.startsWith('image/') ? 'image' : 'file-text')}<span>${esc(a.data.title)}<small>${a.available ? bytes(a.data.size) : '本机尚未下载'}</small></span></button>`).join('')}${sources.map(s => `<button class="source-item" data-record="${s.id}">${icon('link')}<span>${esc(s.data.title)}</span></button>`).join('')}</div><div id="source-preview" class="source-preview">${!linked.length && !sources.length ? '<span class="muted">尚未关联原资料</span>' : ''}</div>`;
}
async function renderAI(record) {
  const tab = currentTab();
  const domain = record.data.domain;
  const conversation = tab?.conversationId ? await api('record', { id: tab.conversationId }) : null;
  state.activeConversation = conversation?.data.domain === domain ? conversation : null;
  $('#ai-panel').innerHTML = `<div class="panel-heading">${icon('sparkles')}AI 讨论${button('plus', 'new-chat', '新建独立对话')}</div>
    <div class="scope-label">${icon('shield')}范围：${esc(domain)}<span>仅当前领域</span></div>
    <select id="chat-model" aria-label="对话模型"><option value="">选择本机可用模型</option>${state.models.map(model => `<option value="${model.id}" ${!model.availability.available ? 'disabled' : ''} ${tab?.modelId === model.id ? 'selected' : ''}>${esc(model.data.title)}${!model.availability.available ? ' · 不可用' : ''}</option>`).join('')}</select>
    <div class="chat-messages">${state.activeConversation ? state.activeConversation.data.messages.map(m => `<div class="chat-bubble ${m.role}"><small>${m.role === 'user' ? '我' : 'AI'}</small>${safeHtml(m.content)}</div>`).join('') : '<div class="chat-empty"><span>新对话</span><small>尚未调用任何模型</small></div>'}</div>
    <form id="chat-form" class="chat-compose"><label class="check-row"><input id="include-note" type="checkbox" ${record.type === 'note' || record.type === 'draft' ? 'checked' : ''}>引用已保存的当前笔记</label><textarea id="chat-prompt" placeholder="输入问题…" aria-label="AI 对话消息" rows="3" required></textarea>
      <div class="compose-footer"><span>发送前核对模型与费用</span><button type="submit" class="icon-button primary" title="预览费用并发送" aria-label="预览费用并发送">${icon('arrow-up')}</button></div></form>`;
  $('#chat-model').addEventListener('change', e => { if (tab) { tab.modelId = e.target.value; persist().catch(() => {}); } });
  $('#chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.busy) return;
    await run(async () => {
      const modelId = $('#chat-model').value;
      if (!modelId) throw new Error('请先选择可用模型');
      const input = { modelId, domain, prompt: $('#chat-prompt').value, callId: uid(),
        conversationId: state.activeConversation?.id, noteId: $('#include-note').checked ? record.id : undefined };
      const estimate = await api('estimate', input);
      const accepted = await confirmBox('确认模型调用', `<div class="definition-list"><div><span>模型</span><strong>${esc(state.models.find(m => m.id === modelId)?.data.title)}</strong></div><div><span>预计费用</span><strong>${estimate.amount === null ? '价格未配置，无法估算' : `${estimate.currency} ${estimate.amount.toFixed(6)}`}</strong></div><div><span>执行位置</span><strong>${estimate.local ? '本机 Ollama' : '云端服务商'}</strong></div></div><p class="muted">费用为估算，最终账单以服务商为准。失败不会自动重试。</p>`, '发送');
      if (!accepted) return;
      state.busy = true; toast('模型处理中，可继续保留当前工作区');
      try {
        const result = await api('ask', { ...input, estimateShown: true, confirmed: true });
        // Bind the result to its originating tab even if another tab is now active.
        if (tab) { tab.conversationId = result.conversation.id; tab.modelId = modelId; }
        await persist(); await loadState(); await render(); toast('回答已保存到独立对话');
      } finally { state.busy = false; }
    });
  });
}
function renderSync() {
  const { sync } = state.snapshot;
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">设备与数据</div><h1>多电脑同步</h1></div><div class="heading-actions"><button class="secondary" data-action="sync-pause">${icon(sync.enabled ? 'pause' : 'play')}${sync.enabled ? '暂停同步' : '启用同步'}</button><button class="primary" data-action="sync-now">${icon('refresh-cw')}同步一次</button></div></div>
    <div class="notice amber">${icon('shield-alert')}百度网盘真实双机传输尚待验证；本机不会推断云端上传已经完成。</div>
    <div class="stat-band"><div><span>本地设备</span><strong>${esc(state.snapshot.deviceName)}</strong></div><div><span>待生成传输记录</span><strong>${state.snapshot.unexported}</strong></div><div><span>等待前置版本</span><strong>${state.snapshot.pendingParents}</strong></div><div><span>最后接收回执</span><strong class="small-stat">${formatTime(state.snapshot.lastReceiptAt)}</strong></div></div>
    <section class="settings-section"><h2>传输目录与配对</h2><form id="sync-form" class="settings-form"><label>百度网盘专用同步目录<div class="input-with-action"><input id="sync-folder" value="${esc(sync.folder)}" placeholder="选择同步空间中的专用文件夹" required>${button('folder-open', 'choose-sync-folder', '选择同步文件夹')}</div></label>
      <label>设备配对密钥<div class="input-with-action"><input id="sync-key" type="password" autocomplete="off" placeholder="${sync.configured ? '保持为空则沿用当前密钥' : '两台电脑填写同一配对密钥'}">${button('key-round', 'pairing-key', '生成或查看配对密钥')}</div></label>
      <div class="form-actions"><span class="muted">配对指纹：${esc(sync.channel || '尚未配置')}<br>配对密钥不随知识库同步，请单独妥善保存。</span><button class="primary" type="submit">保存配置</button></div></form></section>
    <section class="settings-section"><h2>最近一次本地同步检查</h2>${sync.lastReport ? `<div class="definition-list"><div><span>检查时间</span><strong>${formatTime(sync.lastReport.finishedAt)}</strong></div><div><span>已生成传输记录</span><strong>${sync.lastReport.published || 0}</strong></div><div><span>已导入版本</span><strong>${sync.lastReport.imported || 0}</strong></div><div><span>云端上传状态</span><strong>无法直接核验</strong></div></div>${(sync.lastReport.errors || []).map(error => `<div class="notice danger">${icon('triangle-alert')}<div>${esc(error.file || '')}<br>${esc(error.message)}</div></div>`).join('')}` : '<div class="section-empty">尚未执行同步检查</div>'}</section>`;
  $('#sync-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
    let key = $('#sync-key').value.trim();
    if (!key && sync.configured) key = (await api('pairingKey')).key;
    await api('syncConfigure', { folder: $('#sync-folder').value.trim(), key }); await render(); toast('配置已保存；真实网盘传输仍待核验');
  }); });
}
function renderBackup() {
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">独立恢复点</div><h1>备份与恢复</h1></div><button class="secondary" data-action="restore-backup">${icon('archive-restore')}从备份恢复</button></div>
    <div class="notice">${icon('info')}本页显示本地备份成果。网盘上传完成状态请在百度客户端核验。</div>
    <section class="settings-section"><h2>创建版本化备份</h2><form id="backup-form" class="settings-form"><label>备份输出目录<div class="input-with-action"><input id="backup-folder" placeholder="选择独立于本地数据库的备份目录" required>${button('folder-open', 'choose-backup-folder', '选择备份目录')}</div></label><label class="check-row"><input id="backup-large" type="checkbox">本次同时复制大文件；否则保留待补全记录</label><label class="check-row"><input id="backup-idle" type="checkbox" ${state.snapshot.idleBackup.enabled ? 'checked' : ''} ${state.snapshot.idleBackup.supported ? '' : 'disabled'}>本机空闲两分钟后补全大文件${state.snapshot.idleBackup.supported ? '' : ' · 仅桌面客户端'}</label><button type="submit" class="primary">${icon('archive')}创建备份</button></form>${state.snapshot.idleBackup.error ? `<div class="notice danger">${esc(state.snapshot.idleBackup.error)}</div>` : ''}</section>
    <section class="settings-section"><h2>备份记录 <small>${state.snapshot.backups.length}</small></h2>${state.snapshot.backups.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>时间与位置</th><th>版本数</th><th>本地状态</th><th>云端状态</th><th></th></tr></thead><tbody>${state.snapshot.backups.map((backup, i) => `<tr><td><strong>${formatTime(backup.createdAt)}</strong><small class="file-path">${esc(backup.directory)}</small></td><td>${backup.revisions}</td><td><span class="pill ${backup.localComplete ? 'green' : 'amber'}">${backup.localComplete ? '本地文件完整' : `${backup.pending} 个附件待补全`}</span></td><td>未核验</td><td><div class="inline-actions">${button('shield-check', 'verify-backup', '校验备份', `data-index="${i}"`)}${backup.pending ? button('play', 'continue-backup', '继续补全大文件', `data-index="${i}"`) : ''}${button('archive-restore', 'restore-existing-backup', '恢复此备份', `data-index="${i}"`)}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="section-empty">尚未创建备份</div>'}</section>`;
  $('#backup-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
    const button = $('#backup-form button[type=submit]'); button.disabled = true;
    try { await api('backupIdleEnable', { enabled: $('#backup-idle').checked }); const result = await api('backupCreate', { directory: $('#backup-folder').value.trim(), includeLarge: $('#backup-large').checked }); await render(); toast(result.localComplete ? '本地备份已生成；网盘上传未核验' : '核心备份已生成，部分附件等待补全'); } finally { button.disabled = false; }
  }); });
}
function renderModels() {
  const providers = state.snapshot.providers;
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">当前电脑的执行能力</div><h1>模型管理中心</h1></div><div class="heading-actions"><button class="secondary" data-action="compare">${icon('columns-2')}测试比较</button><button class="primary" data-action="model-new">${icon('plus')}添加模型</button></div></div>
    <div class="stat-band"><div><span>目录模型</span><strong>${state.models.length}</strong></div><div><span>本机可用配置</span><strong>${state.models.filter(m => m.availability.available).length}</strong></div><div><span>本机内存</span><strong>${bytes(state.snapshot.capabilities.memoryBytes)}</strong></div><div><span>后台任务</span><strong>${state.snapshot.counts.task}</strong></div></div>
    <section class="settings-section"><div class="section-heading"><h2>服务商</h2><button class="text-button" data-action="provider-custom">${icon('plus')}自定义服务</button></div>
      <div class="provider-grid">${providers.map(provider => `<div class="provider-item"><span class="provider-symbol">${icon(provider.protocol === 'ollama' ? 'hard-drive' : 'cloud')}</span><div><strong>${esc(provider.name)}</strong><small>${provider.protocol === 'ollama' ? '只连接本机 Ollama' : provider.hasKey ? '本机已配置密钥' : '本机未配置密钥'}</small></div><div class="inline-actions">${button('plug-zap', 'provider-test', '检测连接', `data-provider="${esc(provider.id)}"`)}${button('settings-2', 'provider-config', '配置服务', `data-provider="${esc(provider.id)}"`)}</div></div>`).join('')}</div></section>
    <section class="settings-section"><h2>共享模型目录</h2>${state.models.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>模型</th><th>服务商</th><th>本机状态</th><th>输入 / 输出价格 · 每百万 Token</th><th></th></tr></thead><tbody>${state.models.map(model => `<tr><td><strong>${esc(model.data.title)}</strong><small>${esc(model.data.modelName)}</small></td><td>${esc(providers.find(p => p.id === model.data.providerId)?.name || model.data.providerId)}</td><td><span class="pill ${model.availability.available ? 'green' : ''}">${model.availability.local ? '本地模型' : model.availability.available ? '已配置' : '不可用'}</span><small>${esc(model.availability.reason)}</small></td><td>${model.data.inputRate == null ? '未配置' : `${esc(model.data.currency)} ${model.data.inputRate} / ${model.data.outputRate}`}</td><td>${button('pencil', 'model-edit', '编辑模型', `data-model="${model.id}"`)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="section-empty">尚未添加模型。模型目录不会自动下载或调用模型。</div>'}</section>
    <section class="settings-section"><h2>费用中心</h2><div class="section-subtitle">用量截至 ${formatTime(state.snapshot.usage.asOf)} · 仅已导入的调用记录，非实时全量账单</div>
    ${state.snapshot.usage.unsettledTasks ? `<div class="notice amber">${icon('triangle-alert')}${state.snapshot.usage.unsettledTasks} 次失败或中断任务费用未知，需在服务商核对。</div>` : ''}
    ${Object.keys(state.snapshot.usage.totals).length ? Object.entries(state.snapshot.usage.totals).map(([currency, total]) => `<div class="stat-band"><div><span>${esc(currency)} 按用量估算</span><strong>${total.estimated.toFixed(6)}</strong><small>${total.unknownCost || 0} 次费用未知</small></div><div><span>服务商账单</span><strong class="small-stat">未接入账单接口</strong></div><div><span>已返回输入 / 输出 Token</span><strong class="small-stat">${total.inputTokens} / ${total.outputTokens}</strong><small>${total.unknownUsage || 0} 次未返回用量</small></div><div><span>去重调用数</span><strong>${total.requests}</strong></div></div>`).join('') : '<div class="section-empty">暂无已返回的用量记录</div>'}</section>
    <section class="settings-section"><h2>最近任务</h2>${state.snapshot.recentTasks.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>任务</th><th>执行设备</th><th>状态</th><th>时间</th></tr></thead><tbody>${state.snapshot.recentTasks.map(task => `<tr><td>${esc(task.data.title)}</td><td>${task.data.ownerDevice === state.snapshot.deviceId ? '当前电脑' : esc(task.data.ownerDevice.slice(0, 8))}</td><td>${esc(({ completed: '已完成', running: '执行中 / 待设备确认', failed_cost_unknown: '失败，费用未知', interrupted_cost_unknown: '中断，费用未知' })[task.data.status] || task.data.status)}</td><td>${formatTime(task.updatedAt)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="section-empty">暂无任务</div>'}</section>`;
}
async function renderAssets() {
  const assets = await api('assets');
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">原文件与稳定引用</div><h1>资料与附件</h1></div><button class="primary" data-action="asset-import">${icon('upload')}导入文件</button></div>
    ${assets.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>附件</th><th>领域</th><th>大小</th><th>本机状态</th><th>保留策略</th><th></th></tr></thead><tbody>${assets.map(asset => `<tr><td><strong>${esc(asset.data.filename)}</strong><small>${asset.data.sha256.slice(0, 16)}…</small></td><td>${esc(asset.data.domain)}</td><td>${bytes(asset.data.size)}</td><td><span class="pill ${asset.available ? 'green' : 'amber'}">${asset.available ? '本机文件可用' : '需要下载后关联'}</span></td><td>${asset.pinned ? '长期保留' : asset.data.priority === 'large' ? '按需获取' : '优先传输'}</td><td><div class="inline-actions">${button(asset.available ? 'eye' : 'link', asset.available ? 'preview-asset' : 'bind-asset', asset.available ? '查看附件' : '关联已下载文件', `data-asset="${asset.id}"`)}${asset.available ? button('pin', 'pin-asset', asset.pinned ? '取消长期保留' : '长期保留', `data-asset="${asset.id}" data-pinned="${asset.pinned}"`) : ''}</div></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state">${icon('files')}<h2>暂无原文件</h2><button class="secondary" data-action="asset-import">导入文件</button></div>`}`;
}
function openModal(title, body, footer = '') {
  const dialog = $('#modal');
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="modal-heading"><h2>${esc(title)}</h2><button class="icon-button" data-modal-close aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  dialog.showModal(); redrawIcons();
  $('[data-modal-close]', dialog).onclick = () => dialog.close();
  dialog.onclose = () => { modalCleanup?.(); modalCleanup = null; };
  return dialog;
}
function confirmBox(title, body, accept = '确认') {
  return new Promise(resolve => {
    const dialog = openModal(title, body, `<button class="secondary" data-cancel>取消</button><button class="primary" data-confirm>${esc(accept)}</button>`);
    let decided = false;
    const finish = value => { decided = true; dialog.close(); resolve(value); };
    $('[data-confirm]', dialog).onclick = () => finish(true);
    $('[data-cancel]', dialog).onclick = () => finish(false);
    modalCleanup = () => { if (!decided) resolve(false); };
  });
}
async function inputBox(title, labelText, value = '', multiline = false) {
  return new Promise(resolve => {
    const dialog = openModal(title, `<label class="field-label">${esc(labelText)}${multiline ? `<textarea id="dialog-value" rows="8">${esc(value)}</textarea>` : `<input id="dialog-value" value="${esc(value)}">`}</label>`,
      '<button class="secondary" data-cancel>取消</button><button class="primary" data-confirm>确认</button>');
    let decided = false;
    $('[data-confirm]', dialog).onclick = () => { decided = true; const v = $('#dialog-value').value; dialog.close(); resolve(v); };
    $('[data-cancel]', dialog).onclick = () => dialog.close();
    modalCleanup = () => { if (!decided) resolve(null); };
    $('#dialog-value').focus();
  });
}
async function pickDirectory(target) {
  const value = native ? await api('chooseDirectory') : await inputBox('目录位置', '本机绝对目录路径', target?.value || '');
  if (target && value) target.value = value;
  return value;
}
async function pickAttachment(expectedId) {
  if (native) {
    const file = await api('chooseFile');
    return file ? api('assetImport', { path: file, expectedId, domain: state.selected?.data.domain || state.domain || '通用' }) : null;
  }
  return new Promise((resolve, reject) => {
    const input = $('#file-input'); input.value = '';
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      try {
        const file = input.files[0]; if (!file) { resolve(null); return; }
        const params = new URLSearchParams({ domain: state.selected?.data.domain || state.domain || '通用' });
        if (expectedId) params.set('expectedId', expectedId);
        const response = await fetch(`/upload?${params}`, { method: 'POST', headers: { 'X-StudySelf-Token': token, 'X-Filename': encodeURIComponent(file.name) }, body: file });
        const result = await response.json(); if (result.error) throw new Error(result.error.message); resolve(result.value);
      } catch (error) { reject(error); }
    };
    input.click();
  });
}
async function openRecord(id) {
  await persist();
  state.editor?.destroy(); state.editor = null;
  const record = await api('record', { id }); if (!record) return;
  state.selected = record;
  let tab = state.tabs.find(t => t.recordId === id);
  if (!tab) { tab = { id: uid(), recordId: id, title: record.data.title, domain: record.data.domain, scroll: 0 }; state.tabs.push(tab); }
  state.selectedTab = tab.id;
  state.domain = record.data.domain;
  if (!['conflicts', 'trash'].includes(state.view)) state.view = ({ draft: 'drafts', conversation: 'conversations', proposal: 'proposals' })[record.type] || 'notes';
  await persist(); await render();
}
async function saveNote() {
  const record = state.selected, tab = currentTab();
  if (!record || (!state.editor && !tab?.draft)) return;
  const data = { ...record.data, ...(tab?.draft || {}), title: $('#note-title')?.value.trim() || tab?.draft?.title || record.data.title || '未命名笔记',
    content: state.editor?.getHTML() || tab?.draft?.content || '', format: 'html' };
  const input = { id: record.id, type: record.type, data, parents: tab?.dirty ? tab.baseHeads || record.heads : record.heads };
  let saved;
  try { saved = await api('save', input); }
  catch (error) {
    if (error.code !== 'CONFLICT') throw error;
    const confirmed = await confirmBox('保存期间出现新版本', '<p>其他修改已到达。你可以将当前编辑保存为独立并发版本，再对照融合；不会覆盖新到达的内容。</p>', '保留为并发版本');
    if (!confirmed) throw error;
    saved = await api('saveBranch', input);
  }
  state.selected = saved;
  if (tab) { tab.dirty = false; delete tab.draft; delete tab.baseHeads; tab.title = saved.data.title; tab.domain = saved.data.domain; }
  await persist(); await render(); toast('已保存本地版本');
}
async function showHistory() {
  const history = await api('history', { id: state.selected.id });
  const dialog = openModal('版本历史', `<div class="history-list">${history.map(event => `<section><div class="history-meta"><strong>${formatTime(event.createdAt)}</strong><span>${event.deleted ? '删除记录' : '内容版本'}</span><small>${event.deviceId.slice(0, 8)}</small><button class="text-button" data-version="${event.id}">恢复此版本</button></div><div class="prose">${safeHtml(event.data.content || JSON.stringify(event.data, null, 2), event.data.format)}</div></section>`).join('')}</div>`);
  $$('[data-version]', dialog).forEach(button => button.onclick = () => run(async () => {
    const accepted = await confirmBox('恢复历史版本', '<p>将创建一个新版本，当前内容和已有历史不会删除。</p>', '恢复');
    if (!accepted) return;
    state.selected = await api('restoreVersion', { id: state.selected.id, revision: button.dataset.version, parents: state.selected.heads });
    const tab = currentTab(); if (tab) { delete tab.draft; tab.dirty = false; }
    await render(); toast('已创建恢复版本');
  }));
}
async function resolveConflict() {
  const record = state.selected;
  const dialog = openModal('对照并发版本', `<div class="conflict-columns">${record.versions.map((version, index) => `<section><h3>版本 ${index + 1} ${version.deleted ? '· 删除' : ''}</h3><small>${formatTime(version.createdAt)} · ${version.deviceId.slice(0, 8)}</small><div class="prose">${safeHtml(version.data.content || JSON.stringify(version.data, null, 2), version.data.format)}</div><button class="secondary" data-use-version="${version.id}">保留此版本</button></section>`).join('')}</div>${['note', 'draft', 'source'].includes(record.type) ? '<button class="primary" data-manual-merge>手动融合正文</button>' : ''}`);
  $$('[data-use-version]', dialog).forEach(button => button.onclick = () => run(async () => {
    const version = record.versions.find(v => v.id === button.dataset.useVersion);
    const accepted = await confirmBox('确认处理冲突', '<p>选择的内容将成为新版本，其他版本仍保留在历史中。</p>');
    if (!accepted) return;
    state.selected = await api('save', { id: record.id, type: record.type, data: version.data, parents: record.heads, deleted: version.deleted });
    const tab = currentTab(); if (tab) { tab.dirty = false; delete tab.draft; }
    await render();
  }));
  const merge = $('[data-manual-merge]', dialog);
  if (merge) merge.onclick = () => run(async () => {
    const text = await inputBox('手动融合', '融合后的正文（Markdown）', record.versions.filter(v => !v.deleted).map(v => new TurndownService().turndown(safeHtml(v.data.content, v.data.format))).join('\n\n---\n\n'), true);
    if (text === null) return;
    state.selected = await api('save', { id: record.id, type: record.type, data: { ...record.data, content: text, format: 'markdown' }, parents: record.heads });
    const tab = currentTab(); if (tab) { tab.dirty = false; delete tab.draft; }
    await render();
  });
}
async function configureProvider(id) {
  const provider = state.snapshot.providers.find(p => p.id === id) || { id: '', name: '', protocol: 'openai', endpoint: 'https://' };
  const dialog = openModal('本机服务商配置', `<form id="provider-form" class="settings-form">
    <label>标识<input name="id" required value="${esc(provider.id)}" ${id ? 'readonly' : ''}></label><label>显示名称<input name="name" required value="${esc(provider.name)}"></label>
    <label>协议<select name="protocol">${[['openai', 'OpenAI-compatible Chat Completions'], ['gemini', 'Gemini generateContent'], ['ollama', 'Ollama 本机']].map(([value, label]) => `<option value="${value}" ${provider.protocol === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>服务地址<input name="endpoint" required value="${esc(provider.endpoint)}"></label><label>API 密钥<input name="apiKey" type="password" autocomplete="off" placeholder="${provider.hasKey ? '已保存，留空不修改' : '本机保存，不随知识库同步'}"></label>
    <label class="check-row"><input name="clearKey" type="checkbox">清除此设备已保存的密钥</label><button class="primary" type="submit">保存本机配置</button></form>`);
  $('#provider-form').onsubmit = event => { event.preventDefault(); run(async () => {
    const data = Object.fromEntries(new FormData(event.target)); data.clearKey = data.clearKey === 'on';
    await api('providerSave', data); dialog.close(); await render(); toast('配置仅保存在当前设备');
  }); };
}
async function editModel(id, preset = {}) {
  const record = state.models.find(m => m.id === id), data = record?.data || { title: '', modelName: '', providerId: 'ollama', currency: 'CNY', ...preset };
  const dialog = openModal(id ? '编辑共享模型目录' : '添加共享模型', `<form id="model-form" class="settings-form">
    <label>显示名称<input name="title" required value="${esc(data.title)}"></label><label>服务商<select name="providerId">${state.snapshot.providers.map(p => `<option value="${p.id}" ${data.providerId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label>实际模型名称 / 接入点 ID<input name="modelName" required value="${esc(data.modelName)}"></label>
    <div class="form-grid"><label>输入单价 / 百万 Token<input type="number" name="inputRate" min="0" step="any" value="${data.inputRate ?? ''}"></label><label>输出单价 / 百万 Token<input type="number" name="outputRate" min="0" step="any" value="${data.outputRate ?? ''}"></label></div>
    <label>计价货币<select name="currency"><option ${data.currency === 'CNY' ? 'selected' : ''}>CNY</option><option ${data.currency === 'USD' ? 'selected' : ''}>USD</option></select></label>
    <span class="muted">价格由你核对填写；不代表服务商实时价格。</span><button class="primary" type="submit">保存模型目录</button></form>`);
  $('#model-form').onsubmit = event => { event.preventDefault(); run(async () => {
    const values = Object.fromEntries(new FormData(event.target));
    for (const field of ['inputRate', 'outputRate']) { if (values[field] === '') delete values[field]; else values[field] = Number(values[field]); }
    await api('save', { id: record?.id, type: 'model', parents: record?.heads || [], data: values });
    dialog.close(); await render();
  }); };
}
async function testProvider(id) {
  toast('正在检测连接，不发送生成请求');
  const result = await api('providerTest', { id });
  await loadState();
  const dialog = openModal('连接检测结果', `<div class="notice success">${icon('check')}已读取目录 · ${result.models.length} 个模型</div><div class="model-probe-list">${result.models.map((model, index) => `<div><span><strong>${esc(model.name)}</strong><small>${model.size ? bytes(model.size) : ''}${model.local === false ? ' · 未确认为本地执行' : ''}</small></span><button class="text-button" data-add-probed="${index}">加入目录</button></div>`).join('') || '<div class="section-empty">服务已连接，尚无已安装模型</div>'}</div>`);
  $$('[data-add-probed]', dialog).forEach(button => button.onclick = () => editModel(null, { title: result.models[Number(button.dataset.addProbed)].name, modelName: result.models[Number(button.dataset.addProbed)].name, providerId: id }));
}
async function previewAsset(id) {
  const assets = await api('assets'), asset = assets.find(a => a.id === id);
  if (!asset?.available) {
    const accepted = await confirmBox('附件尚未下载', '<p>请在百度网盘客户端获取原文件，再关联本机文件。系统会核对文件内容是否匹配。</p>', '关联本机文件');
    if (accepted) { await pickAttachment(id); await render(); }
    return;
  }
  if (asset.data.size > 24 * 1024 * 1024) {
    if (native) await api('openAsset', { id });
    else toast('大文件请使用桌面客户端或本机播放器打开');
    return;
  }
  const value = await api('assetContent', { id });
  const binary = Uint8Array.from(atob(value.data), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([binary], { type: value.mime }));
  const html = value.mime.startsWith('image/') && value.mime !== 'image/svg+xml' ? `<img class="asset-image" src="${url}" alt="${esc(value.filename)}">`
    : value.mime === 'application/pdf' ? `<iframe class="pdf-preview" src="${url}" title="${esc(value.filename)}"></iframe>`
    : value.mime.startsWith('text/') ? `<pre class="text-preview">${esc(new TextDecoder().decode(binary))}</pre>`
    : `<div class="section-empty">${esc(value.filename)} · ${bytes(binary.length)}<br>此格式使用本机应用查阅</div>`;
  if ($('#source-preview')) { $('#source-preview').innerHTML = html; }
  else { openModal(value.filename, html); modalCleanup = () => URL.revokeObjectURL(url); }
}
async function compareModels() {
  const available = state.models.filter(m => m.availability.available);
  if (available.length < 2) throw new Error('请先配置至少两个可用模型');
  const options = available.map(m => `<option value="${m.id}">${esc(m.data.title)}</option>`).join('');
  const dialog = openModal('模型测试比较', `<form id="compare-form" class="settings-form"><div class="form-grid"><label>模型 A<select name="a">${options}</select></label><label>模型 B<select name="b">${options}</select></label></div><label>测试资料 / 问题<textarea name="prompt" rows="6" required></textarea></label><button class="primary" type="submit">预览两次调用费用</button></form>`);
  $('select[name=b]', dialog).selectedIndex = 1;
  $('#compare-form').onsubmit = event => { event.preventDefault(); run(async () => {
    const form = Object.fromEntries(new FormData(event.target));
    if (form.a === form.b) throw new Error('请选择两个不同模型');
    const inputs = [form.a, form.b].map(modelId => ({ modelId, domain: state.domain || '通用', prompt: form.prompt, callId: uid() }));
    const estimates = await Promise.all(inputs.map(input => api('estimate', input)));
    const accepted = await confirmBox('确认两次独立调用', estimates.map((estimate, i) => `<p>${esc(available.find(m => m.id === inputs[i].modelId).data.title)}：${estimate.amount == null ? '费用未知' : `${estimate.currency} ${estimate.amount.toFixed(6)}`}</p>`).join(''), '开始比较');
    if (!accepted) return;
    openModal('模型比较进行中', '<div id="compare-results" class="conflict-columns"></div>');
    for (const input of inputs) {
      const title = available.find(m => m.id === input.modelId).data.title;
      try {
        const result = await api('ask', { ...input, estimateShown: true, confirmed: true });
        $('#compare-results')?.insertAdjacentHTML('beforeend', `<section><h3>${esc(title)}</h3><small>${result.elapsedMs} ms · ${result.inputTokens} / ${result.outputTokens} Token</small><div class="prose">${safeHtml(result.answer)}</div></section>`);
      } catch (error) { $('#compare-results')?.insertAdjacentHTML('beforeend', `<section><h3>${esc(title)}</h3><p>${esc(error.message)}</p></section>`); }
    }
    await loadState();
  }); };
}
const actions = {
  'load-more': async () => { state.listLimit += 150; await refreshRows(); await renderView(); },
  home: async () => { state.view = 'notes'; await render(); },
  new: async () => {
    const type = state.view === 'drafts' ? 'draft' : 'note';
    const record = await api('save', { type, data: { title: '未命名笔记', domain: state.domain || 'AI', content: '', format: 'html', tags: [] } });
    await openRecord(record.id); $('#note-title')?.focus(); $('#note-title')?.select();
  },
  save: saveNote,
  'toggle-ai': async () => { state.aiVisible = !state.aiVisible; await render(); },
  'toggle-source': async () => { state.sourceVisible = !state.sourceVisible; await render(); },
  'device-name': async () => { const name = await inputBox('设备名称', '当前电脑', state.snapshot.deviceName); if (name?.trim()) { await api('deviceName', { name }); await render(); } },
  'sync-now': async () => {
    if (!state.snapshot.sync.configured) { state.view = 'sync'; await render(); return; }
    toast('正在检查本地传输目录');
    const result = await api('sync'); await render();
    toast(result.errors.length ? `检查完成，${result.errors.length} 项异常待处理` : `已生成 ${result.published} 条记录，导入 ${result.imported} 个版本`, !!result.errors.length);
  },
  'sync-pause': async () => { await api('syncPause', { paused: state.snapshot.sync.enabled }); await render(); },
  'choose-sync-folder': async () => pickDirectory($('#sync-folder')),
  'choose-backup-folder': async () => pickDirectory($('#backup-folder')),
  'pairing-key': async () => { const { key } = await api('pairingKey'); $('#sync-key').value = key; $('#sync-key').type = 'text'; toast('请通过独立安全方式在另一台设备填写此密钥'); },
  history: showHistory,
  resolve: resolveConflict,
  delete: async () => {
    if (!state.selected) return;
    if (await confirmBox('移入回收站', '<p>删除记录会同步到其他电脑，正文与历史仍可恢复。</p>', '移入回收站')) {
      state.selected = await api('delete', { id: state.selected.id, parents: state.selected.heads });
      const tab = currentTab(); if (tab) { tab.dirty = false; delete tab.draft; }
      await render();
    }
  },
  restore: async () => {
    const record = state.selected;
    state.selected = await api('restoreVersion', { id: record.id, revision: record.heads[0], parents: record.heads }); await render();
  },
  metadata: async () => {
    const record = state.selected;
    if (!record || record.deleted || record.conflict) return;
    await saveNote();
    const dialog = openModal('笔记属性', `<form id="metadata-form" class="settings-form"><label>知识领域<input name="domain" value="${esc(record.data.domain)}" required></label><label>标签（逗号分隔）<input name="tags" value="${esc(record.data.tags.join(', '))}"></label><label class="check-row"><input type="checkbox" name="sensitive" ${record.data.sensitive ? 'checked' : ''}>敏感内容，不交给云端 AI</label><button class="primary">保存属性</button></form>`);
    $('#metadata-form').onsubmit = e => { e.preventDefault(); run(async () => {
      const data = Object.fromEntries(new FormData(e.target));
      state.selected = await api('save', { id: state.selected.id, type: state.selected.type, parents: state.selected.heads,
        data: { ...state.selected.data, domain: data.domain, tags: data.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), sensitive: data.sensitive === 'on' } });
      const tab = currentTab(); if (tab) { tab.domain = data.domain; tab.draft = null; }
      state.domain = data.domain; dialog.close(); await render();
    }); };
  },
  annotate: async () => {
    const record = state.selected; if (!record) return;
    const quote = window.getSelection()?.toString() || '';
    const content = await inputBox('添加备注', '心得、疑问或实操记录', '', true);
    if (content?.trim()) { await api('save', { type: 'annotation', data: { title: `${record.data.title} · 备注`, domain: record.data.domain, noteId: record.id, quote, content, sensitive: record.data.sensitive } }); await render(); }
  },
  attach: async () => {
    if (!state.selected) return;
    await saveNote();
    const asset = await pickAttachment();
    if (asset) {
      state.selected = await api('save', { id: state.selected.id, type: state.selected.type, parents: state.selected.heads,
        data: { ...state.selected.data, assetIds: [...new Set([...(state.selected.data.assetIds || []), asset.id])] } });
      state.sourceVisible = true; await render();
    }
  },
  'asset-import': async () => { if (await pickAttachment()) { await render(); toast('原文件已导入本地'); } },
  'bind-asset': async target => { if (await pickAttachment(target.dataset.asset)) await render(); },
  'preview-asset': async target => previewAsset(target.dataset.asset),
  'pin-asset': async target => { await api('assetPin', { id: target.dataset.asset, pinned: target.dataset.pinned !== 'true' }); await render(); },
  export: async () => {
    if (!state.selected) return;
    if (state.selected.conflict) throw new Error('请先处理并发版本，再导出正文');
    if (currentTab()?.dirty) await saveNote();
    const record = state.selected, markdown = markdownConverter.turndown(safeHtml(record.data.content, record.data.format));
    const text = `# ${record.data.title}\n\n${markdown}\n\n---\n领域：${record.data.domain}\n标签：${record.data.tags.join(', ')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${record.data.title.replace(/[<>:"/\\|?*]/g, '_')}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  pdf: async () => {
    if (state.selected?.conflict) throw new Error('请先处理并发版本，再导出正文');
    if (native) await api('printPdf'); else window.print();
  },
  'new-chat': async () => { const tab = currentTab(); if (tab) { tab.conversationId = null; await persist(); await render(); } },
  'conversation-to-draft': async () => {
    const selection = window.getSelection()?.toString();
    const text = await inputBox('选择入库内容', '内容将进入待确认方案，不直接归档', selection || state.selected.data.messages?.at(-1)?.content || '', true);
    if (text?.trim()) {
      const proposal = await api('propose', { title: `${state.selected.data.title} · 入库方案`, domain: state.selected.data.domain,
        items: [{ title: state.selected.data.title, content: text, sensitive: state.selected.data.sensitive }] });
      await openRecord(proposal.id);
    }
  },
  'proposal-new': async () => {
    const content = await inputBox('新建待确认方案', '输入一项待整理内容（保留原文，不自动补充）', '', true);
    if (content?.trim()) { const proposal = await api('propose', { title: '待确认整理方案', domain: state.domain || 'AI', items: [{ title: content.split('\n')[0].slice(0, 50), content }] }); await openRecord(proposal.id); }
  },
  approve: async () => {
    const itemIds = $$('[data-proposal-item]:checked:not(:disabled)').map(el => el.dataset.proposalItem);
    if (!itemIds.length) throw new Error('请选择待确认的内容');
    state.selected = await api('approve', { id: state.selected.id, parents: state.selected.heads, itemIds }); await render(); toast('选定部分已入库，其余仍待确认');
  },
  'proposal-edit': async () => {
    const record = state.selected, selectedId = $('[data-proposal-item]:checked:not(:disabled)')?.dataset.proposalItem;
    const item = record.data.items.find(i => i.id === selectedId) || record.data.items.find(i => i.status !== 'accepted');
    if (!item) throw new Error('没有待修改的部分');
    const content = await inputBox('修改待确认内容', item.data.title, item.data.content, true);
    if (content === null) return;
    const items = record.data.items.map(i => i.id === item.id ? { ...i, data: { ...i.data, content } } : i);
    state.selected = await api('save', { id: record.id, type: 'proposal', parents: record.heads, data: { ...record.data, items } }); await render();
  },
  'publish-workspace': async () => {
    await persist();
    await api('workspacePublish', { tabs: state.tabs.map(({ draft, dirty, ...tab }) => tab), selectedTab: state.selectedTab });
    toast('工作区位置已生成共享版本；未保存正文不随此操作发布');
  },
  'adopt-workspace': async () => {
    const records = (await api('records', { type: 'workspace' })).filter(r => r.data.originDevice !== state.snapshot.deviceId);
    const dialog = openModal('接续其他电脑的工作区', records.length ? records.map(r => `<div class="workspace-option"><span><strong>${esc(r.data.title)}</strong><small>${r.data.tabs?.length || 0} 个标签 · ${formatTime(r.updatedAt)}</small></span><button class="secondary" data-adopt="${r.id}">添加到当前工作区</button></div>`).join('') : '<div class="section-empty">尚未收到其他电脑发布的工作区</div>');
    $$('[data-adopt]', dialog).forEach(button => button.onclick = () => run(async () => {
      const result = await api('workspaceAdopt', { id: button.dataset.adopt }); state.tabs = result.tabs; state.selectedTab = result.selectedTab;
      dialog.close(); await render();
    }));
  },
  'restore-backup': async () => { const directory = await pickDirectory(); if (directory) await restoreBackup(directory); },
  'restore-existing-backup': async target => restoreBackup(state.snapshot.backups[Number(target.dataset.index)].directory),
  'verify-backup': async target => { await api('backupVerify', { directory: state.snapshot.backups[Number(target.dataset.index)].directory }); toast('本地备份完整性校验通过；不代表网盘已上传'); },
  'continue-backup': async target => { const result = await api('backupContinue', { directory: state.snapshot.backups[Number(target.dataset.index)].directory }); await render(); toast(result.localComplete ? '本地备份附件已补全' : '仍有原文件在本机不可用'); },
  'provider-custom': async () => configureProvider(),
  'provider-config': async target => configureProvider(target.dataset.provider),
  'provider-test': async target => testProvider(target.dataset.provider),
  'model-new': async () => editModel(),
  'model-edit': async target => editModel(target.dataset.model),
  compare: compareModels
};
async function restoreBackup(directory) {
  if (await confirmBox('恢复独立备份', '<p>将校验所有已备份文件，并与当前知识库合并。现有内容不被直接覆盖；并发版本会提示处理。</p>', '校验并恢复')) {
    const result = await api('backupRestore', { directory }); await render(); toast(`已恢复 ${result.imported} 个版本，${result.unavailableAssets} 个原文件尚未备份`);
  }
}
async function run(fn) { try { await fn(); } catch (error) { console.error(error); toast(error.message, true); } }
document.addEventListener('click', event => {
  const external = event.target.closest('.document-content a,.chat-bubble a,.prose a');
  if (external) {
    event.preventDefault();
    run(async () => {
      const url = new URL(external.getAttribute('href'));
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('此链接类型不自动打开');
      if (native) await api('openExternal', { url: url.href });
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    });
    return;
  }
  const nav = event.target.closest('[data-nav]');
  if (nav) { run(async () => { await persist(); state.view = nav.dataset.nav; state.selected = null; state.query = ''; await render(); }); return; }
  const row = event.target.closest('[data-record]');
  if (row) { run(() => openRecord(row.dataset.record)); return; }
  const close = event.target.closest('[data-close-tab]');
  if (close) {
    run(async () => {
      const tab = state.tabs.find(t => t.id === close.dataset.closeTab);
      if (tab?.dirty && !(await confirmBox('关闭未保存标签', '<p>此标签含未保存修改。关闭将丢弃这部分编辑，已保存版本不受影响。</p>', '丢弃并关闭'))) return;
      state.tabs = state.tabs.filter(t => t.id !== close.dataset.closeTab);
      if (state.selectedTab === close.dataset.closeTab) {
        state.editor?.destroy(); state.editor = null;
        state.selectedTab = state.tabs.at(-1)?.id || null;
        state.selected = state.selectedTab ? await api('record', { id: currentTab().recordId }) : null;
      }
      await persist(); await render();
    }); return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) { const item = state.tabs.find(t => t.id === tab.dataset.tab); if (item) run(() => openRecord(item.recordId)); return; }
  const asset = event.target.closest('[data-preview-asset]');
  if (asset) { run(() => previewAsset(asset.dataset.previewAsset)); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.action;
  if (action.startsWith('fmt-') && state.editor) {
    const chain = state.editor.chain().focus();
    ({ 'fmt-bold': () => chain.toggleBold().run(), 'fmt-italic': () => chain.toggleItalic().run(),
      'fmt-heading': () => chain.toggleHeading({ level: 2 }).run(), 'fmt-list': () => chain.toggleBulletList().run(),
      'fmt-ordered': () => chain.toggleOrderedList().run(), 'fmt-quote': () => chain.toggleBlockquote().run(),
      'fmt-code': () => chain.toggleCodeBlock().run(), 'fmt-table': () => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      'fmt-undo': () => chain.undo().run(), 'fmt-redo': () => chain.redo().run() })[action]?.();
    return;
  }
  if (actions[action]) run(() => actions[action](target));
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(saveNote); }
});
window.addEventListener('beforeunload', event => {
  if (state.tabs.some(t => t.dirty)) { event.preventDefault(); event.returnValue = ''; }
});
async function init() {
  await loadState();
  state.tabs = state.snapshot.workspace.tabs || []; state.selectedTab = state.snapshot.workspace.selectedTab;
  const tab = currentTab();
  if (tab) { state.selected = await api('record', { id: tab.recordId }); state.domain = tab.domain || ''; }
  await render();
  refreshTimer = setInterval(async () => {
    try {
      const snapshot = await api('state'); state.snapshot = snapshot;
      if (state.view === 'sync' && !$('#sync-folder')?.matches(':focus') && !$('#sync-key')?.matches(':focus')) {
        // Preserve unsaved configuration fields rather than replacing the form during polling.
        const footer = $('.statusbar');
        if (footer) footer.innerHTML = `<span>${icon('hard-drive')}本地保存</span><span>${snapshot.unexported} 条待生成传输记录</span><span>${snapshot.pendingParents} 条等待前置版本</span><span class="status-right">云端上传状态：未核验</span>`;
        redrawIcons();
      }
    } catch {}
  }, 15000);
}
run(init);
