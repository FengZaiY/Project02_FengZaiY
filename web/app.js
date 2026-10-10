import { createIcons, icons } from 'lucide';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit, createTable } from '@tiptap/extension-table';
import { downloadSkill } from './skill-export.js';
import { createSyncUI } from './sync-pages.js';
import { cleanNoteHtml, richExtensions, hydrateRich, editRichBlock, addRichMarkdownRules, diagramTemplates } from './rich-editor.js';
import { parseNoteLink, safeNoteLink, encodeBlock } from '../src/core/rich-schema.mjs';
import { createNoteAutosave } from './note-autosave.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<i data-lucide="${name}"></i>`;
const button = (name, action, title, extra = '') => `<button class="icon-button" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon(name)}</button>`;
const uid = () => crypto.randomUUID();
const markdownConverter = new TurndownService({ headingStyle: 'atx' });
markdownConverter.use(gfm);
addRichMarkdownRules(markdownConverter);
const token = $('meta[name=local-token]').content;
const native = !!window.desktop;
const mediaUrl = id => native ? `studyself-media://asset/${id}` : `/media/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
const api = async (method, input = {}) => {
  if (native) return window.desktop.call(method, input);
  const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StudySelf-Token': token }, body: JSON.stringify({ method, input }) });
  const result = await response.json();
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
};
const formatTime = time => time ? new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无记录';
const bytes = size => size > 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : size > 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil((size || 0) / 1024)} KB`;
const label = { local: '已本地保存', waiting: '已生成交接文件', received: '已接收版本' };
const typeLabel = { note: '正式笔记', draft: '草稿', conversation: '对话', source: '来源', annotation: '备注', proposal: '整理方案', workspace: '工作区', asset: '附件', model: '模型', task: '任务', usage: '用量', library: '知识库' };
const navs = [
  ['notes', 'library', '知识库'], ['drafts', 'inbox', '收集与草稿'], ['proposals', 'list-checks', '整理方案'],
  ['assets', 'paperclip', '资料与附件'],
  ['conflicts', 'git-merge', '版本冲突'], ['trash', 'trash-2', '回收站'],
  ['libraries', 'folders', '知识库管理'], ['agents', 'plug', '外部 Agent'], ['sync', 'refresh-cw', '多电脑同步'], ['devices', 'monitor-cog', '设备管理'],
  ['settings', 'settings', '系统设置']
];
const libraryViews = ['notes', 'drafts', 'conflicts', 'trash', 'proposals'];
const GLOBAL_SCOPE = '__all_libraries__';
const state = { view: 'notes', domain: '', query: '', snapshot: null, rows: [], tabs: [], selectedTab: null,
  selected: null, editor: null, sourceVisible: false, listLimit: 150 };
let persistTimer, queryTimer, refreshTimer, modalCleanup;
let persistQueue = Promise.resolve(), importingFiles = 0;
const noteSaver = createNoteAutosave({
  capture: id => {
    const tab = state.tabs.find(item => item.id === id);
    if (tab === currentTab()) stash();
    return tab?.dirty && tab.draft ? { id: tab.recordId, type: tab.recordType || 'note',
      data: { ...tab.draft, title: tab.draft.title.trim() || '未命名笔记' }, parents: [...(tab.baseHeads || [])] } : null;
  },
  write: async (input, manual) => {
    try { return await api('save', input); }
    catch (error) {
      if (!manual || error.code !== 'CONFLICT') throw error;
      if (!await confirmBox('保存期间出现新版本', '<p>其他修改已到达。当前编辑已保留，可以保存为独立并发版本，再对照融合。</p>', '保留为并发版本')) throw error;
      return api('saveBranch', input);
    }
  },
  apply: (id, saved, unchanged) => {
    const tab = state.tabs.find(item => item.id === id); if (!tab) return;
    if (tab === currentTab()) stash();
    if (state.selected?.id === saved.id) state.selected = saved;
    tab.title = unchanged ? saved.data.title : tab.draft.title;
    tab.domain = saved.data.domain;
    if (unchanged) { tab.dirty = false; delete tab.draft; delete tab.baseHeads; }
    else { tab.baseHeads = [...saved.heads]; }
    void persist().catch(error => toast(`正文已保存，工作区位置保存失败：${error.message}`, true));
    const row = state.rows.find(item => item.id === saved.id);
    if (row) {
      Object.assign(row, saved);
      const element = $(`[data-record="${saved.id}"]`);
      if (element) {
        $('strong', element).textContent = saved.data.title;
        $('p', element).textContent = excerpt(saved);
        $('time', element).textContent = formatTime(saved.updatedAt);
      }
    }
  },
  status: (id, value, error) => {
    updateSaveStatus();
    if (error) toast(value === 'conflict' ? '出现新版本，自动保存已暂停；当前编辑仍保留，请点击保存处理' : `自动保存未完成：${error.message}。当前编辑已保留，可点击保存重试`, true);
  }
});
const syncUI = createSyncUI({ api, esc, icon, formatTime, bytes, render, toast, confirmBox, persist });
function toast(message, error = false) {
  const element = $('#toast'); element.textContent = message; element.className = `show ${error ? 'error' : ''}`;
  clearTimeout(element.timer); element.timer = setTimeout(() => element.className = '', 5000);
}
function safeHtml(text, format) {
  return cleanNoteHtml(format === 'html' ? text || '' : marked.parse(text || ''));
}
function excerpt(record) {
  const html = safeHtml(record.data.content || '', record.data.format);
  const temp = document.createElement('div'); temp.innerHTML = html;
  return temp.textContent.slice(0, 85) || (record.type === 'conversation' ? record.data.messages?.at(-1)?.content?.slice(0, 85) : '') || '暂无正文';
}
function redrawIcons() { createIcons({ icons, attrs: { 'stroke-width': 1.7 } }); }
function currentTab() { return state.tabs.find(t => t.id === state.selectedTab); }
function libraries() { return state.snapshot?.libraries || []; }
function activeLibraries() { return libraries().filter(item => !item.deleted || item.contentCount > 0); }
function libraryName(domain) { return domain === GLOBAL_SCOPE ? '不限定知识库' : libraries().find(item => item.data.domain === domain)?.data.title || domain || '全部知识库'; }
function requireLibrary() {
  const library = libraries().find(item => item.data.domain === state.domain);
  if (!library) throw new Error('请先创建并选择知识库');
  if (library.deleted || library.conflict) throw new Error('请先在知识库管理中恢复知识库或处理名称冲突');
  return library;
}
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
  const snapshot = JSON.parse(JSON.stringify({ tabs: state.tabs, selectedTab: state.selectedTab, domain: state.domain }));
  persistQueue = persistQueue.catch(() => {}).then(() => api('workspaceSave', snapshot));
  await persistQueue;
}
function updateSaveStatus() {
  const tab = currentTab(); if (!tab) return;
  const value = noteSaver.state(tab.id);
  const text = ({ saved: tab.dirty ? '待保存' : '已保存', queued: '待保存', saving: '保存中…', error: '保存失败', conflict: '待处理冲突' })[value];
  const control = $('[data-action="save"]'), badge = $('#save-state');
  if (control) {
    control.dataset.status = value;
    control.setAttribute('aria-label', `保存：${text}`);
    control.title = value === 'saved' ? '保存笔记' : value === 'conflict' ? '保留当前编辑并处理版本冲突' : '立即保存或重试';
    control.disabled = value === 'saving';
    $('span', control).textContent = text;
  }
  if (badge) badge.textContent = ['saved', 'conflict'].includes(value) && !tab.dirty ? '已本地保存' : text;
  for (const item of state.tabs) {
    const title = $(`.work-tab[data-tab="${item.id}"]>span`);
    if (title) title.textContent = `${item.title}${item.dirty ? ' ·' : ''}`;
  }
}
function changed() {
  const tab = currentTab(); if (!tab) return;
  if (!tab.dirty) tab.baseHeads = [...state.selected.heads];
  tab.recordType = state.selected.type;
  tab.dirty = true;
  stash();
  noteSaver.changed(tab.id);
  clearTimeout(persistTimer); persistTimer = setTimeout(() => persist().catch(error => toast(error.message, true)), 500);
}
async function loadState() {
  state.snapshot = await api('state');
}
async function restoreWorkspaceTabs(workspace) {
  const tabs = workspace.tabs || [];
  const records = await Promise.all(tabs.map(tab => tab.recordId ? api('record', { id: tab.recordId }) : null));
  // Keep unresolved references and unsaved note drafts; only retire known conversation tabs.
  state.tabs = tabs.filter((tab, index) => records[index]?.type !== 'conversation');
  state.tabs.forEach(tab => { tab.recordType = records[tabs.indexOf(tab)]?.type || tab.recordType || 'note'; });
  state.selectedTab = state.tabs.some(tab => tab.id === workspace.selectedTab) ? workspace.selectedTab : null;
}
async function refreshRows() {
  const type = ({ notes: 'note', drafts: 'draft', proposals: 'proposal' })[state.view];
  state.rows = await api('records', { type, domain: state.domain || undefined, query: state.query || undefined,
    trash: state.view === 'trash', limit: state.listLimit, preview: true });
  if (state.view === 'conflicts') state.rows = state.rows.filter(row => row.conflict);
}
function domainOptions(selected = '', all = true) {
  return `<option value="">${all ? '全部知识库' : '选择知识库'}</option>${activeLibraries().map(item => `<option value="${esc(item.data.domain)}" ${selected === item.data.domain ? 'selected' : ''}>${esc(item.data.title)}${item.deleted ? '（待恢复）' : ''}${item.conflict ? '（冲突）' : ''}</option>`).join('')}`;
}
function countFor(view) {
  if (view === 'conflicts') return state.snapshot.conflicts;
  if (view === 'trash') return state.snapshot.trash;
  return state.snapshot.counts[({ notes: 'note', drafts: 'draft', proposals: 'proposal', assets: 'asset' })[view]] || 0;
}
function shell() {
  const active = navs.find(n => n[0] === state.view);
  $('#app').innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="#" data-action="home"><span class="brand-mark">${icon('notebook-pen')}</span><span>StudySelf<small>个人知识工作区</small></span></a>
      <button class="new-note primary" data-action="new">${icon('plus')}新建笔记</button>
      <nav>${navs.map(([id, i, text]) => `${id === 'libraries' ? '<div class="nav-divider">工作区管理</div>' : ''}<button class="nav-item ${state.view === id ? 'active' : ''}" data-nav="${id}" title="${esc(text)}" aria-label="${esc(text)}">${icon(i)}<span>${text}</span>${countFor(id) ? `<b>${countFor(id)}</b>` : ''}</button>`).join('')}</nav>
      <div class="device"><span class="device-icon">${icon('monitor')}</span><div><strong>${esc(state.snapshot.deviceName)}</strong><small>本地工作区 · v${state.snapshot.version}</small></div>${button('settings-2', 'device-name', '设备名称')}</div>
      <button class="sidebar-status" data-nav="sync"><span class="status-dot ${state.snapshot.sync.configured ? '' : 'amber'}"></span>${state.snapshot.sync.configured ? '同步目录已配置' : '同步尚未配置'}${icon('chevron-right')}</button>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb">${icon(active[1])}<strong>${active[2]}</strong><span>/</span><select id="domain-filter" aria-label="选择知识库">${domainOptions(state.domain)}</select>${button('folder-plus', 'library-new', '新建知识库')}</div>
        <div class="top-actions"><label class="search">${icon('search')}<input id="search" placeholder="搜索当前范围" value="${esc(state.query)}" aria-label="搜索笔记"></label>${button('refresh-cw', 'refresh-view', '刷新内容')}${button('cloud-download', 'sync-now', '检查已下载更新')}</div>
      </header>
      <div class="work-tabs">${state.tabs.map(tab => `<div class="work-tab ${tab.id === state.selectedTab ? 'selected' : ''}" data-tab="${tab.id}" title="${esc(libraryName(tab.domain))} / ${esc(tab.title)}">${icon('file-text')}<span>${esc(tab.title)}${tab.dirty ? ' ·' : ''}</span><small>${esc(libraryName(tab.domain))}</small><button data-close-tab="${tab.id}" aria-label="关闭标签">${icon('x')}</button></div>`).join('')}<button class="tab-add" data-action="new" title="新建笔记" aria-label="新建笔记">${icon('plus')}</button><div class="tab-spacer"></div>${button('upload', 'publish-workspace', '发布当前工作区')}${button('panels-top-left', 'adopt-workspace', '接续其他电脑的工作区')}</div>
      <main id="main"></main>
      <footer class="statusbar"><span>${icon('hard-drive')}本地保存</span><span>修改历史自动保留</span><span class="status-right">云端上传状态：由客户端确认</span></footer>
    </div>`;
  $('#domain-filter').addEventListener('change', e => run(() => selectLibrary(e.target.value)));
  $('#search').addEventListener('input', e => {
    state.query = e.target.value;
    clearTimeout(queryTimer); queryTimer = setTimeout(async () => { await refreshRows(); await renderView(); }, 200);
  });
}
async function render() {
  if (importingFiles) return;
  stash(); state.editor?.destroy(); state.editor = null;
  await loadState(); await refreshRows(); shell(); await renderView(); redrawIcons();
}
async function renderView() {
  if (importingFiles) return;
  stash(); state.editor?.destroy(); state.editor = null;
  if (libraryViews.includes(state.view)) await renderLibrary();
  else if (state.view === 'libraries') renderLibraries();
  else if (state.view === 'sync') await renderSync();
  else if (state.view === 'devices') await syncUI.renderDevices();
  else if (state.view === 'agents') await renderAgents();
  else if (state.view === 'settings') await renderSettings();
  else if (state.view === 'assets') await renderAssets();
  redrawIcons();
}
async function renderLibrary() {
  const title = state.view === 'notes' ? libraryName(state.domain) : `${libraryName(state.domain)} · ${navs.find(n => n[0] === state.view)[2]}`;
  $('#main').className = 'library-layout';
  $('#main').innerHTML = `<section class="record-list"><div class="list-heading"><strong title="${esc(title)}">${esc(title)}</strong><span>${state.rows.length}</span>${button('plus', state.view === 'proposals' ? 'proposal-new' : 'new', '新建')}</div>
    <div class="list-rows">${state.rows.length ? state.rows.map(row => `<button class="record-row ${state.selected?.id === row.id ? 'selected' : ''}" data-record="${row.id}">
    <div class="row-kicker"><span>${esc(libraryName(row.data.domain))}</span><time>${formatTime(row.updatedAt)}</time></div><strong>${row.conflict ? icon('git-merge') : ''}${esc(row.data.title)}</strong>
    <p>${esc(excerpt(row))}</p><div class="row-tags">${(row.data.tags || []).slice(0, 2).map(tag => `<span>${esc(tag)}</span>`).join('')}<small class="delivery ${row.status}">${label[row.status]}</small></div></button>`).join('') : '<div class="list-empty">暂无内容</div>'}${state.rows.length >= state.listLimit ? '<button class="text-button load-more" data-action="load-more">加载更多</button>' : ''}</div></section>
    <section class="document-area" id="document-area"></section>`;
  if (state.selected && (!state.domain || state.selected.data.domain === state.domain)) {
    const latest = await api('record', { id: state.selected.id });
    if (latest) { state.selected = latest; await renderDocument(latest); return; }
  }
  const hasLibraries = activeLibraries().length > 0;
  $('#document-area').innerHTML = `<div class="reading-layout"><div class="empty-state">${icon(hasLibraries ? 'notebook-pen' : 'folders')}<h2>${!hasLibraries ? '尚无知识库' : state.view === 'trash' ? '回收站' : state.domain ? esc(libraryName(state.domain)) : '全部知识库'}</h2><button class="primary" data-action="${hasLibraries && state.domain ? 'new' : 'library-new'}">${icon('plus')}${hasLibraries && state.domain ? '新建笔记' : '新建知识库'}</button></div></div>`;
}
async function renderDocument(record) {
  const tab = currentTab();
  const data = tab?.recordId === record.id && tab.draft ? tab.draft : record.data;
  const editable = ['note', 'draft', 'source', 'annotation'].includes(record.type) && !record.deleted && !record.conflict;
  $('#document-area').innerHTML = `
    <div class="document-top"><span class="document-type">${icon(record.type === 'conversation' ? 'messages-square' : 'file-text')}${typeLabel[record.type] || record.type}</span><span id="save-state" class="muted">${tab?.dirty ? '尚未保存' : label[record.status]}</span>
      <div class="document-actions">${button('panel-left-open', 'toggle-source', '原资料')}${button('history', 'history', '历史版本')}${button('message-square-plus', 'annotate', '添加备注')}${button('download', 'export', '导出 Markdown')}${button('printer', 'pdf', '导出 PDF')}${button('trash-2', 'delete', '移入回收站')}${editable || tab?.dirty ? `<button class="primary compact save-status-button" data-action="save" aria-live="polite">${icon('save')}<span>已保存</span></button>` : ''}</div></div>
    ${record.conflict ? `<div class="notice amber">${icon('git-merge')}存在 ${record.versions.length} 个并发版本，未自动覆盖。<button data-action="resolve">对照处理</button></div>` : ''}
    ${record.deleted ? `<div class="notice amber">${icon('trash-2')}此内容已进入回收站。<button data-action="restore">恢复内容</button></div>` : ''}
    <div class="reading-layout ${state.sourceVisible ? 'with-source' : ''}">
      ${state.sourceVisible ? '<aside class="source-pane" id="source-pane"></aside>' : ''}
      <article class="editor-panel">
        <div class="document-heading"><div class="document-breadcrumb">${esc(libraryName(data.domain))}<span>/</span>${typeLabel[record.type] || '知识'}</div>
          ${editable ? `<input id="note-title" class="note-title" value="${esc(data.title)}" aria-label="笔记标题">` : `<h1>${esc(data.title)}</h1>`}
          <div class="note-meta"><button data-action="metadata" class="metadata-button">${icon('tags')}${data.tags?.length ? data.tags.map(esc).join(' · ') : '标签与知识库'}</button>${data.sensitive ? `<span class="sensitive">${icon('shield-check')}敏感资料</span>` : ''}<time>${formatTime(record.updatedAt)}</time></div>
          ${record.type === 'source' && data.url ? `<div class="source-url"><a href="${esc(data.url)}">${icon('external-link')}${esc(data.url)}</a></div>` : ''}
        </div>
        ${editable ? `<div class="editor-toolbar" role="toolbar" aria-label="笔记编辑工具"><select id="heading-level" aria-label="标题级别"><option value="0">正文</option>${[1, 2, 3, 4, 5, 6].map(level => `<option value="${level}">标题 ${level}</option>`).join('')}</select>${button('bold', 'fmt-bold', '加粗')}${button('italic', 'fmt-italic', '斜体')}${button('highlighter', 'fmt-highlight', '文字高亮')}${button('list', 'fmt-list', '无序列表')}${button('list-ordered', 'fmt-ordered', '有序列表')}${button('list-checks', 'fmt-task', '任务列表')}${button('quote', 'fmt-quote', '引用')}${button('code-2', 'fmt-code', '代码块')}${button('link', 'note-link', '插入或修改链接')}<select id="insert-content" aria-label="插入内容"><option value="">插入内容</option><option value="image">图片</option><option value="video">视频</option><option value="table">表格</option><option value="callout">高亮块</option><option value="sticker">贴纸</option><option value="formula">数学公式</option>${Object.entries(diagramTemplates).map(([id, [name]]) => `<option value="diagram:${id}">${name}</option>`).join('')}<option value="canvas">无限画板</option></select><select id="table-action" aria-label="表格操作"><option value="">表格操作</option><option value="addRowAfter">插入行</option><option value="addColumnAfter">插入列</option><option value="deleteRow">删除行</option><option value="deleteColumn">删除列</option><option value="mergeCells">合并单元格</option><option value="splitCell">拆分单元格</option><option value="toggleHeaderRow">切换表头</option><option value="deleteTable">删除表格</option></select><span class="toolbar-divider"></span>${button('undo-2', 'fmt-undo', '撤销')}${button('redo-2', 'fmt-redo', '重做')}${button('paperclip', 'attach', '关联附件')}</div>` : ''}
        <div class="editor-scroll"><div id="editor-content" class="document-content"></div><div id="annotations"></div></div>
      </article>
    </div>`;
  if (editable) {
    state.editor = new Editor({
      element: $('#editor-content'), extensions: [StarterKit.configure({ link: { openOnClick: false, protocols: ['studyself'], isAllowedUri: safeNoteLink } }), TableKit.configure({ table: { resizable: true } }), ...richExtensions({ mediaUrl, edit: editBlock })],
      content: safeHtml(data.content || '', data.format), editorProps: { attributes: { 'aria-label': '笔记正文', role: 'textbox', 'aria-multiline': 'true' } },
      onUpdate: changed,
      onSelectionUpdate: ({ editor }) => { if ($('#heading-level')) $('#heading-level').value = String(editor.getAttributes('heading').level || 0); if ($('#table-action')) $('#table-action').disabled = !editor.isActive('table'); }
    });
    bindFileDrop(state.editor, tab, record);
    updateSaveStatus();
    $('#note-title').addEventListener('input', changed);
    $('#heading-level').onchange = event => { const chain = state.editor.chain().focus(); const level = Number(event.target.value); if (level) chain.setHeading({ level }).run(); else chain.setParagraph().run(); };
    $('#insert-content').onchange = event => { const value = event.target.value; event.target.value = ''; run(() => insertContent(value)); };
    $('#table-action').disabled = true;
    $('#table-action').onchange = event => { const command = event.target.value; event.target.value = ''; if (command) state.editor.chain().focus()[command]().run(); };
    $('.editor-scroll').addEventListener('scroll', () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => persist().catch(() => {}), 500); });
    $('.editor-scroll').scrollTop = tab?.scroll || 0;
  } else if (record.type === 'conversation') {
    $('#editor-content').innerHTML = '<p class="muted">此功能已停用，原始记录仍保留在历史版本与独立备份中。</p>';
  } else if (record.type === 'proposal') {
    $('#editor-content').innerHTML = `${data.content ? `<section class="proposal-summary prose">${safeHtml(data.content)}</section>` : ''}<div class="proposal-items">${data.items.map(item => `<section class="proposal-item"><label class="check-row"><input type="checkbox" data-proposal-item="${item.id}" ${item.status === 'accepted' ? 'disabled checked' : ''}><strong>${esc(item.data.title)}</strong><span class="pill ${item.status === 'accepted' ? 'green' : ''}">${item.status === 'accepted' ? '已确认' : '待确认'}</span></label><div class="proposal-destination">${icon('folder')}目标：${esc(libraryName(item.data.domain))}<span>出处 ${item.data.sourceIds?.length || 0} · 附件 ${item.data.assetIds?.length || 0}</span></div><div class="prose">${safeHtml(item.data.content, item.data.format)}</div></section>`).join('')}</div><div class="sticky-actions"><button class="primary" data-action="approve">确认选中部分</button><button class="secondary" data-action="proposal-edit">修改待确认部分</button></div>`;
    $$('.proposal-item').forEach((element, index) => {
      const item = data.items[index];
      $('.proposal-destination', element).insertAdjacentHTML('afterend', item.parents?.length
        ? `<div class="proposal-operation">合并更新已有笔记（保留历史）<button class="text-button" data-record="${esc(item.targetId)}">${icon('file-search')}查看原笔记</button></div>`
        : '<div class="proposal-operation muted">新建笔记</div>');
    });
  } else $('#editor-content').innerHTML = safeHtml(data.content || '', data.format);
  if (['note', 'draft', 'source'].includes(record.type)) {
    const annotations = (await api('records', { type: 'annotation' })).filter(item => item.data.noteId === record.id);
    $('#annotations').innerHTML = annotations.length ? `<h3>备注 <small>${annotations.length}</small></h3>${annotations.map(item => `<div class="annotation">${item.data.quote ? `<blockquote>${esc(item.data.quote)}</blockquote>` : ''}<div>${esc(item.data.content)}</div><small>${formatTime(item.updatedAt)}</small></div>`).join('')}` : '';
  }
  hydrateRich($('#document-area'), mediaUrl);
  if (state.sourceVisible) await renderSources(record);
}
async function renderSources(record) {
  const assets = await api('assets');
  const bodies = [record.data, ...(record.type === 'proposal' ? record.data.items.map(item => item.data) : [])];
  const assetIds = new Set(bodies.flatMap(data => data.assetIds || []));
  const sourceIds = [...new Set(bodies.flatMap(data => data.sourceIds || []))];
  const linked = assets.filter(a => assetIds.has(a.id));
  const sources = (await Promise.all(sourceIds.map(id => api('record', { id })))).filter(Boolean);
  $('#source-pane').innerHTML = `<div class="panel-heading">${icon('files')}原资料${['note', 'draft', 'source'].includes(record.type) && !record.deleted && !record.conflict ? button('paperclip', 'attach', '添加附件') : ''}</div>
    <div class="source-list">${linked.map(a => `<button class="source-item" data-preview-asset="${a.id}">${icon(a.data.mime.startsWith('image/') ? 'image' : 'file-text')}<span>${esc(a.data.title)}<small>${a.available ? bytes(a.data.size) : '本机尚未下载'}</small></span></button>`).join('')}${sources.map(s => `<button class="source-item" data-record="${s.id}">${icon('link')}<span>${esc(s.data.title)}</span></button>`).join('')}</div><div id="source-preview" class="source-preview">${!linked.length && !sources.length ? '<span class="muted">尚未关联原资料</span>' : ''}</div>`;
}
async function selectLibrary(domain, open = false) {
  if (importingFiles) { $('#domain-filter').value = state.domain; toast('文件仍在导入，请完成后切换知识库'); return; }
  await persist();
  state.editor?.destroy(); state.editor = null;
  state.domain = domain; state.selected = null; state.selectedTab = null;
  state.sourceVisible = false; state.query = '';
  if (open) state.view = 'notes';
  await persist(); await render();
}
function renderLibraries() {
  $('#main').className = 'settings-view';
  const items = libraries();
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">我的资料空间</div><h1>知识库管理</h1></div><button class="primary" data-action="library-new">${icon('folder-plus')}新建知识库</button></div>
    ${items.length ? `<div class="table-scroll"><table class="data-table library-table"><thead><tr><th>名称与说明</th><th>资料</th><th>状态</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr data-library="${item.id}"><td><strong>${esc(item.data.title)}</strong><small>${esc(item.data.description || '')}</small>${item.conflict ? `<small class="conflict-names">${item.versions.map(version => esc(version.data.title)).join(' / ')}</small>` : ''}</td><td>${item.activeCount}<small>${item.contentCount - item.activeCount} 项在回收站</small></td><td><span class="pill ${item.deleted || item.conflict ? 'amber' : 'green'}">${item.conflict ? '存在并发版本' : item.deleted ? '已删除' : item.legacy ? '已有资料' : '可用'}</span></td><td><div class="inline-actions">${!item.deleted || item.contentCount ? button('folder-open', 'library-open', '打开知识库', `data-library="${item.id}"`) : ''}${!item.deleted ? button('pencil', 'library-edit', item.conflict ? '处理知识库冲突' : '编辑知识库', `data-library="${item.id}"`) : ''}${item.deleted ? button('archive-restore', 'library-restore', '恢复知识库', `data-library="${item.id}"`) : button('trash-2', 'library-delete', item.contentCount ? '请先迁移资料（含回收站），不能删除非空知识库' : '删除空知识库', `data-library="${item.id}" ${item.contentCount ? 'disabled' : ''}`)}</div></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state">${icon('folders')}<h2>尚无知识库</h2><button class="primary" data-action="library-new">${icon('plus')}新建知识库</button></div>`}`;
  for (const item of items) {
    const folder = document.createElement('div'); folder.className = 'library-directory';
    folder.innerHTML = item.directoryError ? `<span class="directory-error">${esc(item.directoryError)}</span>${button('refresh-cw', 'library-folder-retry', '重试知识库文件夹', `data-library="${item.id}"`)}` : `<code class="storage-path">${esc(item.localDirectory || '')}</code>${button('copy', 'library-folder-copy', '复制知识库文件夹路径', `data-library="${item.id}"`)}${native ? button('folder-open', 'library-folder-open', '在文件管理器中打开知识库文件夹', `data-library="${item.id}"`) : ''}`;
    $(`[data-library="${item.id}"] td`).append(folder);
  }
}
async function editLibrary(id) {
  const item = id ? libraries().find(library => library.id === id) : null;
  if (id && !item) throw new Error('知识库不存在，请刷新');
  const dialog = openModal(item ? '编辑知识库' : '新建知识库', `<form id="library-form" class="settings-form">
    ${item?.conflict ? `<div class="notice amber">并发版本：${item.versions.map(version => esc(version.data.title)).join(' / ')}。保存将形成新的合并版本，原版本保留在历史中。</div>` : ''}
    <label>名称<input name="title" maxlength="100" value="${esc(item?.data.title || '')}" required autocomplete="off"></label>
    <label>${item ? '知识库文件夹' : '系统工作目录（根目录）'}<input id="library-folder" readonly value="${esc(item ? item.localDirectory || '目录暂不可用' : state.snapshot.localDataDirectory)}"></label>
    <label>说明<textarea name="description" rows="3" maxlength="2000">${esc(item?.data.description || '')}</textarea></label>
    <button class="primary" type="submit">${item ? '保存修改' : '创建知识库'}</button></form>`);
  $('#library-form').onsubmit = event => {
    event.preventDefault();
    const submit = event.target.querySelector('button[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const values = Object.fromEntries(new FormData(event.target));
        const saved = await api('librarySave', { ...values, id: item?.id, parents: item?.heads || [] });
        dialog.close();
        if (item) { await render(); toast('知识库已更新'); }
        else { await selectLibrary(saved.data.domain, true); toast('知识库已创建'); }
      } finally { submit.disabled = false; }
    });
  };
  $('#library-form input[name=title]').focus();
}
async function renderSync() {
  const { sync } = state.snapshot;
  const { completeness } = await api('deviceStatus');
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><h1>多电脑同步</h1><button class="secondary" data-action="sync-scan">${icon('search')}检查已下载更新</button></div>
    <div class="definition-list" id="sync-content-policy"><div><span>同步范围</span><strong>笔记、修改历史、信息、资料、素材及已导入文件</strong></div><div><span>原文件传输</span><strong>大文件分块 · 组装断点续传 · 校验后本地保存</strong></div><div><span>本机原文件完整性</span><strong id="sync-file-completeness">${completeness ? `${completeness.available} / ${completeness.total} 已就绪${completeness.missing ? ` · ${completeness.missing} 个缺失或待接收` : ''} · 截至 ${formatTime(completeness.at)}` : '尚未检查'}</strong></div><div><span>传输目录清理</span><strong>不自动删除；仅释放本地副本须在客户端操作</strong></div></div>
    <section class="settings-section"><h2>传输目录与配对</h2><form id="sync-form" class="settings-form"><label>百度网盘专用同步目录<div class="input-with-action"><input id="sync-folder" value="${esc(sync.folder)}" placeholder="选择同步空间中的专用文件夹" required>${button('folder-open', 'choose-sync-folder', '选择同步文件夹')}</div></label>
      <label>设备配对密钥<div class="input-with-action"><input id="sync-key" type="password" autocomplete="off" placeholder="${sync.configured ? '保持为空则沿用当前密钥' : '两台电脑填写同一配对密钥'}">${button('key-round', 'pairing-key', '生成或查看配对密钥')}</div></label>
      <div class="form-actions"><span class="muted">配对指纹：${esc(sync.channel || '尚未配置')}<br>配对密钥不随知识库同步，请单独妥善保存。</span><button class="primary" type="submit">保存配置</button></div></form></section>
    <section class="settings-section"><h2>最近一次本地同步检查</h2>${sync.lastReport ? `<div class="definition-list"><div><span>检查时间</span><strong>${formatTime(sync.lastReport.finishedAt)}</strong></div><div><span>本地发现发布清单</span><strong>${sync.lastReport.availablePublications || 0}</strong></div><div><span>云端上传状态</span><strong>无法直接核验</strong></div></div>${(sync.lastReport.errors || []).map(error => `<div class="notice danger">${icon('triangle-alert')}<div>${esc(error.file || '')}<br>${esc(error.message)}</div></div>`).join('')}` : '<div class="section-empty">尚未执行同步检查</div>'}</section>`;
  $('#sync-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
    let key = $('#sync-key').value.trim();
    if (!key && sync.configured) key = (await api('pairingKey')).key;
    await api('syncConfigure', { folder: $('#sync-folder').value.trim(), key }); await render(); toast('同步配置已保存');
  }); });
  await syncUI.renderPanel();
}
async function renderAgents() {
  const access = await api('agentStatus');
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">本机授权 · HTTP API v1</div><h1>外部 Agent</h1></div></div>
    <section class="settings-section"><h2>连接</h2><label class="check-row"><input id="agent-enabled" type="checkbox" ${access.enabled || access.requestedEnabled ? 'checked' : ''}>允许本机外部 Agent 访问</label>
      <div class="definition-list"><div><span>接口地址</span><code id="agent-url">${esc(access.url || '未开启')}</code></div><div><span>网络范围</span><strong>仅 127.0.0.1</strong></div></div>
      ${access.error ? `<div class="notice danger">${esc(access.error)}</div>` : ''}
      <div class="notice amber">${icon('shield-alert')}凭证可访问所选资料，请仅交给可信 Agent。模型调用和费用由外部 Agent 管理。</div></section>
    <section class="settings-section"><h2>新建授权</h2><form id="agent-grant-form" class="settings-form"><div class="form-grid"><label>Agent 名称<input name="name" maxlength="100" required></label><label>有效天数<input name="days" type="number" value="30" min="1" max="365" required></label></div>
      <fieldset class="agent-scopes"><legend>可访问的知识库</legend>${activeLibraries().filter(item => !item.deleted && !item.conflict).map(item => `<label class="check-row"><input name="domains" type="checkbox" value="${esc(item.data.domain)}">${esc(item.data.title)}</label>`).join('') || '<span class="muted">尚无可授权知识库</span>'}</fieldset>
      <div class="muted">基础权限：读取、收集、提交待确认方案。确认入库由你完成。</div>
      <details><summary>额外权限</summary><label class="check-row"><input type="checkbox" name="edit">直接修改正式笔记与创建关联</label><label class="check-row"><input type="checkbox" name="trash">移入回收站</label><label class="check-row"><input type="checkbox" name="sensitive">读取和处理敏感资料（含引用）</label></details>
      <button class="primary" type="submit">${icon('key-round')}生成访问凭证</button></form></section>
    <section class="settings-section"><h2>已授权 Agent</h2>${access.grants.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>名称 / 有效期</th><th>知识库</th><th>权限 / 状态</th><th></th></tr></thead><tbody>${access.grants.map(grant => `<tr><td><strong>${esc(grant.name)}</strong><small>${formatTime(grant.expiresAt)}</small></td><td>${grant.domains.map(domain => esc(libraryName(domain))).join('、')}</td><td>${grant.revoked ? '已撤销' : Date.parse(grant.expiresAt) <= Date.now() ? '已到期' : '有效'}<small>${grant.permissions.includes('edit') ? '直接修改 · ' : ''}${grant.permissions.includes('trash') ? '回收站 · ' : ''}${grant.sensitive ? '含敏感资料' : '不含敏感资料'}</small></td><td>${!grant.revoked ? button('key-round', 'agent-revoke', '撤销授权', `data-grant="${grant.id}"`) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="section-empty">尚无授权</div>'}</section>
    <section class="settings-section"><h2>最近访问</h2>${access.audit.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>时间</th><th>Agent</th><th>操作</th><th>结果</th></tr></thead><tbody>${access.audit.slice(0, 30).map(item => `<tr><td>${formatTime(item.at)}</td><td>${esc(item.name)}</td><td>${esc(item.method)}</td><td>${esc(item.result)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="section-empty">尚无访问记录</div>'}</section>`;
  $('#agent-enabled').onchange = event => run(async () => {
    event.target.disabled = true;
    try { await api('agentConfigure', { enabled: event.target.checked }); await render(); }
    catch (error) { await render(); throw error; }
  });
  $('#agent-grant-form').onsubmit = event => {
    event.preventDefault();
    const form = event.target, submit = $('button[type=submit]', form);
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const values = new FormData(form);
        const grant = await api('agentGrant', { name: values.get('name'), days: Number(values.get('days')), domains: values.getAll('domains'),
          edit: values.has('edit'), trash: values.has('trash'), sensitive: values.has('sensitive') });
        await render();
        openModal('访问凭证（仅显示一次）', `<div class="notice amber">此凭证等同于所选资料的访问权限，请勿放入笔记、同步目录或公开聊天。</div><label class="settings-form">STUDYSELF_AGENT_TOKEN<input id="agent-token" type="password" readonly value="${esc(grant.token)}" autocomplete="off"></label><label class="check-row"><input id="agent-token-visible" type="checkbox">显示凭证</label><button class="secondary" id="agent-token-copy">${icon('copy')}复制凭证</button>`);
        $('#agent-token-visible').onchange = e => { $('#agent-token').type = e.target.checked ? 'text' : 'password'; };
        $('#agent-token-copy').onclick = () => run(async () => { await navigator.clipboard.writeText(grant.token); toast('已复制凭证'); });
        modalCleanup = () => { grant.token = ''; $('#modal').replaceChildren(); };
      } finally { submit.disabled = false; }
    });
  };
}
async function renderSettings() {
  const { preferences: prefs } = await api('agentSkill');
  let storage;
  try { storage = await api('storageStatus'); }
  catch { storage = { directory: state.snapshot.localDataDirectory, unavailable: true }; }
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><h1>系统设置</h1></div><button class="secondary" data-action="agent-export">${icon('download')}导出 Skill</button></div>
    <section class="settings-section" id="storage-settings"><h2>本地存储</h2>
      <label class="field-label">系统工作目录（根目录）<div class="input-with-action"><input id="storage-current" readonly value="${esc(storage.directory)}">${button('copy', 'storage-copy', '复制存储路径')}${native ? button('folder-open', 'storage-open-folder', '在文件管理器中打开') : ''}</div></label>
      ${!storage.unavailable && !storage.pending ? `<div class="storage-actions"><button class="primary" data-action="storage-change" data-mode="select">${icon('folder-cog')}选择或修改根目录</button></div>` : ''}
      <div class="storage-summary"><span>知识库 ${activeLibraries().length}</span><span>笔记 ${state.snapshot.counts.note || 0}</span><span>附件 ${state.snapshot.counts.asset || 0}</span></div>
      ${storage.error ? `<div class="notice danger" role="alert">${esc(storage.error)}</div>` : ''}
      ${storage.lastChange?.mode === 'migrate' ? `<div class="notice">原目录保留为迁移前副本，请勿同时打开：<span class="storage-path">${esc(storage.lastChange.previous)}</span></div>` : ''}
      ${storage.unavailable ? '<div class="notice amber">当前服务尚未加载存储设置，请重新启动应用。</div>' : storage.pending ? `<div class="notice amber" id="storage-pending"><div><strong>待重启生效 · ${storage.pending.mode === 'migrate' ? '迁移当前工作区' : '打开已有工作区'}</strong><div class="storage-path">${esc(storage.pending.directory)}</div><p>${native ? '重启时应用变更，当前资料继续保存在原目录。' : '关闭并重新启动预览服务后生效，仅刷新网页不会切换目录。'}</p></div></div><div class="heading-actions">${native ? `<button class="primary" data-action="storage-restart">${icon('rotate-cw')}重启并应用</button>` : ''}<button class="secondary" data-action="storage-cancel">${icon('x')}取消变更</button></div>` : `<div class="heading-actions storage-actions"><button class="secondary" data-action="storage-change" data-mode="migrate">${icon('folder-input')}迁移到新目录</button><button class="secondary" data-action="storage-change" data-mode="open">${icon('folder-open')}打开已有工作区</button></div>`}
    </section>
    <section class="settings-section"><h2>整理偏好</h2><details><summary>需求基线</summary><div class="prose">${safeHtml(prefs.baseline)}</div></details>
      ${prefs.conflict ? `<div class="notice amber">存在并发偏好，请对照后保存合并版本。Agent 写入已暂停。</div>${prefs.versions.map(version => `<details><summary>${formatTime(version.createdAt)}</summary><pre class="preference-version">${esc(version.data.content)}</pre></details>`).join('')}` : ''}
      <form id="agent-preferences-form" class="settings-form"><label>我的补充与调整<textarea name="content" rows="8" maxlength="30000">${esc(prefs.content)}</textarea></label><button type="submit" class="primary">${icon('save')}保存偏好版本</button></form><small class="muted agent-version">当前版本：${esc(prefs.version)}</small></section>`;
  $('#agent-preferences-form textarea').dataset.savedValue = prefs.content;
  $('#agent-preferences-form').onsubmit = event => {
    event.preventDefault(); const form = event.target;
    run(async () => { await api('agentPreferencesSave', { content: new FormData(form).get('content'), parents: prefs.heads }); await render(); toast('偏好版本已保存；Agent 下次写入前须读取新版本'); });
  };
}
function requireStorageSaved() {
  stash();
  if (state.tabs.some(tab => tab.dirty)) throw new Error('请先保存或关闭未保存的笔记标签，再更改存储位置');
  const preferences = $('#agent-preferences-form textarea');
  if (preferences && preferences.value !== preferences.dataset.savedValue) throw new Error('请先保存整理偏好，再更改存储位置');
}
async function changeStorage(mode) {
  requireStorageSaved();
  const directory = await pickDirectory();
  if (!directory) return;
  requireStorageSaved();
  const title = mode === 'select' ? '选择或修改系统根目录' : mode === 'migrate' ? '迁移当前工作区' : '打开已有工作区';
  const dialog = openModal(title, `<form id="storage-form" class="settings-form"><label>目标文件夹<div class="input-with-action"><input id="storage-target" readonly value="${esc(directory)}">${button('folder-open', 'storage-pick', '选择目标文件夹', 'type="button"')}</div></label>
    <div class="notice amber">${mode === 'select' ? '选择空目录将迁移当前资料；选择已有工作区将切换资料。检查后须再次确认，不会直接清空或覆盖当前知识库。' : mode === 'migrate' ? '迁移全部知识库、笔记、历史与附件。目标必须为空，校验成功后切换，原目录不删除。' : '选择已有的 StudySelf 工作区，不会合并或搬走当前资料。'}<br>本地工作区不得放入网盘同步目录。请关闭使用这些目录的其他应用实例，包括旧版本。</div><div id="storage-form-error" class="notice danger" role="alert" hidden></div><button type="submit" class="primary">${icon('search-check')}检查目录</button></form>`);
  $('#storage-form').onsubmit = async event => {
    event.preventDefault();
    const submit = $('button[type=submit]', event.target), errorBox = $('#storage-form-error');
    if (submit.disabled) return;
    submit.disabled = true; errorBox.hidden = true;
    try {
      const result = await api('storageInspect', { mode, directory: $('#storage-target').value.trim() });
      dialog.close();
      const accepted = await confirmBox(result.mode === 'migrate' ? '迁移当前资料并设置根目录' : '切换到已有工作区', `<p>目标根目录：</p><p class="storage-path">${esc(result.directory)}</p><p>知识库 ${result.counts.library || 0} · 笔记 ${result.counts.note || 0} · 附件 ${result.counts.asset || 0}</p><p>重启后生效。${result.mode === 'migrate' ? '迁移失败仍使用原目录，不覆盖目标已有内容。' : '当前工作区保留在原位置，切换不会合并资料。'}</p>`, '确认变更');
      if (!accepted) return;
      requireStorageSaved(); clearTimeout(persistTimer); await persist();
      await api('storageSchedule', { mode: result.mode, directory: result.directory });
      await render(); toast('存储位置变更已保存，重启后生效');
    } catch (error) {
      if (dialog.open && errorBox.isConnected) { errorBox.textContent = error.message; errorBox.hidden = false; }
      else toast(error.message, true);
    } finally { submit.disabled = false; }
  };
}
async function renderAssets() {
  const assets = (await api('assets')).filter(asset => !state.domain || asset.data.domain === state.domain);
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><div class="eyebrow">原文件与稳定引用</div><h1>资料与附件</h1></div><button class="primary" data-action="asset-import">${icon('upload')}导入文件</button></div>
    ${assets.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>附件</th><th>知识库</th><th>大小</th><th>本机状态</th><th>同步与保留</th><th></th></tr></thead><tbody>${assets.map(asset => `<tr><td><strong>${esc(asset.data.filename)}</strong><small>${asset.data.sha256.slice(0, 16)}…</small></td><td>${esc(libraryName(asset.data.domain))}</td><td>${bytes(asset.data.size)}</td><td><span class="pill ${asset.available ? 'green' : 'amber'}">${asset.available ? '本机文件可用' : '缺失或等待完整接收'}</span></td><td>${asset.pinned ? '全部同步 · 长期保留' : '全部同步 · 本地保存'}</td><td><div class="inline-actions">${button(asset.available ? 'eye' : 'link', asset.available ? 'preview-asset' : 'bind-asset', asset.available ? '查看附件' : '关联本机文件', `data-asset="${asset.id}"`)}${asset.available ? button('pin', 'pin-asset', asset.pinned ? '取消长期保留' : '长期保留', `data-asset="${asset.id}" data-pinned="${asset.pinned}"`) : ''}</div></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state">${icon('files')}<h2>暂无原文件</h2><button class="secondary" data-action="asset-import">导入文件</button></div>`}`;
  for (const asset of assets) {
    const cell = $(`[data-asset="${asset.id}"]`)?.closest('.inline-actions');
    cell?.insertAdjacentHTML('beforeend', asset.available
      ? button('hard-drive-download', 'asset-evict', '释放本机原件（需主力机回执）', `data-asset="${asset.id}"`)
      : button('download', 'asset-hydrate', '从已下载的交接文件恢复原件', `data-asset="${asset.id}"`));
  }
}
function openModal(title, body, footer = '') {
  const dialog = $('#modal');
  if (dialog.open) { dialog.close(); modalCleanup?.(); modalCleanup = null; }
  dialog.innerHTML = `<div class="modal-heading"><h2>${esc(title)}</h2><button class="icon-button" data-modal-close aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  dialog.showModal(); redrawIcons();
  hydrateRich(dialog, mediaUrl);
  $('[data-modal-close]', dialog).onclick = () => dialog.close();
  dialog.onclose = () => { if (!dialog.open) { modalCleanup?.(); modalCleanup = null; } };
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
let directoryPicking = false;
async function pickDirectory(target) {
  if (directoryPicking) return null;
  directoryPicking = true;
  const submit = target?.closest('form')?.querySelector('button[type="submit"]');
  const wasDisabled = submit?.disabled;
  if (submit) submit.disabled = true;
  try {
    const value = await api('chooseDirectory');
    if (target?.isConnected && value) target.value = value;
    return value;
  } finally {
    directoryPicking = false;
    if (submit?.isConnected) submit.disabled = wasDisabled;
  }
}
async function pickAttachment(expectedId) {
  if (!expectedId) requireLibrary();
  const domain = state.selected?.data.domain || state.domain;
  if (native) {
    const file = await api('chooseFile');
    return file ? api('assetImport', { path: file, expectedId, domain }) : null;
  }
  return new Promise((resolve, reject) => {
    const input = $('#file-input'); input.value = '';
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      try {
        const file = input.files[0]; if (!file) { resolve(null); return; }
        const params = new URLSearchParams({ domain });
        if (expectedId) params.set('expectedId', expectedId);
        const response = await fetch(`/upload?${params}`, { method: 'POST', headers: { 'X-StudySelf-Token': token, 'X-Filename': encodeURIComponent(file.name) }, body: file });
        const result = await response.json(); if (result.error) throw new Error(result.error.message); resolve(result.value);
      } catch (error) { reject(error); }
    };
    input.click();
  });
}
async function importDroppedFile(file, domain) {
  if (native) return window.desktop.importFile(file, domain);
  if (file.size > 128 * 1024 * 1024) throw new Error('浏览器预览单个文件上限为 128 MiB；更大的文件请使用桌面版导入');
  const response = await fetch(`/upload?${new URLSearchParams({ domain })}`, { method: 'POST',
    headers: { 'X-StudySelf-Token': token, 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result.value;
}
function bindFileDrop(editor, tab, record) {
  const area = $('.editor-scroll');
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  area.addEventListener('dragover', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; area.classList.add('file-drag-over');
  });
  area.addEventListener('dragleave', event => { if (!area.contains(event.relatedTarget)) area.classList.remove('file-drag-over'); });
  area.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); area.classList.remove('file-drag-over');
    if ([...event.dataTransfer.items].some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
      toast('暂不支持拖入整个文件夹，请选择其中的文件', true); return;
    }
    const files = [...event.dataTransfer.files];
    if (!files.length) { toast('请选择文件，暂不支持拖入整个文件夹', true); return; }
    if (importingFiles) { toast('上一批文件仍在导入', true); return; }
    let position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? editor.state.selection.to;
    const mapPosition = ({ transaction }) => { position = transaction.mapping.map(position, 1); };
    editor.on('transaction', mapPosition);
    importingFiles++;
    const indicator = document.createElement('span'); indicator.className = 'file-import-status'; indicator.setAttribute('role', 'status'); $('.editor-toolbar').append(indicator);
    void (async () => {
      const failures = []; let imported = 0;
      try {
        for (const [index, file] of files.entries()) {
          indicator.textContent = `正在导入 ${index + 1}/${files.length}`;
          try {
            const asset = await importDroppedFile(file, record.data.domain);
            const kind = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.data.mime) ? 'image'
              : ['video/mp4', 'video/webm', 'video/quicktime'].includes(asset.data.mime) ? 'video' : null;
            const content = kind ? { type: 'richBlock', attrs: { payload: encodeBlock({ v: 1, kind, assetId: asset.id, label: asset.data.title.slice(0, 200) }) } }
              : { type: 'layoutBlock', content: [{ type: 'paragraph', content: [{ type: 'text', text: file.name,
                marks: [{ type: 'link', attrs: { href: `studyself://asset/${asset.id}` } }] }] }] };
            editor.chain().insertContentAt(Math.min(position, editor.state.doc.content.size), content).run();
            imported++;
          } catch (error) { failures.push(`${file.name}：${error.message}`); }
        }
        toast(failures.length ? `已导入 ${imported} 个文件；${failures.join('；')}` : `已导入 ${imported} 个文件`, !!failures.length);
      } finally {
        editor.off('transaction', mapPosition); importingFiles--; indicator.remove();
      }
    })();
  }, true);
}
async function openRecord(id) {
  await persist();
  state.editor?.destroy(); state.editor = null;
  const record = await api('record', { id }); if (!record) return;
  if (record.type === 'library') { state.view = 'libraries'; state.selected = null; await render(); return; }
  state.selected = record;
  let tab = state.tabs.find(t => t.recordId === id);
  if (!tab) { tab = { id: uid(), recordId: id, title: record.data.title, domain: record.data.domain, scroll: 0 }; state.tabs.push(tab); }
  tab.recordType = record.type;
  state.selectedTab = tab.id;
  state.domain = record.data.domain === GLOBAL_SCOPE ? '' : record.data.domain;
  if (!['conflicts', 'trash'].includes(state.view)) state.view = ({ draft: 'drafts', proposal: 'proposals' })[record.type] || 'notes';
  await persist(); await render();
}
async function saveNote() {
  const tab = currentTab(); if (!tab) return;
  stash();
  await noteSaver.flush(tab.id, true);
  await persist();
  if (state.selected?.conflict) await render();
  updateSaveStatus();
  toast('已本地保存，修改历史已保留');
}
async function showHistory() {
  if (currentTab()?.dirty) await saveNote();
  const history = await api('history', { id: state.selected.id });
  const dialog = openModal('版本历史', `<div class="history-list">${history.map(event => `<section><div class="history-meta"><strong>${formatTime(event.createdAt)}</strong><span>${event.deleted ? '删除记录' : '内容版本'}</span><small>${event.deviceId.slice(0, 8)}</small><button class="text-button" data-version="${event.id}">恢复此版本</button></div><div class="prose">${safeHtml(event.data.content || JSON.stringify(event.data, null, 2), event.data.format)}</div></section>`).join('')}</div>`);
  $$('[data-version]', dialog).forEach(button => button.onclick = () => run(async () => {
    const accepted = await confirmBox('恢复历史版本', '<p>将创建一个新版本，当前内容和已有历史不会删除。</p>', '恢复');
    if (!accepted) return;
    state.selected = await api('restoreVersion', { id: state.selected.id, revision: button.dataset.version, parents: state.selected.heads });
    const tab = currentTab(); if (tab) { delete tab.draft; tab.dirty = false; }
    if (tab) await noteSaver.forget(tab.id);
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
    if (tab) await noteSaver.forget(tab.id);
    await render();
  }));
  const merge = $('[data-manual-merge]', dialog);
  if (merge) merge.onclick = () => run(async () => {
    const text = await inputBox('手动融合', '融合后的正文（Markdown）', record.versions.filter(v => !v.deleted).map(v => markdownConverter.turndown(safeHtml(v.data.content, v.data.format))).join('\n\n---\n\n'), true);
    if (text === null) return;
    state.selected = await api('save', { id: record.id, type: record.type, data: { ...record.data, content: text, format: 'markdown' }, parents: record.heads });
    const tab = currentTab(); if (tab) { tab.dirty = false; delete tab.draft; }
    if (tab) await noteSaver.forget(tab.id);
    await render();
  });
}
async function previewAsset(id) {
  const assets = await api('assets'), asset = assets.find(a => a.id === id);
  if (!asset?.available) {
    const accepted = await confirmBox('原文件尚未就绪', '<p>本机尚未收到完整原文件。请检查来源电脑和网盘客户端的传输进度；分块到齐并校验后会自动关联。也可关联已有的本机文件。</p>', '关联本机文件');
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
function editBlock(block, commit) {
  editRichBlock(block, commit, { openModal, mediaUrl, fail: message => toast(message, true) });
}
async function insertContent(kind) {
  const editor = state.editor; if (!editor || !kind) return;
  const selection = editor.state.selection;
  const range = { from: selection.node?.type.name === 'richBlock' ? selection.to : selection.from, to: selection.to };
  const commit = block => { if (!editor.isDestroyed) editor.chain().focus().insertContentAt(range, [{ type: 'richBlock', attrs: { payload: encodeBlock(block) } }, { type: 'paragraph' }]).run(); };
  if (kind === 'table') {
    editor.chain().focus().insertContentAt(range, [{ type: 'layoutBlock', content: [createTable(editor.schema, 3, 3, true).toJSON()] }, { type: 'paragraph' }]).run();
    return;
  }
  if (kind === 'callout') { if (editor.isActive('callout')) editor.chain().focus().lift('callout').run(); else editor.chain().focus().wrapIn('layoutBlock').wrapIn('callout').run(); return; }
  if (['image', 'video'].includes(kind)) {
    const matches = asset => kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.data.mime) : ['video/mp4', 'video/webm', 'video/quicktime'].includes(asset.data.mime);
    const assets = (await api('assets')).filter(asset => asset.data.domain === state.selected.data.domain && matches(asset));
    const dialog = openModal(kind === 'image' ? '插入图片' : '插入视频', `<form id="media-form" class="settings-form"><label>已有附件<select name="asset" required><option value="">选择附件</option>${assets.map(asset => `<option value="${asset.id}">${esc(asset.data.title)}${asset.available ? '' : '（未下载）'}</option>`).join('')}</select></label><div class="form-actions"><button type="button" class="secondary" id="import-media">${icon('upload')}导入文件</button><button type="submit" class="primary">插入</button></div></form>`);
    const insert = asset => { if (!matches(asset)) throw new Error('附件格式与所选媒体类型不符'); commit({ v: 1, kind, label: asset.data.title.slice(0, 200), assetId: asset.id }); dialog.close(); };
    $('#import-media').onclick = () => run(async () => { const asset = await pickAttachment(); if (asset) insert(asset); });
    $('#media-form').onsubmit = event => { event.preventDefault(); run(() => insert(assets.find(asset => asset.id === new FormData(event.target).get('asset')))); };
    return;
  }
  if (kind.startsWith('diagram:')) { const [label, source] = diagramTemplates[kind.slice(8)]; editBlock({ v: 1, kind: 'diagram', label, source }, commit); return; }
  const defaults = { formula: { label: '数学公式', source: 'E = mc^2' }, sticker: { label: '贴纸', text: '', color: 'yellow' }, canvas: { label: '无限画板', shapes: [] } };
  if (defaults[kind]) editBlock({ v: 1, kind, ...defaults[kind] }, commit);
}
async function editNoteLink() {
  const editor = state.editor; if (!editor) return;
  const existing = editor.getAttributes('link').href || '', parsed = parseNoteLink(existing);
  if (existing) editor.commands.extendMarkRange('link');
  const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
  const selectedText = editor.state.doc.textBetween(selection.from, selection.to, ' ');
  const dialog = openModal('笔记链接', `<form id="note-link-form" class="settings-form"><label>显示文字<input name="label" maxlength="500" value="${esc(selectedText)}"></label><label>链接类型<select name="kind"><option value="external">网址或外部文件网址</option><option value="note">系统内笔记或资料</option><option value="asset">系统内文件附件</option><option value="local">本地文件（当前电脑）</option></select></label><label id="link-url-field">地址<input name="url" type="url" value="${esc(existing)}"></label><label id="link-search-field" hidden>搜索<input id="link-search" type="search"></label><label id="link-target-field" hidden>目标<select name="target"></select></label><button type="button" class="secondary" id="bind-link-file" hidden>${icon('folder-open')}选择本地文件</button><span id="local-link-name" class="muted"></span><div class="form-actions"><button type="button" class="secondary" id="unlink-note">移除链接</button><button class="primary" type="submit">保存链接</button></div></form>`);
  const form = $('#note-link-form'); let localId = parsed?.kind === 'local' ? parsed.id : null, serial = 0;
  form.elements.kind.value = parsed?.kind || 'external';
  const populate = async () => {
    const serialNow = ++serial, kind = form.elements.kind.value;
    $('#link-url-field').hidden = kind !== 'external'; $('#bind-link-file').hidden = kind !== 'local';
    $('#link-search-field').hidden = $('#link-target-field').hidden = !['note', 'asset'].includes(kind);
    if (!['note', 'asset'].includes(kind)) return;
    const records = await api('records', { ...(kind === 'asset' ? { type: 'asset' } : {}), query: $('#link-search').value || undefined, limit: 300 });
    if (serialNow !== serial || !dialog.open) return;
    const choices = records.filter(record => !record.deleted && !record.conflict && (kind === 'asset' ? record.type === 'asset' : ['note', 'draft', 'source'].includes(record.type)));
    form.elements.target.innerHTML = '<option value="">选择目标</option>' + choices.map(record => `<option value="${record.id}">${esc(libraryName(record.data.domain))} / ${esc(record.data.title)}</option>`).join('');
    if (parsed?.kind === kind) form.elements.target.value = parsed.id;
  };
  form.elements.kind.onchange = () => run(populate); $('#link-search').oninput = () => run(populate); await populate();
  $('#bind-link-file').onclick = () => run(async () => {
    if (!native) throw new Error('本地文件直接链接需要桌面版；浏览器中可导入为文件附件');
    const binding = await api('bindLocalFile'); if (!binding) return;
    localId = binding.id; $('#local-link-name').textContent = binding.name; if (!form.elements.label.value) form.elements.label.value = binding.name;
  });
  $('#unlink-note').onclick = () => { editor.chain().focus().setTextSelection(selection).extendMarkRange('link').unsetLink().run(); dialog.close(); };
  form.onsubmit = event => { event.preventDefault(); run(() => {
    const values = Object.fromEntries(new FormData(form));
    const href = values.kind === 'external' ? values.url.trim() : `studyself://${values.kind}/${values.kind === 'local' ? localId || '' : values.target}`;
    if (!safeNoteLink(href)) throw new Error('请选择目标，或填写完整的 http / https 网址');
    const text = values.label.trim() || (values.kind === 'external' ? href : form.elements.target.selectedOptions[0]?.textContent) || '本地文件';
    const chain = editor.chain().focus().setTextSelection(selection);
    if (existing && !selectedText && !values.label.trim()) chain.extendMarkRange('link').setLink({ href }).run();
    else chain.insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).command(({ tr }) => { tr.removeStoredMark(editor.schema.marks.link); return true; }).run();
    dialog.close();
  }); };
}
const actions = {
  ...syncUI.actions,
  'library-folder-copy': async target => { const value = await api('libraryDirectory', { id: target.dataset.library }); await navigator.clipboard.writeText(value.directory); toast('已复制知识库文件夹路径'); },
  'library-folder-open': async target => api('libraryOpenFolder', { id: target.dataset.library }),
  'library-folder-retry': async target => { await api('libraryDirectory', { id: target.dataset.library }); await render(); },
  'storage-copy': async () => { await navigator.clipboard.writeText(state.snapshot.localDataDirectory); toast('已复制存储路径'); },
  'storage-open-folder': async () => api('storageOpenFolder'),
  'storage-change': async target => changeStorage(target.dataset.mode),
  'storage-pick': async () => { if (await pickDirectory($('#storage-target'))) { const error = $('#storage-form-error'); if (error) error.hidden = true; } },
  'storage-cancel': async () => { requireStorageSaved(); await api('storageCancel'); await render(); toast('已取消存储位置变更'); },
  'storage-restart': async () => {
    requireStorageSaved();
    if (!await confirmBox('重启并应用存储变更', '<p>重启后应用已确认的目录变更。迁移时原目录保留，不删除已有资料。</p>', '重启')) return;
    clearTimeout(persistTimer); await persist(); await api('storageRestart');
  },
  'note-link': editNoteLink,
  'refresh-view': render,
  'agent-export': async () => downloadSkill(await api('agentSkill')),
  'agent-revoke': async target => {
    if (!await confirmBox('撤销 Agent 授权', '<p>撤销后，该凭证不能再读取或修改资料。</p>', '撤销')) return;
    await api('agentRevoke', { id: target.dataset.grant }); await render();
  },
  'load-more': async () => { state.listLimit += 150; await refreshRows(); await renderView(); },
  home: async () => { state.view = 'notes'; await render(); },
  new: async () => {
    if (!activeLibraries().length) { await editLibrary(); return; }
    if (!state.domain) { state.view = 'libraries'; await render(); toast('请选择要打开的知识库'); return; }
    requireLibrary();
    const type = state.view === 'drafts' ? 'draft' : 'note';
    const record = await api('save', { type, data: { title: '未命名笔记', domain: state.domain, content: '', format: 'html', tags: [] } });
    await openRecord(record.id); $('#note-title')?.focus(); $('#note-title')?.select();
  },
  save: saveNote,
  'toggle-source': async () => {
    await persist(); state.sourceVisible = !state.sourceVisible;
    await persist(); await render();
  },
  'library-new': async () => editLibrary(),
  'library-edit': async target => editLibrary(target.dataset.library),
  'library-open': async target => selectLibrary(libraries().find(item => item.id === target.dataset.library).data.domain, true),
  'library-delete': async target => {
    const item = libraries().find(library => library.id === target.dataset.library);
    if (item.contentCount) throw new Error('请先迁移资料（含回收站），不会连带删除内容');
    if (!await confirmBox('删除空知识库', `<p>将删除“${esc(item.data.title)}”，可在知识库管理中恢复。</p>`, '删除')) return;
    await api('delete', { id: item.id, parents: item.heads });
    if (state.domain === item.data.domain) { await selectLibrary(''); }
    else await render();
  },
  'library-restore': async target => {
    const item = libraries().find(library => library.id === target.dataset.library);
    await api('restoreVersion', { id: item.id, revision: item.heads[0], parents: item.heads });
    await render(); toast('知识库已恢复');
  },
  'device-name': async () => { const name = await inputBox('设备名称', '当前电脑', state.snapshot.deviceName); if (name?.trim()) { await api('deviceName', { name }); await render(); } },
  'sync-now': async () => {
    await persist(); state.view = 'sync';
    if (!state.snapshot.sync.configured) { await render(); return; }
    await syncUI.actions['sync-scan']();
  },
  'choose-sync-folder': async () => pickDirectory($('#sync-folder')),
  'pairing-key': async () => { const { key } = await api('pairingKey'); $('#sync-key').value = key; $('#sync-key').type = 'text'; toast('请通过独立安全方式在另一台设备填写此密钥'); },
  history: showHistory,
  resolve: resolveConflict,
  delete: async () => {
    if (!state.selected) return;
    await saveNote();
    if (await confirmBox('移入回收站', '<p>删除记录会同步到其他电脑，正文与历史仍可恢复。</p>', '移入回收站')) {
      state.selected = await api('delete', { id: state.selected.id, parents: state.selected.heads });
      const tab = currentTab(); if (tab) { tab.dirty = false; delete tab.draft; }
      if (tab) await noteSaver.forget(tab.id);
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
    const dialog = openModal('笔记属性', `<form id="metadata-form" class="settings-form"><label>知识库<select name="domain" required>${domainOptions(record.data.domain, false)}</select></label><label>标签（逗号分隔）<input name="tags" value="${esc(record.data.tags.join(', '))}"></label><label class="check-row"><input type="checkbox" name="sensitive" ${record.data.sensitive ? 'checked' : ''}>敏感资料（外部 Agent 需要额外授权）</label><button class="primary">保存属性</button></form>`);
    $('#metadata-form').onsubmit = e => { e.preventDefault(); run(async () => {
      const data = Object.fromEntries(new FormData(e.target));
      state.selected = await api('save', { id: state.selected.id, type: state.selected.type, parents: state.selected.heads,
        data: { ...state.selected.data, domain: data.domain, tags: data.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), sensitive: data.sensitive === 'on' } });
      const tab = currentTab(); if (tab) {
        if (tab.domain !== data.domain) { tab.conversationId = null; tab.prompt = ''; }
        tab.domain = data.domain; tab.draft = null;
      }
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
    const text = `# ${record.data.title}\n\n${markdown}\n\n---\n知识库：${libraryName(record.data.domain)}\n标签：${record.data.tags.join(', ')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${record.data.title.replace(/[<>:"/\\|?*]/g, '_')}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  pdf: async () => {
    if (state.selected?.conflict) throw new Error('请先处理并发版本，再导出正文');
    if (native) await api('printPdf'); else window.print();
  },
  'proposal-new': async () => {
    requireLibrary();
    const content = await inputBox('新建待确认方案', '输入一项待整理内容（保留原文，不自动补充）', '', true);
    if (content?.trim()) { const proposal = await api('propose', { title: '待确认整理方案', domain: state.domain, items: [{ title: content.split('\n')[0].slice(0, 50), content }] }); await openRecord(proposal.id); }
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
    const dialog = openModal('修改待确认内容', `<form id="proposal-edit-form" class="settings-form"><label>标题<input name="title" required value="${esc(item.data.title)}"></label><label>目标知识库<select name="domain" required>${domainOptions(item.data.domain, false)}</select></label><label>内容<textarea name="content" rows="8">${esc(item.data.content)}</textarea></label><button class="primary" type="submit">保存方案</button></form>`);
    $('#proposal-edit-form').onsubmit = event => {
      event.preventDefault(); run(async () => {
        const values = Object.fromEntries(new FormData(event.target));
        const items = record.data.items.map(i => i.id === item.id ? { ...i, data: { ...i.data, ...values } } : i);
        state.selected = await api('save', { id: record.id, type: 'proposal', parents: record.heads, data: { ...record.data, items } });
        dialog.close(); await render();
      });
    };
  },
  'publish-workspace': async () => {
    await persist();
    await api('workspacePublish', { tabs: state.tabs.map(({ draft, dirty, prompt, ...tab }) => tab), selectedTab: state.selectedTab });
    toast('工作区位置已生成共享版本；未保存正文不随此操作发布');
  },
  'adopt-workspace': async () => {
    const records = (await api('records', { type: 'workspace' })).filter(r => r.data.originDevice !== state.snapshot.deviceId);
    const dialog = openModal('接续其他电脑的工作区', records.length ? records.map(r => `<div class="workspace-option"><span><strong>${esc(r.data.title)}</strong><small>${r.data.tabs?.length || 0} 个标签 · ${formatTime(r.updatedAt)}</small></span><button class="secondary" data-adopt="${r.id}">添加到当前工作区</button></div>`).join('') : '<div class="section-empty">尚未收到其他电脑发布的工作区</div>');
    $$('[data-adopt]', dialog).forEach(button => button.onclick = () => run(async () => {
      const result = await api('workspaceAdopt', { id: button.dataset.adopt }); await restoreWorkspaceTabs(result);
      dialog.close(); await render();
    }));
  },
};
async function run(fn) { try { await fn(); } catch (error) { console.error(error); toast(error.message, true); } }
document.addEventListener('click', event => {
  if (importingFiles && event.target.closest('[data-nav],[data-record],[data-tab],[data-close-tab],[data-action]:not([data-action^="fmt-"]):not([data-action="save"])')) {
    event.preventDefault(); toast('文件仍在导入，请完成后切换或关闭笔记'); return;
  }
  const external = event.target.closest('.document-content a,.prose a,.source-url a');
  if (external) {
    event.preventDefault();
    run(async () => {
      const href = external.getAttribute('href'), link = parseNoteLink(href);
      if (link?.kind === 'note') {
        const record = await api('record', { id: link.id });
        if (!record || !['note', 'draft', 'source'].includes(record.type)) throw new Error('链接目标尚未到达或不是笔记资料');
        if ($('#modal').open) $('#modal').close(); await openRecord(link.id); return;
      }
      if (link?.kind === 'asset') { await previewAsset(link.id); return; }
      if (link?.kind === 'local') {
        if (!native) throw new Error('本地文件链接请在桌面版打开；浏览器可将文件导入为附件');
        try { await api('openLocalFile', { id: link.id }); }
        catch (error) {
          if (error.code !== 'LOCAL_FILE_UNBOUND') throw error;
          if (await confirmBox('关联本地文件', '<p>此链接尚未在当前电脑绑定，是否选择对应文件？</p>', '选择文件')) await api('bindLocalFile', { id: link.id });
        }
        return;
      }
      const url = new URL(href);
      if (!safeNoteLink(href)) throw new Error('此链接类型不自动打开');
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('此链接类型不自动打开');
      if (native) await api('openExternal', { url: url.href });
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    });
    return;
  }
  const nav = event.target.closest('[data-nav]');
  if (nav) { run(async () => { await persist(); state.view = nav.dataset.nav; state.selected = null; state.selectedTab = null; state.query = ''; await render(); }); return; }
  const row = event.target.closest('[data-record]');
  if (row) { run(() => openRecord(row.dataset.record)); return; }
  const close = event.target.closest('[data-close-tab]');
  if (close) {
    run(async () => {
      const tab = state.tabs.find(t => t.id === close.dataset.closeTab);
      if (tab?.dirty && !(await confirmBox('关闭未保存标签', '<p>此标签含未保存修改。关闭将丢弃这部分编辑，已保存版本不受影响。</p>', '丢弃并关闭'))) return;
      if (tab) await noteSaver.forget(tab.id);
      state.tabs = state.tabs.filter(t => t.id !== close.dataset.closeTab);
      if (state.selectedTab === close.dataset.closeTab) {
        state.editor?.destroy(); state.editor = null;
        state.selectedTab = state.tabs.at(-1)?.id || null;
        state.selected = state.selectedTab ? await api('record', { id: currentTab().recordId }) : null;
        if (state.selected) state.domain = state.selected.data.domain === GLOBAL_SCOPE ? '' : state.selected.data.domain;
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
      'fmt-task': () => chain.toggleTaskList().run(), 'fmt-highlight': () => chain.toggleHighlight().run(),
      'fmt-undo': () => chain.undo().run(), 'fmt-redo': () => chain.redo().run() })[action]?.();
    return;
  }
  if (actions[action]) run(() => actions[action](target));
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(saveNote); }
});
window.addEventListener('beforeunload', event => {
  if (importingFiles || state.tabs.some(t => t.dirty)) { event.preventDefault(); event.returnValue = ''; }
});
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
});
async function init() {
  await loadState();
  state.domain = state.snapshot.workspace.domain || '';
  await restoreWorkspaceTabs(state.snapshot.workspace);
  const tab = currentTab();
  if (tab) { state.selected = await api('record', { id: tab.recordId }); state.domain = tab.domain || ''; }
  if (state.domain && !activeLibraries().some(item => item.data.domain === state.domain)) state.domain = '';
  await render();
  if (state.snapshot.sync.configured) {
    try {
      const report = await syncUI.scanDownloaded();
      toast(`请先在百度客户端检查更新。本机发现 ${report.entries.filter(item => !item.own && !item.imported).length} 个待接收清单，未自动导入`);
    } catch (error) { toast(`本机下载检查未完成：${error.message}`, true); }
  }
  refreshTimer = setInterval(async () => {
    try {
      const snapshot = await api('state'); state.snapshot = snapshot;
      if (state.view === 'sync' && !$('#sync-folder')?.matches(':focus') && !$('#sync-key')?.matches(':focus')) {
        // Preserve unsaved configuration fields rather than replacing the form during polling.
        const footer = $('.statusbar');
        if (footer) footer.innerHTML = `<span>${icon('hard-drive')}本地保存</span><span>修改历史自动保留</span><span class="status-right">云端上传状态：由客户端确认</span>`;
        redrawIcons();
      }
    } catch {}
  }, 15000);
  setInterval(() => { if (state.view === 'sync') syncUI.refreshProgress().then(redrawIcons).catch(() => {}); }, 1500);
}
run(init);
