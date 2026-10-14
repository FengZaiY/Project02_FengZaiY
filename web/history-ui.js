import { diffBlocks } from './editor-text.js';

export function showHistoryBrowser({ history, current, editor, openModal, safeHtml, esc, formatTime, hydrate, restore, toast }) {
  const dialog = openModal('修改历史与差异', '<div class="history-browser"><nav class="history-versions" aria-label="修改记录"></nav><section class="history-detail"></section></div>');
  dialog.classList.add('history-dialog');
  dialog.addEventListener('close', () => dialog.classList.remove('history-dialog'), { once: true });
  const list = dialog.querySelector('.history-versions'), detail = dialog.querySelector('.history-detail');
  let selected = history[0], against = 'parent', tab = 'diff';
  let bookmark = editor && !editor.isDestroyed ? editor.state.selection.getBookmark() : null;
  const mapBookmark = ({ transaction }) => { if (bookmark) bookmark = bookmark.map(transaction.mapping); };
  editor?.on('transaction', mapBookmark);
  dialog.addEventListener('close', () => editor?.off('transaction', mapBookmark), { once: true });
  const byId = new Map(history.map(event => [event.id, event]));
  const blocks = data => {
    const template = document.createElement('template'); template.innerHTML = safeHtml(data.content || '', data.format);
    return [...template.content.childNodes].map(node => node.outerHTML || esc(node.textContent)).filter(Boolean);
  };
  const buttons = new Map();
  for (const event of history) {
    const button = document.createElement('button'); button.dataset.historyRevision = event.id;
    button.innerHTML = `${esc(formatTime(event.createdAt))}<small>${event.deleted ? '删除记录' : event.parents.length > 1 ? '合并修改' : '内容修改'} · ${esc(event.deviceId.slice(0, 8))}</small>`;
    button.onclick = () => { selected = event; draw(); }; list.append(button); buttons.set(event.id, button);
  }
  function draw() {
    if (!selected) { detail.textContent = '暂无修改记录'; return; }
    buttons.forEach((button, id) => button.setAttribute('aria-pressed', String(id === selected.id)));
    if (!['parent', 'current', ...selected.parents].includes(against)) against = 'parent';
    const base = against === 'current' ? current : byId.get(against === 'parent' ? selected.parents[0] : against);
    const before = blocks(base?.data || {}), after = blocks(selected.data), changes = diffBlocks(before, after);
    const metadata = ['title', 'tags', 'domain', 'parentNoteId', 'sourceIds', 'assetIds', 'sensitive'];
    const names = { title: '标题', tags: '标签', domain: '知识库', parentNoteId: '上级笔记', sourceIds: '出处', assetIds: '附件', sensitive: '敏感标记' };
    const differences = metadata.filter(key => JSON.stringify(base?.data[key] ?? null) !== JSON.stringify(selected.data[key] ?? null));
    detail.innerHTML = `<div class="history-controls"><select aria-label="历史对比基准"><option value="parent">与前一修改比较</option><option value="current">与当前内容比较</option>${selected.parents.length > 1 ? selected.parents.map((id, i) => `<option value="${id}">父记录 ${i + 1}</option>`).join('') : ''}</select><button data-history-tab="diff" aria-pressed="${tab === 'diff'}">差异</button><button data-history-tab="preview" aria-pressed="${tab === 'preview'}">完整内容</button></div>
      <div class="history-meta-changes">${differences.length ? differences.map(key => `${names[key]}：${esc(JSON.stringify(base?.data[key] ?? null))} → ${esc(JSON.stringify(selected.data[key] ?? null))}`).join('\n') : '属性未改变'}</div>
      <div class="history-diff-summary">${against === 'current' ? '以打开历史时的当前内容为基准，显示所选历史的差异' : '显示所选修改相对基准的差异'} · 新增 ${changes.filter(c => c.kind === 'added').length} 段 · 移除 ${changes.filter(c => c.kind === 'removed').length} 段</div>
      <div class="history-preview">${tab === 'preview' ? `<div class="prose">${safeHtml(selected.data.content || '', selected.data.format)}</div>` : changes.map((item, i) => `<section class="history-block ${item.kind}"><label><input type="checkbox" data-history-block="${i}">${({ same: '未改变', removed: '基准中的内容（所选记录已移除）', added: '所选记录新增的内容' })[item.kind]}</label><div class="prose">${item.value}</div></section>`).join('')}</div>
      <div class="form-actions">${editor ? '<button class="secondary" id="history-recover-parts">将勾选内容插入正文</button>' : ''}<button class="primary" id="history-restore">恢复此版本</button></div>`;
    const select = detail.querySelector('select'); select.value = against;
    if (!select.value) { against = 'parent'; select.value = 'parent'; }
    select.onchange = () => { against = select.value; draw(); };
    detail.querySelectorAll('[data-history-tab]').forEach(button => { button.onclick = () => { tab = button.dataset.historyTab; draw(); }; });
    hydrate(detail.querySelector('.history-preview'));
    detail.querySelector('#history-restore').onclick = () => restore(selected);
    const recover = detail.querySelector('#history-recover-parts');
    if (recover) {
      recover.disabled = tab === 'preview';
      recover.onclick = () => {
        const content = [...detail.querySelectorAll('[data-history-block]:checked')].map(input => changes[Number(input.dataset.historyBlock)].value).join('');
        if (!content) { toast('请先勾选需要取回的内容'); return; }
        if (editor.isDestroyed || !bookmark) { toast('当前笔记已关闭，请重新打开历史', true); return; }
        const selection = bookmark.resolve(editor.state.doc);
        // Insert at the end of the bookmarked selection; never replace current text.
        editor.chain().focus().insertContentAt(selection.to, content).run();
        dialog.close(); toast('已插入正文，可撤销；修改将按正常流程保存');
      };
    }
  }
  draw();
}
