export function createHierarchyUI({ state, api, esc, icon, button, render, persist, saveNote, openModal, toast, run, openRecord, libraryName }) {
  const $ = selector => document.querySelector(selector);
  const notes = domain => state.knowledgeTree.filter(item => item.data.domain === domain);
  function options(domain, selected = '', excluded, proposed = []) {
    const candidates = notes(domain).filter(item => item.id !== excluded && !item.issue);
    const descendants = new Set([excluded]);
    for (let i = 0; i < 16; i++) for (const item of candidates) if (descendants.has(item.data.parentNoteId)) descendants.add(item.id);
    const pending = proposed.filter(item => item.status !== 'accepted' && item.targetId !== excluded && item.data.domain === domain
      && !candidates.some(note => note.id === item.targetId));
    return `<option value="">知识库顶层</option>${candidates.filter(item => !descendants.has(item.id)).map(item =>
      `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(item.path.join(' / '))}</option>`).join('')}${pending.map(item =>
      `<option value="${item.targetId}" ${item.targetId === selected ? 'selected' : ''}>${esc(item.data.title)}（本方案待创建）</option>`).join('')}`;
  }
  function tree() {
    if (state.view !== 'notes') return '';
    const nodes = state.knowledgeTree.filter(item => !state.domain || item.data.domain === state.domain);
    const byId = new Map(nodes.map(item => [item.id, item])), collapsed = new Set(state.collapsedNotes || []);
    const matches = new Set(state.rows.map(item => item.id)), included = new Set();
    if (state.query) for (const id of matches) {
      let node = byId.get(id);
      while (node && !included.has(node.id)) { included.add(node.id); node = byId.get(node.parentNoteId); }
    }
    const children = new Set(nodes.map(item => item.parentNoteId).filter(Boolean));
    const visible = node => {
      if (state.query) return included.has(node.id);
      const seen = new Set(); let parent = node.parentNoteId;
      while (parent && !seen.has(parent)) {
        if (collapsed.has(parent)) return false;
        seen.add(parent); parent = byId.get(parent)?.parentNoteId;
      }
      return true;
    };
    const groups = new Map();
    for (const item of nodes.filter(visible)) {
      if (!groups.has(item.data.domain)) groups.set(item.data.domain, []);
      groups.get(item.data.domain).push(item);
    }
    return `<div class="folder-browser knowledge-browser">
      <div class="folder-tree" role="tree" aria-label="笔记知识体系">
      ${[...groups].map(([domain, items]) => `${!state.domain ? `<div class="tree-library-label" data-note-drop-root="${esc(domain)}">${esc(libraryName(domain))}</div>` : ''}${items.map(item => `<div class="folder-line ${state.query && !matches.has(item.id) ? 'tree-context' : ''}" style="padding-left:${Math.min(item.depth * 12, 108)}px">
      ${children.has(item.id) ? button(!state.query && collapsed.has(item.id) ? 'chevron-right' : 'chevron-down', 'note-toggle', !state.query && collapsed.has(item.id) ? '展开下级笔记' : '收起下级笔记', `data-note="${item.id}" aria-expanded="${!!state.query || !collapsed.has(item.id)}" ${state.query ? 'disabled' : ''}`) : '<span class="tree-spacer"></span>'}
      <button class="folder-node ${state.selected?.id === item.id ? 'active' : ''}" data-record="${item.id}" data-action="tree-open" data-note="${item.id}" data-note-drag draggable="${!item.issue && !item.conflict}" role="treeitem" aria-level="${item.depth + 1}" aria-selected="${state.selected?.id === item.id}" title="${esc(item.issue || item.path.join(' / '))}">${icon(item.issue ? 'triangle-alert' : 'file-text')}<span>${esc(item.data.title)}</span></button>
      ${button('plus', 'note-child', `新建下级笔记：${item.data.title}`, `data-note="${item.id}" ${item.issue ? 'disabled' : ''}`)}</div>`).join('')}`).join('') || `<div class="list-empty">${state.query ? '没有匹配的笔记' : '尚无笔记'}</div>`}</div></div>`;
  }
  async function move() {
    await saveNote();
    const record = await api('record', { id: state.selected.id });
    const dialog = openModal('调整笔记层级', `<form id="note-parent-form" class="settings-form"><label>上级笔记<select name="parentNoteId">${options(record.data.domain, record.data.parentNoteId, record.id)}</select></label><button class="primary" type="submit">保存层级</button></form>`);
    $('#note-parent-form').onsubmit = event => {
      event.preventDefault();
      const parentNoteId = new FormData(event.target).get('parentNoteId') || null;
      run(async () => {
        await api('noteMove', { id: record.id, parentNoteId, parents: record.heads });
        dialog.close(); await openRecord(record.id); toast('笔记层级已更新');
      });
    };
  }
  const actions = {
    'tree-open': target => openRecord(target.dataset.note),
    'note-toggle': async target => {
      const ids = new Set(state.collapsedNotes || []);
      if (ids.has(target.dataset.note)) ids.delete(target.dataset.note); else ids.add(target.dataset.note);
      state.collapsedNotes = [...ids]; await persist(); await render();
    },
    'note-child': async target => {
      await saveNote();
      const parent = await api('record', { id: target.dataset.note || state.selected.id });
      const record = await api('save', { type: 'note', data: { title: '未命名笔记', domain: parent.data.domain,
        parentNoteId: parent.id, content: '', format: 'html', sensitive: parent.data.sensitive } });
      state.collapsedNotes = (state.collapsedNotes || []).filter(id => id !== parent.id);
      await openRecord(record.id); $('#note-title')?.focus(); $('#note-title')?.select();
    },
    'note-parent': move,
    'storage-retry': async () => { await api('localHierarchyRefresh'); await render(); toast('本地文件维护状态已更新'); }
  };
  return { tree, options, actions,
    path: (domain, id) => notes(domain).find(item => item.id === id)?.path.join(' / ') || (id ? '上级笔记待处理' : '知识库顶层'),
    proposalPath: (items, item) => {
      const seen = new Set([item.targetId]), labels = []; let id = item.data.parentNoteId;
      while (id && !seen.has(id) && seen.size < 17) {
        seen.add(id);
        const parent = items.find(entry => entry.targetId === id);
        if (!parent) { labels.unshift(notes(item.data.domain).find(note => note.id === id)?.path.join(' / ') || '上级笔记待处理'); break; }
        labels.unshift(parent.data.title); id = parent.data.parentNoteId;
      }
      return labels.join(' / ') || '知识库顶层';
    }
  };
}
