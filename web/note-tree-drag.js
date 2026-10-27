const dragType = 'application/x-fengzaiy-note-tree';

export function createNoteTreeDrag({ state, move, render, run, toast }) {
  let session, hint, marked, scrollTimer;
  const nodes = () => session?.nodes || state.knowledgeTree;
  const nodeFor = id => nodes().find(node => node.id === id);
  const dropClasses = ['note-drop-target', 'note-drop-invalid', 'note-drop-before', 'note-drop-after'];
  function placement(target, clientY) {
    const root = target?.closest('[data-note-drop-root]');
    const control = target?.closest('[data-note-drag]');
    const source = nodeFor(session?.id), destination = control && nodeFor(control.dataset.note);
    const domain = root?.dataset.noteDropRoot || destination?.data.domain;
    if (!source || (!root && !destination)) return null;
    const box = control?.getBoundingClientRect();
    const ratio = box ? (clientY - box.top) / box.height : 0.5;
    const side = box && ratio < 0.28 ? 'before' : box && ratio > 0.72 ? 'after' : null;
    const parent = side ? nodeFor(destination.parentNoteId) : destination;
    const result = { element: root || control, parentNoteId: parent?.id || null, domain, side };
    if (source.data.domain !== domain) return { ...result, error: '不能拖到其他知识库' };
    if (source.id === destination?.id) return { ...result, error: '不能移到自身或下级笔记' };
    if (source.issue || source.conflict || destination?.issue || destination?.conflict || parent?.issue || parent?.conflict) return { ...result, error: '请先处理笔记的层级或版本冲突' };
    const seen = new Set();
    let ancestor = parent;
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === source.id) return { ...result, error: '不能移到自身或下级笔记' };
      seen.add(ancestor.id); ancestor = nodeFor(ancestor.parentNoteId);
    }
    const descendants = new Set([source.id]);
    for (let i = 0; i < 16; i++) for (const node of nodes()) {
      if (descendants.has(node.parentNoteId)) descendants.add(node.id);
    }
    const height = Math.max(0, ...nodes().filter(node => descendants.has(node.id)).map(node => node.depth - source.depth));
    if ((parent ? parent.depth + 1 : 0) + height >= 16) return { ...result, error: '笔记最多支持 16 层' };
    if (side) {
      const siblings = nodes().filter(node => node.data.domain === domain && node.parentNoteId === result.parentNoteId);
      const rest = siblings.filter(node => node.id !== source.id), index = rest.findIndex(node => node.id === destination.id) + (side === 'after' ? 1 : 0);
      const desired = rest.map(node => node.id); desired.splice(index, 0, source.id);
      if (JSON.stringify(siblings.map(node => node.id)) === JSON.stringify(desired)) return { ...result, error: '笔记已在此位置' };
      result.notePlacement = { targetId: destination.id, side,
        context: rest.map(node => ({ id: node.id, heads: [...node.heads] })).sort((a, b) => a.id.localeCompare(b.id)) };
      return { ...result, label: `同级：放在「${destination.data.title}」${side === 'before' ? '前面' : '后面'}` };
    }
    if ((source.data.parentNoteId || null) === result.parentNoteId) return { ...result, error: '笔记已在此层级' };
    return { ...result, label: parent ? `移到「${parent.data.title}」下级` : '移到知识库顶层' };
  }
  function clear() {
    const active = !!session;
    session = null; clearInterval(scrollTimer);
    marked?.classList.remove(...dropClasses); marked = null;
    hint?.remove(); hint = null;
    document.body.classList.remove('note-tree-dragging');
    document.querySelectorAll('.note-drag-source').forEach(node => node.classList.remove('note-drag-source'));
    if (active) render();
  }
  document.addEventListener('dragstart', event => {
    const control = event.target.closest('[data-note-drag]');
    if (!control || !event.dataTransfer) return;
    if (state.movingNote) { event.preventDefault(); toast('正在保存层级调整，请稍后再拖动'); return; }
    const source = nodeFor(control.dataset.note);
    if (!source || source.conflict || source.issue || control.draggable !== true) { event.preventDefault(); return; }
    session = { id: source.id, parents: [...source.heads], nodes: state.knowledgeTree, token: crypto.randomUUID() };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(dragType, session.token);
    control.classList.add('note-drag-source');
    document.body.classList.add('note-tree-dragging');
    hint = document.createElement('div'); hint.className = 'note-tree-drop-hint'; hint.setAttribute('role', 'status'); hint.hidden = true;
    document.body.append(hint);
  });
  document.addEventListener('dragover', event => {
    if (!session || ![...(event.dataTransfer?.types || [])].includes(dragType)) return;
    marked?.classList.remove(...dropClasses); marked = null;
    clearInterval(scrollTimer);
    const scroll = event.target.closest('.folder-tree');
    if (scroll) {
      const box = scroll.getBoundingClientRect();
      const step = event.clientY < box.top + 32 ? -10 : event.clientY > box.bottom - 32 ? 10 : 0;
      if (step) scrollTimer = setInterval(() => { if (scroll.isConnected) scroll.scrollTop += step; }, 30);
    }
    const destination = placement(event.target, event.clientY);
    if (!destination) {
      if (scroll) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; }
      hint.hidden = true; return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = destination.error ? 'none' : 'move';
    marked = destination.element;
    marked.classList.add(destination.error ? 'note-drop-invalid' : destination.side ? `note-drop-${destination.side}` : 'note-drop-target');
    hint.textContent = destination.error || destination.label;
    hint.classList.toggle('invalid', !!destination.error); hint.hidden = false;
    hint.style.left = `${Math.max(8, Math.min(event.clientX + 14, innerWidth - 292))}px`;
    hint.style.top = `${Math.min(event.clientY + 18, innerHeight - 48)}px`;
  });
  document.addEventListener('drop', event => {
    if (!session) return;
    const source = session, destination = placement(event.target, event.clientY);
    const valid = event.dataTransfer?.getData(dragType) === source.token;
    event.preventDefault(); event.stopPropagation(); clear();
    if (!valid || !destination) return;
    if (destination.error) { toast(destination.error, true); return; }
    run(async () => {
      try { await move({ id: source.id, parents: source.parents, parentNoteId: destination.parentNoteId, notePlacement: destination.notePlacement }); }
      catch (error) {
        if (error.code === 'CONFLICT') throw new Error('笔记已变化，层级调整未保存；当前编辑仍保留，请先处理版本冲突');
        throw error;
      }
    });
  }, true);
  document.addEventListener('dragend', clear);
  document.addEventListener('keydown', event => { if (session && event.key === 'Escape') clear(); });
  window.addEventListener('blur', clear);
  return { active: () => !!session };
}
