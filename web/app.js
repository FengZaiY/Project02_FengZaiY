import { createIcons, icons } from 'lucide';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit, createTable } from '@tiptap/extension-table';
import { createSkillManager } from './skill-manager.js';
import { createUpdateUI } from './update-manager.js';
import { createSyncUI } from './sync-pages.js';
import { cleanNoteHtml, richExtensions, hydrateRich, editRichBlock, addRichMarkdownRules, diagramTemplates } from './rich-editor.js';
import { parseNoteLink, safeNoteLink, encodeBlock } from '../src/core/rich-schema.mjs';
import { createNoteAutosave } from './note-autosave.js';
import { createHierarchyUI } from './hierarchy-ui.js';
import { createNoteTreeDrag } from './note-tree-drag.js';
import { createAssetUI } from './asset-manager.js';
import { attachmentContent, bindAttachmentSources, bindAttachmentDrop } from './attachment-drag.js';
import { editorMarkers, experienceCodeBlock, mountEditorExperience } from './editor-experience.js';
import { showHistoryBrowser } from './history-ui.js';
import { isDocx, readDocx, docxPage } from './docx-preview.js';
import { createDraftUI, processingLabels } from './draft-workflow.js';
import './asset-preview.css';
import './draft-workflow.css';
import { recordRows } from './record-navigation.js';
import './record-navigation.css';

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
  selected: null, editor: null, sourceVisible: false, listLimit: 150, knowledgeTree: [], collapsedNotes: [], noteView: 'tree', draftFilter: 'active', listSummary: false, navigationHidden: false };
let persistTimer, queryTimer, refreshTimer, modalCleanup, sourcePreviewUrl, editorExperience;
let sourceLoadSerial = 0;
let previewSerial = 0, pendingPreview, sourcePreviewController;
let persistQueue = Promise.resolve(), importingFiles = 0;
const noteSaver = createNoteAutosave({
  capture: id => {
    const tab = state.tabs.find(item => item.id === id);
    if (tab === currentTab()) stash();
    return tab?.dirty && tab.draft ? { id: tab.recordId, type: tab.recordType || 'note',
      data: { ...tab.draft, title: tab.draft.title.trim() || '未命名笔记' }, parents: [...(tab.baseHeads || [])],
      ...(tab.notePlacement ? { notePlacement: tab.notePlacement } : {}) } : null;
  },
  write: async (input, manual) => {
    try { return await api('save', input); }
    catch (error) {
      if (!manual || error.code !== 'CONFLICT') throw error;
      if (!await confirmBox('保存期间出现新版本', '<p>其他修改已到达。当前编辑已保留，可以保存为独立并发版本，再对照融合。</p>', '保留为并发版本')) throw error;
      return api('saveBranch', input);
    }
  },
  apply: (id, saved, unchanged, input) => {
    const tab = state.tabs.find(item => item.id === id); if (!tab) return;
    if (tab === currentTab()) stash();
    if (input.notePlacement) {
      delete tab.notePlacement;
      if (tab.draft) tab.draft.noteOrder = saved.data.noteOrder;
    }
    applyOrderUpdates(saved.placementUpdates);
    if (state.selected?.id === saved.id) state.selected = saved;
    tab.title = unchanged ? saved.data.title : tab.draft.title;
    tab.domain = saved.data.domain;
    if (unchanged) { tab.dirty = false; delete tab.draft; delete tab.baseHeads; }
    else { tab.baseHeads = [...saved.heads]; }
    if (state.selected?.id === saved.id && $('#source-pane')?.dataset.ready === 'true') void renderSources(saved);
    void persist().catch(error => toast(`正文已保存，工作区位置保存失败：${error.message}`, true));
    const row = state.rows.find(item => item.id === saved.id);
    if (row) {
      Object.assign(row, saved);
      const element = $(`.record-row[data-record="${saved.id}"]`);
      if (element) {
        ($('strong>span', element) || $('strong', element)).textContent = saved.data.title;
        const summary = $('p', element);
        if (summary) summary.textContent = excerpt(saved);
        $('time', element).textContent = formatTime(saved.updatedAt);
      }
    }
    void api('noteTree').then(nodes => {
      state.knowledgeTree = nodes;
      if (state.view === 'notes') {
        if (state.query) return refreshRows().then(renderRecordList);
        renderRecordList();
      }
    }).catch(() => {});
    if (saved.type === 'draft') {
      void draftUI.refresh(saved).catch(() => {});
      if (state.view === 'drafts') void refreshRows().then(renderRecordList).catch(() => {});
    }
  },
  status: (id, value, error) => {
    updateSaveStatus();
    if (error) toast(value === 'conflict' ? '出现新版本，自动保存已暂停；当前编辑仍保留，请点击保存处理' : `自动保存未完成：${error.message}。当前编辑已保留，可点击保存重试`, true);
  }
});
const syncUI = createSyncUI({ api, esc, icon, formatTime, bytes, render, toast, confirmBox, persist });
const hierarchyUI = createHierarchyUI({ state, api, esc, icon, button, render: renderRecordList, persist, saveNote, openModal, confirmBox, toast, run, openRecord, libraryName });
const draftUI = createDraftUI({ state, api, esc, icon, openModal, saveNote, persist, openRecord, hierarchyUI, libraries, run, toast, redrawIcons });
const skillUI = createSkillManager({ api, esc, icon, safeHtml, formatTime, toast, confirmBox, redrawIcons, run });
const updateUI = createUpdateUI({ api, native, esc, icon, bytes, formatTime, redrawIcons, toast, prepareInstall: async () => {
  stash();
  if (importingFiles || state.tabs.some(tab => tab.dirty || noteSaver.state(tab.id) === 'saving') || skillUI.dirty() || $('dialog[open]')) {
    throw new Error('请先保存笔记和整理偏好、关闭编辑窗口，并等待文件导入完成后更新');
  }
  const app = $('#app');
  app.inert = true;
  try { await persist(); }
  catch (error) { app.inert = false; throw error; }
  return () => { app.inert = false; };
} });
const noteTreeDrag = createNoteTreeDrag({ state, move: moveKnowledgeNote, render: renderRecordList, run, toast });
const assetUI = createAssetUI({ state, api, esc, icon, button, bytes, formatTime, libraryName, domainOptions, openModal, confirmBox, toast, run, render: refreshAssetViews, redrawIcons, openRecord, mediaUrl, native, persist });
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
function rememberListSummary() {
  try { localStorage.setItem('studyself-list-summary', String(state.listSummary)); } catch {}
}
function toggleNavigation() {
  const main = $('#main');
  if (!main?.classList.contains('library-layout')) return;
  if (matchMedia('(max-width:900px)').matches) {
    main.classList.toggle('browse-folders');
    main.classList.remove('navigation-hidden');
    state.navigationHidden = false;
  } else {
    state.navigationHidden = !state.navigationHidden;
    main.classList.toggle('navigation-hidden', state.navigationHidden);
  }
  const visible = getComputedStyle($('.record-list')).display !== 'none';
  $('[data-action="toggle-navigation"]')?.setAttribute('aria-expanded', String(visible));
}
function stash() {
  skillUI.stash();
  const tab = currentTab();
  if (tab && state.editor && state.selected?.id === tab.recordId) {
    tab.scroll = $('.editor-scroll')?.scrollTop || 0;
    if (tab.dirty) {
      tab.draft = { ...state.selected.data, title: $('#note-title')?.value || state.selected.data.title,
        content: state.editor.getHTML(), format: 'html',
        ...(Object.hasOwn(tab.draft || {}, 'parentNoteId') ? { parentNoteId: tab.draft.parentNoteId } : {}),
        ...(Object.hasOwn(tab.draft || {}, 'noteOrder') ? { noteOrder: tab.draft.noteOrder } : {}),
        assetIds: tab.draft?.assetIds || state.selected.data.assetIds };
    }
  }
}
async function persist() {
  stash();
  const snapshot = JSON.parse(JSON.stringify({ tabs: state.tabs, selectedTab: state.selectedTab, domain: state.domain, collapsedNotes: state.collapsedNotes, noteView: state.noteView, sourceVisible: state.sourceVisible }));
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
  if (state.selected.type === 'draft' && $('#draft-workflow .pill')) {
    $('#draft-workflow .pill').textContent = '待处理 · 待保存';
    $('#draft-workflow .pill').classList.remove('green');
  }
  stash();
  noteSaver.changed(tab.id);
  clearTimeout(persistTimer); persistTimer = setTimeout(() => persist().catch(error => toast(error.message, true)), 500);
}
async function loadState() {
  state.snapshot = await api('state');
  state.knowledgeTree = await api('noteTree');
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
    ...(type === 'draft' ? { processing: state.query ? 'all' : state.draftFilter } : {}),
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
  const newLabel = state.view === 'drafts' ? '新建草稿' : '新建笔记';
  $('#app').innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="#" data-action="home"><span class="brand-mark">${icon('notebook-pen')}</span><span>StudySelf<small>个人知识工作区</small></span></a>
      <button class="new-note primary" data-action="new">${icon('plus')}${newLabel}</button>
      <nav>${navs.map(([id, i, text]) => `${id === 'libraries' ? '<div class="nav-divider">工作区管理</div>' : ''}<button class="nav-item ${state.view === id ? 'active' : ''}" data-nav="${id}" title="${esc(text)}" aria-label="${esc(text)}">${icon(i)}<span>${text}</span>${countFor(id) ? `<b>${countFor(id)}</b>` : ''}</button>`).join('')}</nav>
      <div class="device"><span class="device-icon">${icon('monitor')}</span><div><strong>${esc(state.snapshot.deviceName)}</strong><small>本地工作区 · v${state.snapshot.version}</small></div>${button('settings-2', 'device-name', '设备名称')}</div>
      <button class="sidebar-status" data-nav="sync"><span class="status-dot ${state.snapshot.sync.configured ? '' : 'amber'}"></span>${state.snapshot.sync.configured ? '同步目录已配置' : '同步尚未配置'}${icon('chevron-right')}</button>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb">${icon(active[1])}<strong>${active[2]}</strong><span>/</span><select id="domain-filter" aria-label="选择知识库">${domainOptions(state.domain)}</select>${button('folder-plus', 'library-new', '新建知识库')}</div>
        <div class="top-actions"><label class="search">${icon('search')}<input id="search" placeholder="${state.view === 'assets' ? '搜索名称、文件名或标签' : '搜索当前范围'}" value="${esc(state.query)}" aria-label="${state.view === 'assets' ? '搜索资料' : '搜索笔记'}"></label>${button('refresh-cw', 'refresh-view', '刷新内容')}${button('cloud-download', 'sync-now', '检查已下载更新')}</div>
      </header>
      <div class="work-tabs">${state.tabs.map(tab => `<div class="work-tab ${tab.id === state.selectedTab ? 'selected' : ''}" data-tab="${tab.id}" title="${esc(libraryName(tab.domain))} / ${esc(tab.title)}">${icon('file-text')}<span>${esc(tab.title)}${tab.dirty ? ' ·' : ''}</span><small>${esc(libraryName(tab.domain))}</small><button data-close-tab="${tab.id}" aria-label="关闭标签">${icon('x')}</button></div>`).join('')}<button class="tab-add" data-action="new" title="新建笔记" aria-label="新建笔记">${icon('plus')}</button><div class="tab-spacer"></div>${button('upload', 'publish-workspace', '发布当前工作区')}${button('panels-top-left', 'adopt-workspace', '接续其他电脑的工作区')}</div>
      ${state.view === 'trash' ? `<div class="trash-toolbar"><strong>回收站 · ${esc(libraryName(state.domain))}</strong><button class="secondary danger-action" data-action="trash-empty">${icon('trash-2')}清空回收站</button></div>` : ''}
      <main id="main"></main>
      <footer class="statusbar"><span>${icon('hard-drive')}本地保存</span><span>修改历史自动保留</span><span class="status-right">云端上传状态：由客户端确认</span></footer>
    </div>`;
  updateUI.refreshNotice();
  if (state.domain) $('#domain-filter').insertAdjacentHTML('afterend', button(state.view === 'drafts' ? 'list' : 'list-tree', 'knowledge-browse', state.view === 'drafts' ? '浏览草稿列表' : '浏览知识体系'));
  $('.tab-add').title = newLabel; $('.tab-add').setAttribute('aria-label', newLabel);
  $('#domain-filter').addEventListener('change', e => run(() => selectLibrary(e.target.value)));
  $('#search').addEventListener('input', e => {
    state.query = e.target.value;
    clearTimeout(queryTimer); queryTimer = setTimeout(() => run(async () => {
      await refreshRows();
      if (libraryViews.includes(state.view)) renderRecordList(); else await renderView();
    }), 200);
  });
}
async function render() {
  if (importingFiles) return;
  assetUI.dispose();
  stash(); state.editor?.destroy(); state.editor = null;
  await loadState(); await refreshRows(); shell(); await renderView(); redrawIcons();
}
async function renderView() {
  if (importingFiles) return;
  previewSerial++; pendingPreview?.abort();
  assetUI.dispose();
  if (sourcePreviewUrl) { URL.revokeObjectURL(sourcePreviewUrl); sourcePreviewUrl = null; }
  stash(); state.editor?.destroy(); state.editor = null;
  if (libraryViews.includes(state.view)) await renderLibrary();
  else if (state.view === 'libraries') renderLibraries();
  else if (state.view === 'sync') await renderSync();
  else if (state.view === 'devices') await syncUI.renderDevices();
  else if (state.view === 'agents') await renderAgents();
  else if (state.view === 'settings') await renderSettings();
  else if (state.view === 'assets') await assetUI.show();
  redrawIcons();
}
async function renderLibrary() {
  $('#main').className = `library-layout${!state.selected ? ' browse-folders' : state.navigationHidden ? ' navigation-hidden' : ''}`;
  $('#main').innerHTML = `<section class="record-list"></section>
    <section class="document-area" id="document-area"></section>`;
  renderRecordList();
  if (state.selected && (!state.domain || state.selected.data.domain === state.domain)) {
    const latest = await api('record', { id: state.selected.id });
    if (latest) { state.selected = latest; await renderDocument(latest); return; }
  }
  const hasLibraries = activeLibraries().length > 0;
  if (state.view === 'trash') {
    $('#document-area').innerHTML = `<div class="reading-layout"><div class="empty-state">${icon('trash-2')}<h2>${state.rows.length ? '选择已删除内容' : '回收站暂无内容'}</h2></div></div>`;
    return;
  }
  $('#document-area').innerHTML = `<div class="reading-layout"><div class="empty-state">${icon(hasLibraries ? 'notebook-pen' : 'folders')}<h2>${!hasLibraries ? '尚无知识库' : state.domain ? esc(libraryName(state.domain)) : '全部知识库'}</h2><button class="primary" data-action="${hasLibraries ? 'new' : 'library-new'}">${icon('plus')}${hasLibraries ? state.view === 'drafts' ? '新建草稿' : '新建笔记' : '新建知识库'}</button></div></div>`;
}
function renderRecordList() {
  if (noteTreeDrag.active()) return;
  const panel = $('.record-list');
  if (!panel || !libraryViews.includes(state.view)) return;
  const isNotes = state.view === 'notes', tree = isNotes && state.noteView === 'tree';
  const context = JSON.stringify([state.view, state.domain, state.query, tree]);
  const scrollTop = panel.dataset.context === context ? $('.folder-tree,.list-rows', panel)?.scrollTop || 0 : 0;
  const sharedList = isNotes || state.view === 'drafts';
  const title = sharedList ? libraryName(state.domain) : `${libraryName(state.domain)} · ${navs.find(n => n[0] === state.view)[2]}`;
  const count = isNotes && !state.query ? state.knowledgeTree.filter(item => !state.domain || item.data.domain === state.domain).length
    : `${state.rows.length}${state.rows.length >= state.listLimit ? '+' : ''}`;
  const more = (!tree || state.query) && state.rows.length >= state.listLimit
    ? '<button class="text-button load-more" data-action="load-more">加载更多</button>' : '';
  panel.innerHTML = `<div class="list-heading" ${tree && state.domain ? `data-note-drop-root="${esc(state.domain)}"` : ''}><strong title="${esc(title)}">${esc(title)}</strong><span>${count}</span>${state.view === 'trash' ? '' : button('plus', state.view === 'proposals' ? 'proposal-new' : 'new', isNotes ? '新建顶层笔记' : state.view === 'drafts' ? '新建草稿' : '新建')}</div>
    ${state.view === 'drafts' ? `<label class="draft-filter">处理状态<select id="draft-filter" aria-label="草稿处理状态" ${state.query ? 'disabled' : ''}>${Object.entries({ active: '待处理 / 部分处理', all: '全部草稿', ...processingLabels }).map(([value, title]) => `<option value="${value}" ${(state.query ? 'all' : state.draftFilter) === value ? 'selected' : ''}>${title}</option>`).join('')}</select></label>` : ''}
    ${isNotes ? `<div class="note-view-switch" role="group" aria-label="笔记视图">
      <button data-action="note-view" data-mode="tree" aria-pressed="${tree}">${icon('list-tree')}知识体系</button>
      <button data-action="note-view" data-mode="list" aria-pressed="${!tree}">${icon('list')}笔记列表</button></div>` : ''}
    ${sharedList && !tree ? `<div class="record-navigation-tools"><span>${isNotes ? '笔记列表' : '草稿列表'}</span>${button('list', 'list-summary', state.listSummary ? '切换为紧凑列表' : '显示正文摘要', `aria-pressed="${state.listSummary}"`)}</div>` : ''}
    ${tree ? hierarchyUI.tree() : `<div class="list-rows">${state.rows.length ? sharedList ? recordRows({ rows: state.rows, selectedId: state.selected?.id, domain: state.domain, summary: state.listSummary, esc, icon, libraryName, formatTime, excerpt, processingLabels, deliveryLabels: label }) : state.rows.map(row => `<button class="record-row ${state.selected?.id === row.id ? 'selected' : ''}" data-record="${row.id}">
    <div class="row-kicker"><span>${esc(libraryName(row.data.domain))}</span><time>${formatTime(row.updatedAt)}</time></div><strong>${row.conflict ? icon('git-merge') : ''}${esc(row.data.title)}</strong>
    <p>${esc(excerpt(row))}</p><div class="row-tags">${row.processing ? `<span class="processing-status">${processingLabels[row.processing.status]}</span>` : ''}${(row.data.tags || []).slice(0, 2).map(tag => `<span>${esc(tag)}</span>`).join('')}<small class="delivery ${row.status}">${label[row.status]}</small></div></button>`).join('') : `<div class="list-empty">${state.query ? '没有匹配的笔记' : '暂无内容'}</div>`}${more}</div>`}
    ${tree ? more : ''}`;
  panel.dataset.context = context;
  if ($('#draft-filter')) $('#draft-filter').onchange = event => run(async () => {
    state.draftFilter = event.target.value; state.listLimit = 150; await refreshRows(); renderRecordList();
  });
  const scroll = $('.folder-tree,.list-rows', panel);
  if (scroll) scroll.scrollTop = scrollTop;
  redrawIcons();
}
async function renderDocument(record) {
  const tab = currentTab();
  const data = tab?.recordId === record.id && tab.draft ? tab.draft : record.data;
  const editable = ['note', 'draft', 'source', 'annotation'].includes(record.type) && !record.deleted && !record.conflict;
  const hierarchyIssue = record.type === 'note' && state.knowledgeTree.find(item => item.id === record.id)?.issue;
  $('#document-area').innerHTML = `
    <div class="document-top"><span class="document-type">${icon(record.type === 'conversation' ? 'messages-square' : 'file-text')}${typeLabel[record.type] || record.type}</span><span id="save-state" class="muted">${tab?.dirty ? '尚未保存' : label[record.status]}</span>
      <div class="document-actions"><button class="source-toggle" data-action="toggle-source" aria-controls="source-pane" aria-expanded="${state.sourceVisible}" aria-pressed="${state.sourceVisible}" title="${state.sourceVisible ? '收起原附件' : '展开原附件'}">${icon(state.sourceVisible ? 'panel-left-close' : 'panel-left-open')}<span>原附件</span></button>${editable && record.type === 'note' ? button('list-tree', 'note-parent', '调整笔记层级') + button('file-plus-2', 'note-child', '新建下级笔记') : ''}${button('history', 'history', '历史版本')}${button('message-square-plus', 'annotate', '添加备注')}${button('download', 'export', '导出 Markdown')}${button('printer', 'pdf', '导出 PDF')}${button('trash-2', 'delete', '移入回收站')}${editable || tab?.dirty ? `<button class="primary compact save-status-button" data-action="save" aria-live="polite">${icon('save')}<span>已保存</span></button>` : ''}</div></div>
    ${record.conflict ? `<div class="notice amber">${icon('git-merge')}存在 ${record.versions.length} 个并发版本，未自动覆盖。<button data-action="resolve">对照处理</button></div>` : ''}
    ${hierarchyIssue && !record.conflict ? `<div class="notice amber">${icon('triangle-alert')}${esc(hierarchyIssue)}${editable ? '<button data-action="note-parent">调整笔记层级</button>' : ''}</div>` : ''}
    ${record.deleted ? `<div class="notice amber">${icon('trash-2')}此内容已进入回收站。<button data-action="restore">恢复内容</button></div>` : ''}
    ${record.type === 'draft' ? '<div id="draft-workflow" class="draft-workflow-bar" aria-label="草稿归档"></div>' : ''}
    <div class="reading-layout ${state.sourceVisible ? 'with-source' : ''}">
      <aside class="source-pane" id="source-pane" aria-label="原附件" ${state.sourceVisible ? '' : 'hidden'}>${sourceHeading(record)}<div class="source-pane-scroll"><div class="source-list" role="status">正在读取原附件…</div></div></aside>
      <article class="editor-panel">
        <div class="document-heading"><div class="document-breadcrumb">${esc(libraryName(data.domain))}<span>/</span>${esc(hierarchyUI.path(data.domain, data.parentNoteId))}<span>/</span>${typeLabel[record.type] || '知识'}</div>
          ${editable ? `<input id="note-title" class="note-title" value="${esc(data.title)}" aria-label="笔记标题">` : `<h1>${esc(data.title)}</h1>`}
          <div class="note-meta"><button data-action="metadata" class="metadata-button">${icon('tags')}${data.tags?.length ? data.tags.map(esc).join(' · ') : '标签与知识库'}</button>${data.sensitive ? `<span class="sensitive">${icon('shield-check')}敏感资料</span>` : ''}<time>${formatTime(record.updatedAt)}</time></div>
          ${record.type === 'source' && data.url ? `<div class="source-url"><a href="${esc(data.url)}">${icon('external-link')}${esc(data.url)}</a></div>` : ''}
        </div>
        ${editable ? `<div class="editor-toolbar" role="toolbar" aria-label="笔记编辑工具"><select id="heading-level" aria-label="标题级别"><option value="0">正文</option>${[1, 2, 3, 4, 5, 6].map(level => `<option value="${level}">标题 ${level}</option>`).join('')}</select>${button('bold', 'fmt-bold', '加粗')}${button('italic', 'fmt-italic', '斜体')}${button('highlighter', 'fmt-highlight', '文字高亮')}${button('list', 'fmt-list', '无序列表')}${button('list-ordered', 'fmt-ordered', '有序列表')}${button('list-checks', 'fmt-task', '任务列表')}${button('quote', 'fmt-quote', '引用')}${button('code-2', 'fmt-code', '代码块')}${button('link', 'note-link', '插入或修改链接')}<select id="insert-content" aria-label="插入内容"><option value="">插入内容</option><option value="image">图片</option><option value="video">视频</option><option value="table">表格</option><option value="callout">高亮块</option><option value="sticker">贴纸</option><option value="formula">数学公式</option>${Object.entries(diagramTemplates).map(([id, [name]]) => `<option value="diagram:${id}">${name}</option>`).join('')}<option value="canvas">无限画板</option></select><select id="table-action" aria-label="表格操作"><option value="">表格操作</option><option value="addRowAfter">插入行</option><option value="addColumnAfter">插入列</option><option value="deleteRow">删除行</option><option value="deleteColumn">删除列</option><option value="mergeCells">合并单元格</option><option value="splitCell">拆分单元格</option><option value="toggleHeaderRow">切换表头</option><option value="deleteTable">删除表格</option></select><span class="toolbar-divider"></span>${button('undo-2', 'fmt-undo', '撤销')}${button('redo-2', 'fmt-redo', '重做')}${button('paperclip', 'attach', '关联附件')}</div>` : ''}
        <div class="editor-scroll"><div id="editor-content" class="document-content"></div><div id="annotations"></div></div>
      </article>
    </div>`;
  if (['note', 'draft'].includes(record.type)) {
    $('.document-actions').insertAdjacentHTML('afterbegin', button('panel-left', 'toggle-navigation', '显示或隐藏笔记导航', `aria-expanded="${!state.navigationHidden && !matchMedia('(max-width:900px)').matches}"`));
  }
  if (editable) {
    state.editor = new Editor({
      element: $('#editor-content'), extensions: [StarterKit.configure({ codeBlock: false, link: { openOnClick: false, protocols: ['studyself'], isAllowedUri: safeNoteLink } }), experienceCodeBlock, editorMarkers, TableKit.configure({ table: { resizable: true } }), ...richExtensions({ mediaUrl, edit: editBlock })],
      content: safeHtml(data.content || '', data.format), editorProps: {
        attributes: { 'aria-label': '笔记正文', role: 'textbox', 'aria-multiline': 'true' },
        transformPastedHTML: cleanNoteHtml
      },
      onUpdate: changed,
      onSelectionUpdate: ({ editor }) => { if ($('#heading-level')) $('#heading-level').value = String(editor.getAttributes('heading').level || 0); if ($('#table-action')) $('#table-action').disabled = !editor.isActive('table'); }
    });
    bindFileDrop(state.editor, tab, record);
    const mountedEditor = state.editor;
    const experience = mountEditorExperience({
      editor: mountedEditor, panel: $('.editor-panel'), insert: kind => run(() => insertContent(kind)),
      link: () => run(editNoteLink), annotate: () => run(addAnnotation),
      references: async (query, all) => (await api('records', { type: 'note', ...(all ? {} : { domain: record.data.domain }), query, limit: 50 }))
        .filter(item => !item.deleted && !item.conflict),
      lookup: async id => { const item = await api('record', { id }); return item && { ...item, summary: excerpt(item) }; },
      openRecord: id => run(() => openRecord(id)), libraryName, toast
    });
    editorExperience = experience;
    mountedEditor.on('destroy', () => { experience.destroy(); if (editorExperience === experience) editorExperience = null; });
    updateSaveStatus();
    $('#note-title').addEventListener('input', changed);
    $('#heading-level').onchange = event => { const chain = state.editor.chain().focus(); const level = Number(event.target.value); if (level) chain.setHeading({ level }).run(); else chain.setParagraph().run(); };
    $('#insert-content').onchange = event => { const value = event.target.value; event.target.value = ''; run(() => insertContent(value)); };
    $('#table-action').disabled = true;
    $('#table-action').onchange = event => { const command = event.target.value; event.target.value = ''; if (command) state.editor.chain().focus()[command]().run(); };
    $('.editor-scroll').addEventListener('scroll', () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => persist().catch(() => {}), 500); });
    $('.editor-scroll').scrollTop = tab?.scroll || 0;
  } else if (record.type === 'conversation') {
    $('#editor-content').innerHTML = '<p class="muted">内置 AI 对话已取消，旧对话已清理。</p>';
  } else if (record.type === 'proposal') {
    $('#editor-content').innerHTML = `${data.content ? `<section class="proposal-summary prose">${safeHtml(data.content)}</section>` : ''}<div class="proposal-items">${data.items.map(item => `<section class="proposal-item"><label class="check-row"><input type="checkbox" data-proposal-item="${item.id}" ${item.status === 'accepted' ? 'disabled checked' : ''}><strong>${esc(item.data.title)}</strong><span class="pill ${item.status === 'accepted' ? 'green' : ''}">${item.status === 'accepted' ? '已确认' : '待确认'}</span></label><div class="proposal-destination">${icon('folder')}目标：${esc(libraryName(item.data.domain))}<span>出处 ${item.data.sourceIds?.length || 0} · 附件 ${item.data.assetIds?.length || 0}</span></div><div class="prose">${safeHtml(item.data.content, item.data.format)}</div></section>`).join('')}</div><div class="sticky-actions"><button class="primary" data-action="approve">确认选中部分</button><button class="secondary" data-action="proposal-edit">修改待确认部分</button></div>`;
    $$('.proposal-item').forEach((element, index) => {
      const item = data.items[index];
      $('.proposal-destination', element).insertAdjacentHTML('afterend', `<div class="proposal-operation">上级笔记：${esc(hierarchyUI.proposalPath(data.items, item))}</div>${item.reason ? `<div class="proposal-reason">${esc(item.reason)}</div>` : ''}`);
      $('.proposal-destination', element).insertAdjacentHTML('afterend', item.parents?.length
        ? `<div class="proposal-operation">合并更新已有笔记（保留历史）<button class="text-button" data-record="${esc(item.targetId)}">${icon('file-search')}查看原笔记</button></div>`
        : '<div class="proposal-operation muted">新建笔记</div>');
    });
    const proposalHost = $('.proposal-items');
    const draftIds = [...new Set(data.items.flatMap(item => (item.draftRefs || []).map(ref => ref.id)))];
    if (draftIds.length) {
      const drafts = new Map(await Promise.all(draftIds.map(async id => [id, await api('record', { id })])));
      if (proposalHost.isConnected && state.selected?.id === record.id) {
        $$('.proposal-item', proposalHost).forEach((element, index) => {
          const item = data.items[index];
          for (const ref of item.draftRefs || []) {
            const draft = drafts.get(ref.id);
            const stale = !draft || draft.deleted || draft.conflict || draft.heads.length !== 1 || draft.heads[0] !== ref.versionId;
            const complete = data.items.some(entry => entry.draftRefs?.some(source => source.id === ref.id && source.versionId === ref.versionId && source.complete));
            $('.proposal-destination', element).insertAdjacentHTML('afterend', `<div class="proposal-operation">来源草稿：${draft ? `<button class="text-button" data-record="${ref.id}">${esc(draft.data.title)}</button>` : '尚未到达'}${stale ? ' · 来源已变化，待重新核对' : complete ? ' · 完整整理：全部相关项确认后记为已处理' : ' · 部分整理：确认后仍保留待办'}</div>`);
          }
        });
      }
    }
  } else $('#editor-content').innerHTML = safeHtml(data.content || '', data.format);
  if (['note', 'draft', 'source'].includes(record.type)) {
    if (record.type === 'draft') void draftUI.refresh(record).catch(error => toast(error.message, true));
    await renderAnnotations(record);
    void renderBacklinks(record);
  }
  hydrateRich($('#document-area'), mediaUrl);
  if (state.sourceVisible) await renderSources(record);
}
async function renderAnnotations(record) {
  const host = $('#annotations'); if (!host) return;
  const annotations = (await api('records', { type: 'annotation', domain: record.data.domain })).filter(item => item.data.noteId === record.id);
  if (!host.isConnected || state.selected?.id !== record.id) return;
  host.innerHTML = annotations.length ? `<h3>备注 <small>${annotations.length}</small></h3>${annotations.map(item => `<div class="annotation">${item.data.quote ? `<blockquote>${esc(item.data.quote)}</blockquote>` : ''}<div>${esc(item.data.content)}</div><small>${formatTime(item.updatedAt)}</small>${item.data.quote ? `<button data-locate-annotation="${item.id}">定位原文</button>` : ''}</div>`).join('')}` : '';
  host.querySelectorAll('[data-locate-annotation]').forEach(button => {
    button.onclick = () => editorExperience?.locate(annotations.find(item => item.id === button.dataset.locateAnnotation).data.quote);
  });
}
async function addAnnotation() {
  const record = state.selected, editor = state.editor;
  if (!record) return;
  const { from, to } = editor?.state.selection || { from: 0, to: 0 };
  const quote = editor ? editor.state.doc.textBetween(from, to, '\n') : window.getSelection()?.toString() || '';
  const content = await inputBox('添加备注', '心得、疑问或实操记录', '', true);
  if (content?.trim()) {
    await api('save', { type: 'annotation', data: { title: `${record.data.title} · 备注`, domain: record.data.domain, noteId: record.id, quote, content, sensitive: record.data.sensitive } });
    if (state.selected?.id === record.id) await renderAnnotations(record);
    toast('备注已保存');
  }
}
async function renderBacklinks(record) {
  const editor = state.editor, panel = $('.editor-scroll');
  const details = document.createElement('details'); details.className = 'backlinks';
  details.innerHTML = '<summary>引用此笔记</summary><div></div>'; panel?.append(details);
  let loaded = false;
  details.ontoggle = async () => {
    if (!details.open || loaded) return;
    const host = details.querySelector('div'); host.textContent = '正在查找…';
    try {
      const notes = [...await api('records', { type: 'note' }), ...await api('records', { type: 'draft' })];
      if (!details.isConnected || state.selected?.id !== record.id || editor?.isDestroyed) return;
      const matches = notes.filter(note => note.id !== record.id && note.versions.some(version => {
        const template = document.createElement('template'); template.innerHTML = safeHtml(version.data.content, version.data.format);
        return [...template.content.querySelectorAll('a')].some(a => a.getAttribute('href') === `studyself://note/${record.id}`);
      }));
      host.replaceChildren();
      for (const note of matches) {
        const button = document.createElement('button'); button.textContent = `${note.data.title} · ${libraryName(note.data.domain)}${note.conflict ? ' · 存在冲突' : ''}`;
        button.onclick = () => run(() => openRecord(note.id)); host.append(button);
      }
      if (!matches.length) host.textContent = '暂无其他笔记引用';
      loaded = true;
    } catch (error) { if (host.isConnected) host.textContent = `读取失败：${error.message}；收起后可重试`; }
  };
}
function sourceAttachmentMenu(asset, editable) {
  const actions = [['info', 'material-detail', '资料详情与引用', '详情与引用']];
  if (!asset.conflict && !asset.deleted) actions.push(['pencil', 'material-edit', '编辑资料属性', '编辑属性']);
  if (editable) actions.push(['unlink', 'source-unlink', '解除与当前笔记的关联', '解除关联']);
  return `<details class="source-attachment-actions"><summary role="button" title="附件操作" aria-label="附件操作">${icon('ellipsis')}</summary>
    <div class="source-attachment-menu">${actions.map(([symbol, action, title, label]) => `<button type="button" data-action="${action}" data-asset="${asset.id}" data-name="${esc(asset.data.title)}" aria-label="${title}" title="${title}">${icon(symbol)}<span>${label}</span></button>`).join('')}</div></details>`;
}
async function renderSources(record) {
  const pane = $('#source-pane');
  if (!pane) return;
  const request = String(++sourceLoadSerial);
  pane.dataset.loading = request;
  try {
    const assets = await api('assets');
    const data = currentTab()?.recordId === record.id && currentTab()?.dirty ? currentTab().draft : record.data;
    const bodies = [data, ...(record.type === 'proposal' ? data.items.map(item => item.data) : [])];
    const assetIds = new Set(bodies.flatMap(data => data.assetIds || []));
    const sourceIds = [...new Set(bodies.flatMap(data => data.sourceIds || []))];
    const bodyAssets = new Set(bodies.flatMap(data => [...bodyAttachmentIds(data)]));
    const linked = assets.filter(a => assetIds.has(a.id));
    const sources = (await Promise.all(sourceIds.map(id => api('record', { id })))).filter(Boolean);
    if (!pane.isConnected || state.selected?.id !== record.id || pane.dataset.loading !== request) return;
    const editable = canManageAttachments(record);
    $('.source-list', pane).innerHTML = `${linked.map(a => `<div class="source-attachment" data-source-asset="${a.id}">
      <button class="source-item" data-preview-asset="${a.id}" title="${esc(a.data.title)}&#10;${a.available ? bytes(a.data.size) : '本机尚未下载'} · ${bodyAssets.has(a.id) ? '正文或来源链接引用' : '关联附件'}${a.conflict ? ' · 属性冲突' : ''}">${icon(a.data.mime.startsWith('image/') ? 'image' : 'file-text')}<span><span class="source-filename">${esc(a.data.title)}</span><small>${a.available ? bytes(a.data.size) : '本机尚未下载'} · ${bodyAssets.has(a.id) ? '正文或来源链接引用' : '关联附件'}${a.conflict ? ' · 属性冲突' : ''}</small></span></button>
      ${sourceAttachmentMenu(a, editable)}
      </div>`).join('')}${sources.length ? '<div class="source-section-label">关联来源</div>' : ''}${sources.map(s => `<button class="source-item" data-record="${s.id}">${icon('link')}<span>${esc(s.data.title)}</span></button>`).join('')}`;
    let preview = $('#source-preview', pane);
    if (!preview) {
      preview = document.createElement('div'); preview.id = 'source-preview'; preview.className = 'source-preview';
      $('.source-pane-scroll', pane).append(preview);
    }
    if (preview.dataset.asset && !assetIds.has(preview.dataset.asset)) {
      closeSourcePreview({ returnToList: false });
    }
    if (!preview.dataset.asset) preview.innerHTML = !linked.length && !sources.length ? '<span class="muted">尚未关联原附件</span>' : '';
    pane.dataset.ready = 'true';
    $$('.source-attachment-actions', pane).forEach(menu => menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      const row = menu.parentElement.getBoundingClientRect(), scroll = $('.source-pane-scroll', pane).getBoundingClientRect();
      menu.classList.toggle('open-up', scroll.bottom - row.bottom < 125 && row.top - scroll.top > 125);
    }));
    if (editable) bindAttachmentSources(pane, linked, state.editor, record.id);
    redrawIcons();
  } catch (error) {
    if (pane.isConnected && pane.dataset.loading === request) {
      $('.source-list', pane).innerHTML = `<p class="muted">${esc(error.message)}</p><button class="text-button" data-action="source-retry">${icon('refresh-cw')}重试</button>`;
      redrawIcons();
    }
  } finally { if (pane.dataset.loading === request) delete pane.dataset.loading; }
}
function canManageAttachments(record = state.selected) {
  return record && ['note', 'draft', 'source'].includes(record.type) && !record.deleted && !record.conflict;
}
function bodyAttachmentIds(data) {
  const ids = new Set(), template = document.createElement('template');
  template.innerHTML = safeHtml(data.content, data.format);
  const addLink = value => { const link = parseNoteLink(value); if (link?.kind === 'asset') ids.add(link.id); };
  addLink(data.url);
  for (const element of template.content.querySelectorAll('a[href],[data-ss-block]')) {
    addLink(element.getAttribute('href'));
    const payload = element.getAttribute('data-ss-block');
    if (payload) { const block = JSON.parse(payload); if (block.assetId) ids.add(block.assetId); }
  }
  return ids;
}
async function refreshAssetViews() {
  if (state.editor && $('#source-pane') && state.selected) {
    state.snapshot = await api('state');
    await renderSources(state.selected);
  } else await render();
}
async function changeAttachments(tab, assetIds) {
  if (currentTab() !== tab || !canManageAttachments() || state.selected.id !== tab.recordId) throw new Error('笔记已切换或不可编辑，请重新打开原附件');
  stash();
  tab.draft = { ...state.selected.data, ...tab.draft, assetIds: [...new Set(assetIds)] };
  changed();
  // Use the same writer as text edits so neither can overwrite an in-flight save.
  await renderSources(state.selected);
  await noteSaver.flush(tab.id);
  if (['error', 'conflict'].includes(noteSaver.state(tab.id))) throw new Error('附件关联尚未保存，已保留在当前编辑中，请处理保存状态后重试');
  await persist();
}
async function unlinkAttachment(target) {
  const tab = currentTab();
  if (!canManageAttachments() || !tab) return;
  stash();
  if (bodyAttachmentIds(tab.draft || state.selected.data).has(target.dataset.asset)) {
    toast('此附件仍被正文或来源链接引用，请先移除相应引用，再解除附件关联');
    return;
  }
  if (!await confirmBox('解除附件关联', `<p>从“${esc(state.selected.data.title)}”的原附件中移除“${esc(target.dataset.name)}”？</p><p>资料与原文件保留，正文中的引用和其他笔记的关联不变。</p>`, '解除关联')) return;
  if (currentTab() !== tab) throw new Error('笔记已切换，请重新选择附件');
  const data = tab.draft || state.selected.data;
  await changeAttachments(tab, (data.assetIds || []).filter(id => id !== target.dataset.asset));
  toast('已解除附件关联，资料与原文件保留');
}
async function linkExistingAttachments() {
  const tab = currentTab(), record = state.selected;
  if (!canManageAttachments(record) || !tab) return;
  const assets = await api('assets');
  if (currentTab() !== tab) return;
  const linked = new Set((tab.draft || record.data).assetIds || []);
  const available = assets.filter(a => a.data.domain === record.data.domain && !a.deleted && !a.conflict && !linked.has(a.id));
  const dialog = openModal('关联已有资料', `<form id="source-link-form" class="settings-form"><label>搜索资料<input name="query" type="search" placeholder="名称、文件名或标签"></label><div class="source-link-options"></div><div class="form-actions"><span class="muted" id="source-link-count"></span><button class="primary" type="submit" disabled>关联所选资料</button></div><p role="alert" class="material-form-error"></p></form>`);
  const selected = new Set(), form = $('#source-link-form', dialog), list = $('.source-link-options', dialog), submit = $('[type=submit]', form);
  const update = () => { $('#source-link-count', form).textContent = `已选 ${selected.size} 项`; submit.disabled = !selected.size; };
  const show = () => {
    const query = form.elements.query.value.trim().toLocaleLowerCase();
    const matches = available.filter(a => [a.data.title, a.data.filename, ...a.data.tags].join('\n').toLocaleLowerCase().includes(query));
    list.innerHTML = matches.slice(0, 100).map(a => `<label class="source-link-option"><input type="checkbox" value="${a.id}" ${selected.has(a.id) ? 'checked' : ''}><span>${esc(a.data.title)}<small>${bytes(a.data.size)} · ${a.available ? '本机可用' : '本机尚未下载'}</small></span></label>`).join('') || '<p class="muted">没有可关联的资料</p>';
    if (matches.length > 100) list.insertAdjacentHTML('beforeend', '<p class="muted">仅显示前 100 项，请搜索缩小范围。</p>');
    $$('input', list).forEach(input => input.onchange = () => { if (input.checked) selected.add(input.value); else selected.delete(input.value); update(); });
    update();
  };
  form.elements.query.oninput = show; show();
  form.onsubmit = event => {
    event.preventDefault(); if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        if (currentTab() !== tab) throw new Error('笔记已切换，请重新打开关联窗口');
        await changeAttachments(tab, [...((tab.draft || state.selected.data).assetIds || []), ...selected]);
        dialog.close(); toast(`已关联 ${selected.size} 项资料`);
      } catch (error) { $('[role=alert]', form).textContent = error.message; }
      finally { update(); }
    });
  };
}
function sourceHeading(record) {
  return `<div class="panel-heading">${icon('files')}<strong>原附件</strong><div class="source-actions">${canManageAttachments(record) ? button('paperclip', 'attach', '添加本地附件') + button('list-plus', 'source-link', '关联已有资料') : ''}${button('panel-left-close', 'source-close', '收起原附件')}</div></div>`;
}
async function setSourceVisible(visible) {
  const pane = $('#source-pane'), toggle = $('[data-action="toggle-source"]');
  if (!pane || !toggle || !state.selected) return;
  state.sourceVisible = visible;
  if (!visible) {
    if (pane.contains(document.activeElement)) toggle.focus();
    $$('video,audio', pane).forEach(media => media.pause());
  }
  pane.hidden = !visible;
  pane.closest('.reading-layout').classList.toggle('with-source', visible);
  toggle.setAttribute('aria-expanded', String(visible));
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.title = visible ? '收起原附件' : '展开原附件';
  toggle.innerHTML = `${icon(visible ? 'panel-left-close' : 'panel-left-open')}<span>原附件</span>`;
  redrawIcons();
  const record = state.selected;
  await persist();
  if (visible && pane.isConnected && pane.dataset.ready !== 'true') await renderSources(record);
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
}
async function editLibrary(id) {
  const item = id ? libraries().find(library => library.id === id) : null;
  if (id && !item) throw new Error('知识库不存在，请刷新');
  const dialog = openModal(item ? '编辑知识库' : '新建知识库', `<form id="library-form" class="settings-form">
    ${item?.conflict ? `<div class="notice amber">并发版本：${item.versions.map(version => esc(version.data.title)).join(' / ')}。保存将形成新的合并版本，原版本保留在历史中。</div>` : ''}
    <label>名称<input name="title" maxlength="100" value="${esc(item?.data.title || '')}" required autocomplete="off"></label>
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
  const skill = await api('agentSkill');
  let storage;
  try { storage = await api('storageStatus'); }
  catch { storage = { directory: state.snapshot.localDataDirectory, unavailable: true }; }
  $('#main').className = 'settings-view';
  $('#main').innerHTML = `<div class="page-heading"><div><h1>系统设置</h1></div><div class="settings-shortcuts"><button class="secondary" data-action="update-manage">${icon('download')}升级更新</button><button class="secondary" data-action="skill-manage">${icon('book-open-check')}SKILL 管理</button></div></div>
    <section class="settings-section" id="upgrade-settings" aria-label="升级更新"></section>
    <section class="settings-section" id="storage-settings"><h2>本地存储</h2>
      <label class="field-label">系统工作目录（根目录）<div class="input-with-action"><input id="storage-current" readonly value="${esc(storage.directory)}">${button('copy', 'storage-copy', '复制存储路径')}${native ? button('folder-open', 'storage-open-folder', '在文件管理器中打开') : ''}</div></label>
      ${!storage.unavailable && !storage.pending ? `<div class="storage-actions"><button class="primary" data-action="storage-change" data-mode="select">${icon('folder-cog')}选择或修改根目录</button></div>` : ''}
      <div class="storage-summary"><span>知识库 ${activeLibraries().length}</span><span>笔记 ${state.snapshot.counts.note || 0}</span><span>附件 ${state.snapshot.counts.asset || 0}</span></div>
      <div class="storage-summary"><span>本地文件：${state.snapshot.localHierarchy?.busy ? '维护中' : state.snapshot.localHierarchy?.errors?.length ? '维护未完成' : state.snapshot.localHierarchy?.pending ? '待更新' : '已更新'}</span>${state.snapshot.localHierarchy?.missing ? `<span>${state.snapshot.localHierarchy.missing} 个原件待接收</span>` : ''}</div>
      ${state.snapshot.localHierarchy?.errors?.length ? `<div class="notice amber">${state.snapshot.localHierarchy.errors.map(item => esc(item.message)).join('<br>')}${button('refresh-cw', 'storage-retry', '重试本地文件维护')}</div>` : ''}
      ${state.snapshot.deletion?.files?.length || state.snapshot.deletion?.database ? `<div class="notice"><div><strong>永久删除清理</strong><p>本地文件已释放 ${bytes(state.snapshot.deletion.releasedBytes)} · ${state.snapshot.deletion.pending} 个文件待处理 · 数据库${state.snapshot.deletion.database?.state === 'done' ? '已压缩' : '待压缩'}</p>
        ${state.snapshot.deletion.retiredAI ? `<p>内置 AI 历史：已移除 ${state.snapshot.deletion.retiredAI.records} 条旧记录及 ${state.snapshot.deletion.retiredAI.settings} 项本机配置${state.snapshot.deletion.retiredAI.pending ? '，文件清理或数据库压缩待完成' : ''}。</p>` : ''}
        ${state.snapshot.deletion.files.filter(item => item.state !== 'done').map(item => `<p class="storage-path">${esc(item.relative)}：${esc(item.reason || '等待清理')}</p>`).join('')}
        ${state.snapshot.deletion.database?.reason ? `<p>${esc(state.snapshot.deletion.database.reason)}</p>` : ''}
        <p>同步传输副本：${({ done: '本机目录清理完成，等待百度客户端传输删除', blocked: '部分待处理', unconfigured: '未配置同步' })[state.snapshot.deletion.transport?.state] || '待处理'}。百度历史版本和回收站需在客户端另行清理。</p>
        ${(state.snapshot.deletion.transport?.errors || []).map(item => `<p>${esc(item.file || '')} ${esc(item.message)}</p>`).join('')}
        ${state.snapshot.deletion.legacyArchives?.length || state.snapshot.deletion.legacyBackups ? '<p>检测到退役版本目录或旧备份登记，可能含历史副本。本次未清理，需单独核对，不能视为所有本地副本已删除。</p>' : ''}
        <button class="secondary" data-action="deletion-retry">${icon('refresh-cw')}重试永久删除清理</button></div></div>` : ''}
      ${activeLibraries().filter(item => item.directoryError).map(item => `<div class="notice amber">${esc(item.data.title)}：${esc(item.directoryError)}${button('refresh-cw', 'library-storage-retry', '重试本地存储', `data-library="${item.id}"`)}</div>`).join('')}
      ${storage.error ? `<div class="notice danger" role="alert">${esc(storage.error)}</div>` : ''}
      ${storage.lastChange?.mode === 'migrate' ? `<div class="notice"><div>${storage.lastChange.cleaned ? '迁移旧副本的托管内容已清理，额外文件保留：' : '原目录保留为迁移前副本，请勿同时打开：'}<span class="storage-path">${esc(storage.lastChange.previous)}</span>${!storage.lastChange.cleaned ? '<button class="secondary" data-action="storage-previous-clean">检查并清理旧副本</button>' : ''}</div></div>` : ''}
      ${storage.unavailable ? '<div class="notice amber">当前服务尚未加载存储设置，请重新启动应用。</div>' : storage.pending ? `<div class="notice amber" id="storage-pending"><div><strong>待重启生效 · ${storage.pending.mode === 'migrate' ? '迁移当前工作区' : '打开已有工作区'}</strong><div class="storage-path">${esc(storage.pending.directory)}</div><p>${native ? '重启时应用变更，当前资料继续保存在原目录。' : '关闭并重新启动预览服务后生效，仅刷新网页不会切换目录。'}</p></div></div><div class="heading-actions">${native ? `<button class="primary" data-action="storage-restart">${icon('rotate-cw')}重启并应用</button>` : ''}<button class="secondary" data-action="storage-cancel">${icon('x')}取消变更</button></div>` : `<div class="heading-actions storage-actions"><button class="secondary" data-action="storage-change" data-mode="migrate">${icon('folder-input')}迁移到新目录</button><button class="secondary" data-action="storage-change" data-mode="open">${icon('folder-open')}打开已有工作区</button></div>`}
    </section>
    <section class="settings-section" id="skill-management" aria-label="SKILL 管理"></section>`;
  await skillUI.mount($('#skill-management'), skill);
  await updateUI.mount($('#upgrade-settings'), state.snapshot.version);
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
function openModal(title, body, footer = '') {
  const dialog = $('#modal');
  if (dialog.open) { dialog.close(); modalCleanup?.(); modalCleanup = null; }
  dialog.classList.remove('material-dialog', 'asset-preview-dialog');
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
async function pickAttachment(expectedId, duplicateMode = 'reuse') {
  if (!expectedId) requireLibrary();
  const domain = state.selected?.data.domain || state.domain;
  if (native) {
    const file = await api('chooseFile');
    return file ? api('assetImport', { path: file, expectedId, domain, duplicateMode }) : null;
  }
  return new Promise((resolve, reject) => {
    const input = $('#file-input'); input.value = '';
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      try {
        const file = input.files[0]; if (!file) { resolve(null); return; }
        const params = new URLSearchParams({ domain, duplicateMode });
        if (expectedId) params.set('expectedId', expectedId);
        const response = await fetch(`/upload?${params}`, { method: 'POST', headers: { 'X-StudySelf-Token': token, 'X-Filename': encodeURIComponent(file.name) }, body: file });
        const result = await response.json(); if (result.error) throw new Error(result.error.message); resolve(result.value);
      } catch (error) { reject(error); }
    };
    input.click();
  });
}
async function importDroppedFile(file, domain) {
  if (native) {
    return window.desktop.importFile(file, domain);
  }
  if (file.size > 128 * 1024 * 1024) throw new Error('浏览器预览单个文件上限为 128 MiB；更大的文件请使用桌面版导入');
  const response = await fetch(`/upload?${new URLSearchParams({ domain })}`, { method: 'POST',
    headers: { 'X-StudySelf-Token': token, 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result.value;
}
function bindFileDrop(editor, tab, record) {
  const area = $('.editor-scroll');
  bindAttachmentDrop(editor, area, { recordId: record.id, fail: message => toast(message, true),
    validate: async id => {
      const asset = await api('record', { id });
      if (editor.isDestroyed || state.editor !== editor || currentTab() !== tab || state.selected?.id !== record.id) return null;
      if (!canManageAttachments() || asset?.type !== 'asset' || asset.deleted || asset.conflict) throw new Error('附件或笔记已发生变化，请刷新后重试');
      stash();
      if (asset.data.domain !== record.data.domain || !((tab.draft || state.selected.data).assetIds || []).includes(id)) throw new Error('此附件已不属于当前笔记，请重新关联后再插入');
      return asset;
    }
  });
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
    const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? editor.state.selection.to;
    importFiles(files, position);
  }, true);
  editor.view.dom.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length || event.defaultPrevented) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (importingFiles) { toast('上一批文件仍在导入，请完成后重试', true); return; }
    const html = event.clipboardData.getData('text/html'), text = event.clipboardData.getData('text/plain');
    if (html) {
      const cleaned = cleanNoteHtml(html);
      if (cleaned.trim()) editor.chain().focus().insertContent(cleaned).run();
    } else if (text) editor.chain().focus().insertContent({ type: 'text', text }).run();
    importFiles(files, editor.state.selection.to);
  }, true);
  function importFiles(files, position) {
    if (importingFiles) { toast('上一批文件仍在导入，请完成后重试', true); return; }
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
            const content = attachmentContent(asset, file.name);
            if (editor.isDestroyed) { failures.push(`${file.name}：已导入资料，原笔记已关闭，请从资料页插入`); continue; }
            editor.chain().insertContentAt(Math.min(position, editor.state.doc.content.size), content, { updateSelection: false }).run();
            imported++;
          } catch (error) { failures.push(`${file.name}：${error.message}`); }
        }
        toast(failures.length ? `已导入 ${imported} 个文件；${failures.join('；')}` : `已导入 ${imported} 个文件`, !!failures.length);
      } finally {
        editor.off('transaction', mapPosition); importingFiles--; indicator.remove();
      }
    })();
  }
}
async function openRecord(id) {
  if (importingFiles) { toast('文件仍在导入，请完成后切换笔记'); return; }
  await persist();
  state.editor?.destroy(); state.editor = null;
  const record = await api('record', { id }); if (!record) return;
  if (record.type === 'asset') { await assetUI.detail(id); return; }
  if (record.type === 'folder') return;
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
function applyOrderUpdates(updates = []) {
  for (const update of updates) {
    const tab = state.tabs.find(item => item.recordId === update.id);
    const sameHeads = heads => JSON.stringify([...(heads || [])].sort()) === JSON.stringify([...update.parents].sort());
    if (tab?.dirty && sameHeads(tab.baseHeads)) {
      tab.baseHeads = [...update.heads];
      tab.draft.noteOrder = update.noteOrder;
    }
    if (state.selected?.id === update.id && sameHeads(state.selected.heads)) {
      state.selected = { ...state.selected, heads: [...update.heads], data: { ...state.selected.data, noteOrder: update.noteOrder } };
    }
  }
}
async function moveKnowledgeNote({ id, parentNoteId, parents, notePlacement }) {
  if (importingFiles) throw new Error('文件仍在导入，请完成后调整层级');
  if (state.movingNote) throw new Error('正在保存层级调整，请稍后再拖动');
  state.movingNote = id;
  try { await applyKnowledgeMove({ id, parentNoteId, parents, notePlacement }); }
  finally { delete state.movingNote; }
}
async function applyKnowledgeMove({ id, parentNoteId, parents, notePlacement }) {
  const tab = state.tabs.find(item => item.recordId === id);
  if (tab) {
    if (['error', 'conflict'].includes(noteSaver.state(tab.id))) throw new Error('请先处理此笔记的保存失败或版本冲突，再调整层级');
    let record = state.selected?.id === id ? state.selected : null;
    if (!record && !tab.draft) {
      record = await api('record', { id });
      if (!record || JSON.stringify(record.heads) !== JSON.stringify(parents)) throw new Error('笔记已变化，请刷新后重新拖动');
    }
    if (!state.tabs.includes(tab)) throw new Error('笔记标签已关闭，请重新拖动');
    if (tab === currentTab()) stash();
    if (!tab.dirty) {
      tab.baseHeads = [...record.heads];
      tab.draft = { ...record.data };
    }
    const previousParent = tab.draft.parentNoteId || null;
    const previousOrder = tab.draft.noteOrder;
    tab.draft = { ...tab.draft, folderId: null, parentNoteId };
    if (previousParent !== parentNoteId) tab.draft.noteOrder = null;
    if (notePlacement) tab.notePlacement = notePlacement;
    tab.dirty = true;
    noteSaver.changed(tab.id);
    // Queue the placement with text edits so an in-flight autosave cannot restore the old parent.
    try { await noteSaver.flush(tab.id); }
    catch (error) {
      if (tab.draft?.parentNoteId === parentNoteId) tab.draft.parentNoteId = previousParent;
      if (tab.draft) {
        if (previousOrder === undefined) delete tab.draft.noteOrder;
        else tab.draft.noteOrder = previousOrder;
      }
      delete tab.notePlacement;
      await persist();
      throw error;
    }
    if (['error', 'conflict'].includes(noteSaver.state(tab.id))) throw new Error('层级调整尚未保存，当前编辑已保留');
  } else {
    const saved = await api('noteMove', { id, parentNoteId, parents, notePlacement });
    applyOrderUpdates(saved.placementUpdates);
  }
  state.knowledgeTree = await api('noteTree');
  const ancestors = new Set();
  let node = state.knowledgeTree.find(item => item.id === id);
  while (node?.parentNoteId && !ancestors.has(node.parentNoteId)) {
    ancestors.add(node.parentNoteId); node = state.knowledgeTree.find(item => item.id === node.parentNoteId);
  }
  state.collapsedNotes = state.collapsedNotes.filter(key => !ancestors.has(key));
  await refreshRows(); renderRecordList();
  const breadcrumb = $('.document-breadcrumb');
  if (breadcrumb && state.selected) {
    const data = currentTab()?.draft || state.selected.data;
    breadcrumb.innerHTML = `${esc(libraryName(data.domain))}<span>/</span>${esc(hierarchyUI.path(data.domain, data.parentNoteId))}<span>/</span>${typeLabel[state.selected.type] || '知识'}`;
  }
  await persist();
  toast(notePlacement ? '笔记位置与同级顺序已保存' : '笔记层级已保存，本机目录将自动按新层级整理');
}
async function showHistory() {
  const requestedId = state.selected?.id;
  if (!requestedId) return;
  if (currentTab()?.dirty) await saveNote();
  const history = await api('history', { id: requestedId });
  if (state.selected?.id !== requestedId) return;
  const record = state.selected, heads = [...record.heads];
  showHistoryBrowser({ history, current: record, editor: state.editor, openModal, safeHtml, esc, formatTime,
    hydrate: host => hydrateRich(host, mediaUrl), toast, restore: event => run(async () => {
    const accepted = await confirmBox('恢复历史版本', '<p>将创建一个新版本，当前内容和已有历史不会删除。</p>', '恢复');
    if (!accepted) return;
    if (state.selected?.id !== record.id) throw new Error('当前笔记已切换，请重新打开历史');
    state.selected = await api('restoreVersion', { id: record.id, revision: event.id, parents: heads });
    const tab = currentTab(); if (tab) { delete tab.draft; tab.dirty = false; }
    if (tab) await noteSaver.forget(tab.id);
    await render(); toast('已创建恢复版本');
    })
  });
}
async function clearTrash() {
  await persist();
  const preview = await api('trashPreview', { domain: state.domain || '' });
  const rows = items => items.slice(0, 30).map(item => `<li><strong>${esc(item.title)}</strong><span>${esc(typeLabel[item.type] || item.type)}${item.reason ? ` · ${esc(item.reason)}` : ''}</span></li>`).join('');
  const dialog = openModal('清空回收站', `<div class="trash-confirm">
    <p>范围：<strong>${esc(libraryName(preview.domain))}</strong></p>
    <p>可清空 <strong>${preview.eligible.length}</strong> 项，保留 <strong>${preview.blocked.length}</strong> 项。本次包含该范围内所有回收内容，不受搜索或分页限制。</p>
    ${preview.eligible.length ? `<p class="trash-warning">永久删除正文、修改历史及不再共用的系统托管原件，无法恢复。</p><p>将清理 ${preview.files.length} 个本地文件，预计释放 ${bytes(preview.estimatedBytes)}（不含数据库压缩）。</p><ul class="trash-preview-list">${rows(preview.eligible)}</ul>${preview.eligible.length > 30 ? `<p>另有 ${preview.eligible.length - 30} 项。</p>` : ''}` : '<p>当前没有可清空的内容。</p>'}
    ${preview.blocked.length ? `<details open><summary>以下内容暂时保留</summary><ul class="trash-preview-list">${rows(preview.blocked)}</ul>${preview.blocked.length > 30 ? `<p>另有 ${preview.blocked.length - 30} 项受保护。</p>` : ''}</details>` : ''}
    <p class="muted">共用资料和系统外导入源保留。删除凭据不含正文；其他电脑须升级后同步处理。同步目录的对应传输副本将清理，百度云端历史与回收站、迁移旧目录需要另行清理，不代表所有副本已擦除。</p>
    <p id="trash-clear-error" role="alert" hidden></p></div>`,
  `<button class="secondary" data-cancel>取消</button><button class="primary danger-action" id="trash-clear-confirm" ${preview.eligible.length ? '' : 'disabled'}>确认清空 ${preview.eligible.length} 项</button>`);
  $('[data-cancel]', dialog).onclick = () => dialog.close();
  const confirm = $('#trash-clear-confirm', dialog), errorBox = $('#trash-clear-error', dialog);
  confirm.onclick = async () => {
    confirm.disabled = true;
    confirm.textContent = '正在永久删除...';
    try {
      await persist();
      const result = await api('trashEmpty', { domain: preview.domain, token: preview.token, confirmed: true });
      const ids = new Set(result.ids), tabs = state.tabs.filter(tab => ids.has(tab.recordId));
      for (const tab of tabs) await noteSaver.forget(tab.id);
      if (ids.has(state.selected?.id)) { state.editor?.destroy(); state.editor = null; state.selected = null; state.selectedTab = null; }
      state.tabs = state.tabs.filter(tab => !ids.has(tab.recordId));
      dialog.close(); await persist(); await render();
      toast(`已永久删除 ${result.count} 项${result.skipped ? `，${result.skipped} 项受保护内容仍保留` : ''}${result.cleanup?.pending || result.cleanup?.database?.state === 'blocked' || result.cleanup?.transport?.state === 'blocked' ? '；部分清理未完成，请在系统设置中查看并重试' : ''}`);
    } catch (error) {
      errorBox.textContent = error.message; errorBox.hidden = false;
      confirm.disabled = false;
      confirm.textContent = `确认清空 ${preview.eligible.length} 项`;
    }
  };
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
function closeSourcePreview({ returnToList = true } = {}) {
  const preview = $('#source-preview'), id = preview?.dataset.asset;
  sourcePreviewController?.abort(); sourcePreviewController = null;
  if (preview) {
    for (const media of $$('video,audio', preview)) {
      media.pause(); media.removeAttribute('src'); media.load();
    }
    preview.replaceChildren(); delete preview.dataset.asset;
    if (returnToList) {
      const trigger = $$('[data-preview-asset]', preview.parentElement).find(item => item.dataset.previewAsset === id);
      trigger?.focus({ preventScroll: true });
      preview.parentElement.scrollTop = 0;
    }
  }
  if (sourcePreviewUrl) { URL.revokeObjectURL(sourcePreviewUrl); sourcePreviewUrl = null; }
}
async function previewAsset(id, { modal = false } = {}) {
  pendingPreview?.abort();
  const controller = new AbortController(), request = ++previewSerial;
  pendingPreview = controller;
  const sourceTarget = !modal && $('#source-pane:not([hidden]) #source-preview');
  const previousModalBody = $('#modal')?.firstElementChild;
  const current = () => request === previewSerial && !controller.signal.aborted
    && (!sourceTarget || sourceTarget.isConnected && sourceTarget.dataset.asset === id);
  if (sourceTarget) {
    closeSourcePreview({ returnToList: false });
    sourcePreviewController = controller;
    sourceTarget.dataset.asset = id;
  }
  const assets = await api('assets'), asset = assets.find(a => a.id === id);
  if (!current() || !sourceTarget && $('#modal')?.firstElementChild !== previousModalBody) return;
  if (!asset?.available) {
    const accepted = await confirmBox('原文件尚未就绪', '<p>本机尚未收到完整原文件。请检查来源电脑和网盘客户端的传输进度；分块到齐并校验后会自动关联。也可关联已有的本机文件。</p>', '关联本机文件');
    if (accepted) { await pickAttachment(id); await render(); }
    return;
  }
  let host, localUrl, dialog, loadingPreview = true;
  const reveal = () => {
    if (!sourceTarget?.isConnected || $('#source-pane')?.hidden) return;
    const scroll = sourceTarget.parentElement;
    scroll.scrollTop += sourceTarget.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  };
  const loading = '<div class="asset-preview-body" role="status">正在读取文件…</div>';
  if (sourceTarget) {
    if (sourcePreviewUrl) { URL.revokeObjectURL(sourcePreviewUrl); sourcePreviewUrl = null; }
    sourceTarget.innerHTML = `<div class="asset-preview-header"><strong>${esc(asset.data.title)}</strong><div>
      <button class="icon-button" data-preview-expand title="放大预览" aria-label="放大预览">${icon('maximize-2')}</button>
      <button class="icon-button" data-preview-close title="关闭预览，返回附件列表" aria-label="关闭预览">${icon('x')}</button></div></div>${loading}`;
    $('[data-preview-close]', sourceTarget).onclick = () => closeSourcePreview();
    $('[data-preview-expand]', sourceTarget).onclick = () => run(() => previewAsset(id, { modal: true }));
    host = $('.asset-preview-body', sourceTarget); redrawIcons(); reveal();
  } else {
    dialog = openModal(asset.data.title, loading); dialog.classList.add('asset-preview-dialog');
    host = $('.asset-preview-body', dialog);
    modalCleanup = () => {
      controller.abort();
      if (localUrl) URL.revokeObjectURL(localUrl);
      const video = host.querySelector('video');
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      host.replaceChildren();
    };
  }
  const active = () => current() && host.isConnected && (!dialog || dialog.open);
  const showFailure = message => {
    host.innerHTML = `<p class="asset-preview-error" role="alert">${esc(message)}</p><button class="secondary" data-preview-retry>${icon('refresh-cw')}重试</button>`;
    $('[data-preview-retry]', host).onclick = () => run(() => previewAsset(id, { modal }));
    redrawIcons();
  };
  const cancelled = () => {
    if (sourceTarget && loadingPreview && host.isConnected) showFailure('预览已取消，可重试');
  };
  controller.signal.addEventListener('abort', cancelled, { once: true });
  const createUrl = blob => {
    localUrl = URL.createObjectURL(blob);
    if (sourceTarget) sourcePreviewUrl = localUrl;
    return localUrl;
  };
  try {
    if (['video/mp4', 'video/webm', 'video/quicktime'].includes(asset.data.mime)) {
      host.innerHTML = `<video class="asset-video" controls playsinline preload="metadata" src="${esc(mediaUrl(id))}" aria-label="${esc(asset.data.title)}"></video>`;
      reveal(); return;
    }
    if (asset.data.size > 24 * 1024 * 1024) throw new Error('文件超过 24 MB，请使用本机应用查看');
    const value = await api('assetContent', { id });
    if (!active()) return;
    const binary = Uint8Array.from(atob(value.data), char => char.charCodeAt(0));
    if (isDocx(value)) {
      host.textContent = '正在解析 Word 文档…';
      const result = await readDocx(binary, controller.signal);
      if (!active()) return;
      host.innerHTML = `<p class="preview-format-note">阅读预览 · 排版可能与原文件不同${result.warnings ? ' · 部分内容需查看原文件' : ''}</p>
        <iframe class="docx-preview" sandbox="" referrerpolicy="no-referrer" title="${esc(value.filename)}"></iframe>`;
      $('iframe', host).srcdoc = docxPage(result.html);
    } else {
      const url = createUrl(new Blob([binary], { type: value.mime }));
      host.innerHTML = value.mime.startsWith('image/') && value.mime !== 'image/svg+xml' ? `<img class="asset-image" src="${url}" alt="${esc(value.filename)}">`
        : value.mime === 'application/pdf' ? `<iframe class="pdf-preview" src="${url}" title="${esc(value.filename)}"></iframe>`
        : value.mime.startsWith('text/') ? `<pre class="text-preview">${esc(new TextDecoder().decode(binary))}</pre>`
        : `<div class="section-empty">此格式暂不支持内置预览，请使用本机应用查阅。</div>`;
    }
    reveal();
  } catch (error) {
    if (!active() || error.name === 'AbortError') return;
    showFailure(error.message); reveal();
  } finally {
    loadingPreview = false;
    controller.signal.removeEventListener('abort', cancelled);
  }
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
    const dialog = openModal('插入表格', '<form id="table-picker"><div class="table-picker-grid"></div><div class="table-picker-fields"><label>行数<input name="rows" type="number" min="1" max="100" value="3" required></label><label>列数<input name="cols" type="number" min="1" max="30" value="3" required></label></div><label class="check-row"><input name="header" type="checkbox" checked>包含表头</label><div class="form-actions"><button class="primary" type="submit">插入表格</button></div></form>');
    const form = dialog.querySelector('form'), grid = form.querySelector('.table-picker-grid');
    const insertTable = (rows, cols) => {
      if (editor.isDestroyed) return;
      editor.chain().focus().insertContentAt(range, [createTable(editor.schema, rows, cols, form.elements.header.checked).toJSON(), { type: 'paragraph' }]).run();
      dialog.close();
    };
    for (let row = 1; row <= 6; row++) for (let col = 1; col <= 8; col++) {
      const cell = document.createElement('button'); cell.type = 'button'; cell.setAttribute('aria-label', `${row} 行 ${col} 列`); cell.title = `${row} 行 ${col} 列`;
      cell.onmouseenter = () => { [...grid.children].forEach((item, i) => item.classList.toggle('active', Math.floor(i / 8) < row && i % 8 < col)); };
      cell.onclick = () => insertTable(row, col); grid.append(cell);
    }
    form.onsubmit = event => { event.preventDefault(); const rows = Number(form.elements.rows.value), cols = Number(form.elements.cols.value); if (Number.isInteger(rows) && rows >= 1 && rows <= 100 && Number.isInteger(cols) && cols >= 1 && cols <= 30) insertTable(rows, cols); };
    return;
  }
  if (kind === 'callout') { if (editor.isActive('callout')) editor.chain().focus().lift('callout').run(); else editor.chain().focus().wrapIn('callout').run(); return; }
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
  ...draftUI.actions,
  ...assetUI.actions,
  ...syncUI.actions,
  ...hierarchyUI.actions,
  'toggle-navigation': toggleNavigation,
  'list-summary': () => {
    state.listSummary = !state.listSummary; rememberListSummary(); renderRecordList();
  },
  'note-view': async target => {
    if (state.view !== 'notes' || !['tree', 'list'].includes(target.dataset.mode)) return;
    state.noteView = target.dataset.mode;
    renderRecordList();
    await persist();
  },
  'knowledge-browse': async () => {
    if (['notes', 'drafts'].includes(state.view) && state.selected && $('.record-list')) {
      state.navigationHidden = false;
      $('#main').classList.remove('navigation-hidden');
      if (matchMedia('(max-width:900px)').matches) $('#main').classList.toggle('browse-folders');
      return;
    }
    await persist(); state.selected = null; state.selectedTab = null; state.view = state.view === 'drafts' ? 'drafts' : 'notes'; await render();
  },
  'library-storage-retry': async target => { await api('libraryDirectory', { id: target.dataset.library }); await render(); },
  'storage-copy': async () => { await navigator.clipboard.writeText(state.snapshot.localDataDirectory); toast('已复制存储路径'); },
  'deletion-retry': async () => { await api('deletionRetry'); await render(); toast('已重试，请查看各项清理状态'); },
  'storage-previous-clean': async () => {
    const plan = await api('storagePreviousPreview');
    const confirmed = await confirmBox('永久清理迁移旧副本', `<p class="storage-path">${esc(plan.directory)}</p><p>将删除 ${plan.files.length} 个系统托管文件（${bytes(plan.bytes)}），包括旧数据库及其笔记历史。额外文件保留，当前工作区不受影响。</p><p>此操作无法撤销。</p>`, '永久清理旧副本');
    if (!confirmed) return;
    await api('storagePreviousClean', { confirmed: true, token: plan.token }); await render(); toast('旧副本托管内容已清理，额外文件保留');
  },
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
  'agent-export': () => skillUI.export(),
  'skill-manage': () => $('#skill-management')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
  'update-manage': () => $('#upgrade-settings')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
  'agent-revoke': async target => {
    if (!await confirmBox('撤销 Agent 授权', '<p>撤销后，该凭证不能再读取或修改资料。</p>', '撤销')) return;
    await api('agentRevoke', { id: target.dataset.grant }); await render();
  },
  'load-more': async () => { state.listLimit += 150; await refreshRows(); renderRecordList(); },
  home: async () => { state.view = 'notes'; await render(); },
  new: async () => {
    if (!activeLibraries().length) { await editLibrary(); return; }
    const type = state.view === 'drafts' ? 'draft' : 'note';
    const create = async domain => {
      const record = await api('save', { type, data: { title: type === 'draft' ? '未命名草稿' : '未命名笔记', domain,
        ...(type === 'note' ? { parentNoteId: null } : {}), content: '', format: 'html', tags: [] } });
      await openRecord(record.id); $('#note-title')?.focus(); $('#note-title')?.select();
    };
    if (state.domain) { requireLibrary(); await create(state.domain); return; }
    const dialog = openModal(type === 'draft' ? '新建草稿' : '新建笔记', `<form id="new-record-form" class="settings-form"><label>知识库<select name="domain" required><option value="">选择知识库</option>${libraries().filter(item => !item.deleted && !item.conflict).map(item => `<option value="${esc(item.data.domain)}">${esc(item.data.title)}</option>`).join('')}</select></label><button class="primary" type="submit">创建</button></form>`);
    $('#new-record-form').onsubmit = event => {
      event.preventDefault();
      const form = event.target, domain = form.elements.domain.value, submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      run(async () => { try { await create(domain); dialog.close(); } finally { submit.disabled = false; } });
    };
  },
  save: saveNote,
  'toggle-source': () => setSourceVisible(!state.sourceVisible),
  'source-close': () => setSourceVisible(false),
  'source-retry': () => state.selected && renderSources(state.selected),
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
  'trash-empty': clearTrash,
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
        data: { ...state.selected.data, domain: data.domain,
          ...(state.selected.data.domain !== data.domain ? { folderId: null, ...(state.selected.type === 'note' ? { parentNoteId: null } : {}) } : {}),
          tags: data.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), sensitive: data.sensitive === 'on' } });
      const tab = currentTab(); if (tab) {
        if (tab.domain !== data.domain) { tab.conversationId = null; tab.prompt = ''; }
        tab.domain = data.domain; tab.draft = null;
      }
      state.domain = data.domain; dialog.close(); await render();
    }); };
  },
  annotate: addAnnotation,
  attach: async () => {
    const tab = currentTab();
    if (!canManageAttachments() || !tab || importingFiles) return;
    importingFiles++;
    try {
      const asset = await pickAttachment();
      if (!asset) return;
      await changeAttachments(tab, [...((tab.draft || state.selected.data).assetIds || []), asset.id]);
      await setSourceVisible(true);
      toast('已添加原附件');
    } finally { importingFiles--; }
  },
  'source-link': linkExistingAttachments,
  'source-unlink': unlinkAttachment,
  'asset-import': async () => { const asset = await pickAttachment(); if (asset) { await render(); toast(asset.reused ? '相同内容已存在，已复用原资料' : '原文件已导入本地'); } },
  'asset-import-separate': async () => {
    if (!await confirmBox('导入为独立资料', '<p>即使当前知识库已有相同文件，也会新增独立资料条目。名称、标签和引用可分别管理。</p>', '选择文件')) return;
    if (await pickAttachment(undefined, 'separate')) { await render(); toast('已导入独立资料'); }
  },
  'bind-asset': async target => { if (await pickAttachment(target.dataset.asset)) { const detail = $('#modal').open; await render(); if (detail) await assetUI.detail(target.dataset.asset); } },
  'preview-asset': async target => previewAsset(target.dataset.asset),
  'asset-hydrate': async target => {
    const detail = $('#modal').open;
    await syncUI.actions['asset-hydrate'](target);
    if (detail) await assetUI.detail(target.dataset.asset);
  },
  'pin-asset': async target => { const detail = $('#modal').open; await api('assetPin', { id: target.dataset.asset, pinned: target.dataset.pinned !== 'true' }); await render(); if (detail) await assetUI.detail(target.dataset.asset); },
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
    if (content?.trim()) { const proposal = await api('propose', { title: '待确认整理方案', domain: state.domain,
      items: [{ title: content.split('\n')[0].slice(0, 50), content }] }); await openRecord(proposal.id); }
  },
  approve: async () => {
    const itemIds = $$('[data-proposal-item]:checked:not(:disabled)').map(el => el.dataset.proposalItem);
    if (!itemIds.length) throw new Error('请选择待确认的内容');
    const record = state.selected;
    await persist();
    const saved = await api('approve', { id: record.id, parents: record.heads, itemIds });
    if (state.selected?.id === record.id) { state.selected = saved; await render(); }
    toast('选定部分已入库，关联草稿处理状态已更新');
  },
  'proposal-edit': async () => {
    const record = state.selected, selectedId = $('[data-proposal-item]:checked:not(:disabled)')?.dataset.proposalItem;
    const item = record.data.items.find(i => i.id === selectedId) || record.data.items.find(i => i.status !== 'accepted');
    if (!item) throw new Error('没有待修改的部分');
    const dialog = openModal('修改待确认内容', `<form id="proposal-edit-form" class="settings-form"><label>标题<input name="title" required value="${esc(item.data.title)}"></label><label>目标知识库<select name="domain" required>${domainOptions(item.data.domain, false)}</select></label><label>上级笔记<select name="parentNoteId">${hierarchyUI.options(item.data.domain, item.data.parentNoteId, item.targetId, record.data.items)}</select></label><label>内容<textarea name="content" rows="8">${esc(item.data.content)}</textarea></label><button class="primary" type="submit">保存方案</button></form>`);
    $('#proposal-edit-form select[name="domain"]').onchange = event => {
      $('#proposal-edit-form select[name="parentNoteId"]').innerHTML = hierarchyUI.options(event.target.value, '', item.targetId, record.data.items);
    };
    $('#proposal-edit-form').onsubmit = event => {
      event.preventDefault(); run(async () => {
        const values = Object.fromEntries(new FormData(event.target));
        values.parentNoteId ||= null;
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
  for (const menu of $$('.source-attachment-actions[open]')) {
    if (!menu.contains(event.target) || event.target.closest('[data-action]')) menu.open = false;
  }
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
  if (event.key === 'Escape') {
    const menu = $('.source-attachment-actions[open]');
    if (menu) { event.preventDefault(); menu.open = false; $('summary', menu).focus(); return; }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(saveNote); }
});
window.addEventListener('beforeunload', event => {
  if (importingFiles || state.tabs.some(t => t.dirty) || skillUI.dirty()) { event.preventDefault(); event.returnValue = ''; }
});
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
});
async function init() {
  await loadState();
  try { state.listSummary = localStorage.getItem('studyself-list-summary') === 'true'; } catch {}
  state.domain = state.snapshot.workspace.domain || '';
  state.collapsedNotes = state.snapshot.workspace.collapsedNotes || [];
  state.noteView = state.snapshot.workspace.noteView === 'list' ? 'list' : 'tree';
  state.sourceVisible = state.snapshot.workspace.sourceVisible === true;
  await restoreWorkspaceTabs(state.snapshot.workspace);
  const tab = currentTab();
  if (tab) {
    state.selected = await api('record', { id: tab.recordId }); state.domain = tab.domain || '';
    state.view = ({ draft: 'drafts', proposal: 'proposals' })[state.selected?.type || tab.recordType] || 'notes';
  }
  if (state.domain && !activeLibraries().some(item => item.data.domain === state.domain)) state.domain = '';
  await render();
  await updateUI.start();
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
