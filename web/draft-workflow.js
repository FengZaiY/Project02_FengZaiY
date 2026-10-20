export const processingLabels = { pending: '待处理', partial: '部分处理', processed: '已处理' };

export function createDraftUI({ state, api, esc, icon, openModal, saveNote, persist, openRecord, hierarchyUI, libraries, run, toast, redrawIcons }) {
  const $ = (selector, root = document) => root.querySelector(selector);
  async function refresh(record) {
    const host = $('#draft-workflow');
    if (!host || record.type !== 'draft') return;
    const workflow = await api('draftWorkflow', { id: record.id });
    if (!host.isConnected || state.selected?.id !== record.id) return;
    const status = state.tabs.some(tab => tab.recordId === record.id && tab.dirty) ? 'pending' : workflow?.status || 'pending';
    host.innerHTML = `<span class="pill ${status === 'processed' ? 'green' : ''}">${processingLabels[status]}</span>
      ${!record.deleted && !record.conflict ? `<button class="secondary compact" data-action="draft-archive" ${status === 'processed' ? 'disabled title="当前版本已处理，可查看关联结果"' : ''}>${icon('archive')}归档为正式笔记</button>` : ''}
      <button class="text-button" data-action="draft-results">${icon('list-checks')}整理后归档${workflow?.results.length ? ` · ${workflow.results.length} 项结果` : ''}</button>`;
    redrawIcons();
  }
  async function archive() {
    const id = state.selected?.id;
    await saveNote();
    if (state.selected?.id !== id || state.tabs.some(tab => tab.recordId === id && tab.dirty)) throw new Error('草稿仍有新编辑，请保存后再归档');
    const draft = await api('record', { id });
    if (state.selected?.id !== id) return;
    const choices = libraries().filter(item => !item.deleted && !item.conflict);
    const dialog = openModal('归档为正式笔记', `<form id="draft-archive-form" class="settings-form">
      <label>知识库<select name="domain" required>${choices.map(item => `<option value="${esc(item.data.domain)}" ${item.data.domain === draft.data.domain ? 'selected' : ''}>${esc(item.data.title)}</option>`).join('')}</select></label>
      <label>上级笔记<select name="parentNoteId"></select></label>
      <p class="muted">保留正文、附件和出处；原草稿及修改历史仍可查阅。</p>
      <p class="draft-archive-error" role="alert"></p><button type="submit" class="primary">确认归档</button></form>`);
    const form = $('#draft-archive-form');
    const updateParents = () => { form.elements.parentNoteId.innerHTML = hierarchyUI.options(form.elements.domain.value); };
    form.elements.domain.onchange = updateParents; updateParents();
    form.onsubmit = async event => {
      event.preventDefault();
      const submit = $('button[type="submit"]', form); submit.disabled = true;
      const domain = form.elements.domain.value, parentNoteId = form.elements.parentNoteId.value || null;
      try {
        await persist();
        if (!dialog.open || !form.isConnected) return;
        if (state.tabs.some(tab => tab.recordId === id && tab.dirty)) throw new Error('草稿有新编辑，请先保存后重新归档');
        const note = await api('draftArchive', { id, parents: draft.heads, domain, parentNoteId });
        if (dialog.open && form.isConnected && state.selected?.id === id) { dialog.close(); await openRecord(note.id); }
        toast('已归档为正式笔记，原草稿已标为已处理');
      } catch (error) { $('.draft-archive-error', form).textContent = error.message; }
      finally { submit.disabled = false; }
    };
  }
  async function results() {
    const record = state.selected;
    const workflow = await api('draftWorkflow', { id: record.id });
    if (state.selected?.id !== record.id) return;
    const dirty = state.tabs.some(tab => tab.recordId === record.id && tab.dirty);
    const links = [...new Map((workflow?.results || []).map(result => [`${result.noteId}:${result.versionId || ''}`, result])).values()];
    const proposals = [...new Map((workflow?.proposals || []).map(proposal => [proposal.id, proposal])).values()];
    const dialog = openModal('整理后归档', `<div class="draft-results">
      <div class="draft-result-heading"><span class="pill">${dirty ? '待处理 · 待保存' : processingLabels[workflow?.status || 'pending']}</span><button class="secondary" id="copy-draft-request">${icon('copy')}复制整理请求</button></div>
      <h3>关联方案</h3>${proposals.length ? proposals.map(item => `<button class="draft-result" data-draft-open="${item.id}"><strong>${esc(item.title)}</strong><small>${item.accepted}/${item.total} 项已确认${item.current ? '' : ' · 来源已更新'}${item.conflict ? ' · 存在冲突' : ''}${item.deleted ? ' · 已回收' : ''}</small></button>`).join('') : '<p class="muted">暂无关联方案。请让外部 Agent 基于此草稿提交整理方案。</p>'}
      <h3>归档结果</h3>${links.length ? links.map(item => `<button class="draft-result" data-draft-open="${item.noteId}"><strong>${esc(item.title)}</strong><small>${item.direct ? '直接归档' : '方案已确认'}${item.current ? '' : ' · 对应旧草稿'}${item.available ? '' : ' · 结果缺失、已回收或有冲突'}</small></button>`).join('') : '<p class="muted">尚无已确认的整理结果。</p>'}</div>`);
    for (const button of dialog.querySelectorAll('[data-draft-open]')) button.onclick = () => run(async () => {
      const result = await api('record', { id: button.dataset.draftOpen });
      if (!result) throw new Error('关联内容尚未同步到本机或已经清空');
      dialog.close(); await openRecord(result.id);
    });
    $('#copy-draft-request').onclick = () => run(async () => {
      if (state.tabs.some(tab => tab.recordId === record.id && tab.dirty)) throw new Error('请先保存草稿，再复制整理请求');
      await navigator.clipboard.writeText(`请读取 StudySelf 的最新 Skill 和整理偏好，整理草稿 ${record.id}（知识库 ${record.data.domain}）。先读取最新正文与 heads，再在方案每个相关项的 draftRefs 中填写 {id, versionId}。当前所见版本：${record.heads.join(', ')}。保留出处、附件及不同观点；列出全部待处理内容，等待我部分或全部确认，不直接归档。`);
      toast('整理请求已复制');
    });
    redrawIcons();
  }
  return { refresh, actions: { 'draft-archive': archive, 'draft-results': results } };
}
