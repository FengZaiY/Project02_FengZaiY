import { Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import { validateLayout } from '../src/core/rich-schema.mjs';

const defaults = () => ({ width: 100, height: null, align: 'left' });
const movable = node => ['richBlock', 'layoutBlock'].includes(node.type.name);
const drags = new WeakMap();
const blocks = new WeakMap();
export const layoutAttributes = () => ({
  layout: {
    default: null,
    parseHTML: element => element.hasAttribute('data-ss-layout') ? validateLayout(JSON.parse(element.getAttribute('data-ss-layout'))) : null,
    renderHTML: attrs => attrs.layout ? { 'data-ss-layout': JSON.stringify(validateLayout(attrs.layout)) } : {}
  }
});
export function applyLayout(dom, value) {
  const layout = value ? validateLayout(value) : defaults();
  dom.style.setProperty('--block-width', `${layout.width}%`);
  dom.style.setProperty('--block-weight', String(layout.width));
  dom.style.setProperty('--block-height', layout.height === null ? 'auto' : `${layout.height}px`);
  dom.dataset.blockAlign = layout.align;
  dom.classList.toggle('block-fixed-height', layout.height !== null);
  fitMedia(dom);
}
export function fitMedia(dom) {
  const media = dom.querySelector(':scope > .rich-content > img,:scope > .rich-content > video');
  const width = media?.naturalWidth || media?.videoWidth, height = media?.naturalHeight || media?.videoHeight;
  const bound = parseFloat(dom.style.getPropertyValue('--block-height'));
  dom.style.setProperty('--media-max-width', width && height && bound ? `${bound * width / height}px` : '100%');
}
function groups(editor) {
  const result = [];
  editor.state.doc.forEach((node, pos) => {
    const children = [];
    if (node.type.name === 'blockRow') node.forEach((child, offset) => children.push({ node: child, pos: pos + 1 + offset }));
    result.push({ node, pos, children });
  });
  return result;
}
function replaceGroups(editor, list, selectedNode) {
  const nodes = list.flatMap(item => item.children.length ? item.children.length === 1 ? [item.children[0].node]
    : [editor.schema.nodes.blockRow.create(null, item.children.map(child => child.node))] : item.node ? [item.node] : []);
  if (!nodes.length) nodes.push(editor.schema.nodes.paragraph.create());
  const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, Fragment.fromArray(nodes));
  tr.doc.descendants((node, pos) => {
    if (node === selectedNode) tr.setSelection(NodeSelection.create(tr.doc, pos));
  });
  editor.view.dispatch(tr.scrollIntoView());
}
export function moveBlock(editor, from, to, side) {
  const list = groups(editor);
  const units = list.flatMap(group => group.children.length ? group.children : [group]);
  const source = units.find(item => item.pos === from), target = units.find(item => item.pos === to);
  if (!source || !target || source === target || !movable(source.node)) return false;
  if (['left', 'right'].includes(side) && !movable(target.node)) return false;
  const sourceGroup = list.find(group => group === source || group.children.includes(source));
  if (['left', 'right'].includes(side)) {
    const targetGroup = list.find(group => group === target || group.children.includes(target));
    const start = Math.min(list.indexOf(sourceGroup), list.indexOf(targetGroup)), end = Math.max(list.indexOf(sourceGroup), list.indexOf(targetGroup));
    if (list.slice(start + 1, end).every(group => group.node.type.name === 'paragraph' && !group.node.content.size)) list.splice(start + 1, Math.max(0, end - start - 1));
  }
  if (sourceGroup === source) list.splice(list.indexOf(sourceGroup), 1);
  else {
    sourceGroup.children.splice(sourceGroup.children.indexOf(source), 1);
    if (!sourceGroup.children.length) list.splice(list.indexOf(sourceGroup), 1);
  }
  const targetGroup = list.find(group => group === target || group.children.includes(target));
  if (['left', 'right'].includes(side)) {
    if (!targetGroup.children.length) targetGroup.children = [{ node: targetGroup.node, pos: targetGroup.pos }];
    const index = targetGroup.children.findIndex(item => item.node === target.node);
    targetGroup.children.splice(index + (side === 'right' ? 1 : 0), 0, { node: source.node, pos: from });
  } else list.splice(list.indexOf(targetGroup) + (side === 'after' ? 1 : 0), 0, { node: source.node, children: [] });
  replaceGroups(editor, list, source.node);
  return true;
}
function dropTarget(editor, source, x, y) {
  const area = editor.view.dom.closest('.editor-scroll'), bounds = area.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  const element = document.elementFromPoint(x, y)?.closest('.rich-block,.layout-block');
  if (element && editor.view.dom.contains(element)) {
    if (element === source || source.contains(element)) return null;
    const pos = blocks.get(element)?.getPos(), rect = element.getBoundingClientRect();
    if (typeof pos !== 'number') return null;
    const side = y < rect.top + Math.min(24, rect.height * .2) ? 'before' : y > rect.bottom - Math.min(24, rect.height * .2) ? 'after'
      : x < rect.left + rect.width * .25 ? 'left' : x > rect.right - rect.width * .25 ? 'right'
        : y < rect.top + rect.height / 2 ? 'before' : 'after';
    return { pos, side, rect };
  }
  const candidates = groups(editor).flatMap(group => group.children.length ? group.children : [group]).map(group => {
    const element = editor.view.nodeDOM(group.pos);
    return element?.getBoundingClientRect && element !== source ? { pos: group.pos, rect: element.getBoundingClientRect() } : null;
  }).filter(Boolean);
  const target = candidates.sort((a, b) => Math.min(Math.abs(y - a.rect.top), Math.abs(y - a.rect.bottom))
    - Math.min(Math.abs(y - b.rect.top), Math.abs(y - b.rect.bottom)))[0];
  return target ? { ...target, side: y < target.rect.top + target.rect.height / 2 ? 'before' : 'after' } : null;
}
export function blockInteractions({ dom, editor, getPos, getNode }) {
  blocks.set(dom, { getPos });
  dom.tabIndex = -1;
  let cleanup = () => {}, suppressClick = false, clickTimer;
  const update = layout => {
    const pos = getPos();
    if (!editor.isDestroyed && typeof pos === 'number') editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...getNode().attrs, layout: validateLayout(layout) }));
  };
  const swallowClick = event => {
    if (!suppressClick) return;
    event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false;
  };
  document.addEventListener('click', swallowClick, true);
  const preventClick = () => {
    suppressClick = true; clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 350);
  };
  const listenGesture = (event, move, end) => {
    const onMove = e => { if (e.pointerId === event.pointerId) move(e); };
    const onUp = e => { if (e.pointerId === event.pointerId) end(e.type === 'pointerup', e); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } };
    const onBlur = () => end(false);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true); document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('keydown', onKey, true); window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true); document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', onBlur);
    };
  };
  const startDrag = event => {
    if (event.button !== 0 || !event.isPrimary || event.target.closest('button,input,textarea,select')
      || event.target.closest('.rich-block,.layout-block') !== dom) return;
    const video = event.target.closest('video');
    if (video && event.clientY > video.getBoundingClientRect().bottom - 54) return;
    drags.get(editor)?.(); cleanup();
    let active = false, ghost, marker, frame, target, last = { x: event.clientX, y: event.clientY };
    const area = editor.view.dom.closest('.editor-scroll'), start = dom.getBoundingClientRect();
    const paint = () => {
      ghost.style.left = `${last.x - (event.clientX - start.left)}px`;
      ghost.style.top = `${last.y - (event.clientY - start.top)}px`;
      target = dropTarget(editor, dom, last.x, last.y);
      marker.hidden = !target;
      if (target) {
        const { rect, side } = target, vertical = ['left', 'right'].includes(side);
        Object.assign(marker.style, { left: `${side === 'right' ? rect.right : rect.left}px`, top: `${side === 'after' ? rect.bottom : rect.top}px`,
          width: `${vertical ? 3 : rect.width}px`, height: `${vertical ? rect.height : 3}px` });
      }
    };
    const tick = () => {
      const box = area.getBoundingClientRect();
      if (last.x >= box.left && last.x <= box.right && last.y >= box.top - 25 && last.y <= box.bottom + 25) {
        const delta = last.y < box.top + 36 ? -10 : last.y > box.bottom - 36 ? 10 : 0;
        if (delta) area.scrollTop += delta;
      }
      paint(); frame = requestAnimationFrame(tick);
    };
    const finish = (commit, e) => {
      clearTimeout(timer); cancelAnimationFrame(frame); removeListeners();
      area.removeEventListener('scroll', onScroll);
      dom.classList.remove('block-lifted'); ghost?.remove(); marker?.remove();
      if (dom.hasPointerCapture(event.pointerId)) dom.releasePointerCapture(event.pointerId);
      drags.delete(editor); cleanup = () => {};
      if (active) {
        preventClick(); e?.preventDefault();
        if (commit && target && !editor.isDestroyed) moveBlock(editor, getPos(), target.pos, target.side);
      }
    };
    const removeListeners = listenGesture(event, e => {
      last = { x: e.clientX, y: e.clientY };
      if (!active) { if (Math.hypot(last.x - event.clientX, last.y - event.clientY) > 7) finish(false); return; }
      e.preventDefault(); e.stopPropagation(); paint();
    }, finish);
    const onScroll = () => { if (!active) finish(false); };
    area.addEventListener('scroll', onScroll);
    const timer = setTimeout(() => {
      if (editor.isDestroyed || !dom.isConnected) { finish(false); return; }
      active = true;
      ghost = dom.cloneNode(true); ghost.classList.add('block-drag-preview');
      ghost.removeAttribute('contenteditable'); ghost.setAttribute('aria-hidden', 'true');
      ghost.querySelectorAll('button,.block-actions').forEach(el => el.remove());
      // A cloned video/canvas is blank; copy its visible frame for the floating preview.
      const originals = dom.querySelectorAll('video,canvas');
      ghost.querySelectorAll('video,canvas').forEach((copy, index) => {
        const source = originals[index], canvas = document.createElement('canvas');
        canvas.width = source.videoWidth || source.width; canvas.height = source.videoHeight || source.height;
        try { canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height); copy.replaceWith(canvas); } catch {}
      });
      Object.assign(ghost.style, { width: `${start.width}px`, height: `${start.height}px` });
      marker = document.createElement('div'); marker.className = 'block-drop-marker'; marker.setAttribute('aria-hidden', 'true');
      document.body.append(ghost, marker); dom.classList.add('block-lifted');
      window.getSelection()?.removeAllRanges();
      dom.focus({ preventScroll: true });
      dom.setPointerCapture(event.pointerId);
      paint(); frame = requestAnimationFrame(tick);
    }, 1000);
    cleanup = () => finish(false); drags.set(editor, cleanup);
  };
  const preventNativeDrag = event => { event.preventDefault(); };
  dom.addEventListener('pointerdown', startDrag);
  dom.addEventListener('dragstart', preventNativeDrag);
  for (const [edge, name] of Object.entries({ n: '上边', e: '右边', s: '下边', w: '左边', nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角' })) {
    const handle = document.createElement('button'); handle.type = 'button'; handle.contentEditable = 'false';
    handle.className = 'block-resize-edge'; handle.dataset.resizeEdge = edge;
    handle.setAttribute('aria-label', `调整${name}大小`); handle.title = `拖动${name}调节大小`; dom.append(handle);
    handle.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); drags.get(editor)?.(); cleanup();
      const content = dom.querySelector('.rich-content,.layout-content'), box = dom.getBoundingClientRect();
      const parentWidth = dom.parentElement.getBoundingClientRect().width, original = getNode().attrs.layout || defaults();
      const height = content.getBoundingClientRect().height;
      const media = content.querySelector('img,video');
      const ratio = media && (media.naturalWidth || media.videoWidth) / (media.naturalHeight || media.videoHeight);
      let pending = original, moved = false;
      dom.classList.add('resizing'); handle.focus({ preventScroll: true }); handle.setPointerCapture(event.pointerId);
      const finish = commit => {
        removeListeners(); dom.classList.remove('resizing');
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        cleanup = () => {}; drags.delete(editor); preventClick();
        if (commit && moved) update(pending); else applyLayout(dom, original);
      };
      const removeListeners = listenGesture(event, e => {
        e.preventDefault();
        const dx = (e.clientX - event.clientX) * (edge.includes('w') ? -1 : 1);
        const dy = (e.clientY - event.clientY) * (edge.includes('n') ? -1 : 1);
        moved ||= Math.abs(dx) + Math.abs(dy) > 2;
        pending = { ...original,
          width: /[ew]/.test(edge) ? Math.round(Math.max(15, Math.min(100, (box.width + dx) / parentWidth * 100))) : original.width,
          height: /[ns]/.test(edge) ? Math.round(Math.max(60, Math.min(1600, height + dy))) : original.height };
        if (ratio) {
          const useWidth = /[ew]/.test(edge) && (!/[ns]/.test(edge) || Math.abs(dx / box.width) >= Math.abs(dy / height));
          const nextWidth = useWidth ? box.width + dx : (height + dy) * ratio;
          pending.width = Math.max(15, Math.min(100, nextWidth / parentWidth * 100));
          pending.height = Math.max(60, Math.min(1600, parentWidth * pending.width / 100 / ratio));
        }
        applyLayout(dom, pending);
      }, finish);
      cleanup = () => finish(false); drags.set(editor, cleanup);
    };
    handle.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const layout = getNode().attrs.layout || defaults();
      update({ ...layout, width: Math.max(15, Math.min(100, layout.width + (event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0))),
        height: ['ArrowUp', 'ArrowDown'].includes(event.key) ? Math.max(60, Math.min(1600, (layout.height || 200) + (event.key === 'ArrowDown' ? 20 : -20))) : layout.height });
    };
  }
  return () => {
    cleanup(); clearTimeout(clickTimer); blocks.delete(dom);
    dom.removeEventListener('pointerdown', startDrag); dom.removeEventListener('dragstart', preventNativeDrag);
    document.removeEventListener('click', swallowClick, true);
  };
}
export function layoutExtensions() {
  return [
    Node.create({ name: 'blockRow', group: 'block', content: '(richBlock | layoutBlock)+',
      parseHTML: () => [{ tag: 'div[data-ss-row]' }],
      renderHTML: () => ['div', { 'data-ss-row': 'true', class: 'block-row' }, 0] }),
    Node.create({ name: 'layoutBlock', group: 'block', content: 'block+', defining: true, isolating: true,
      addAttributes: layoutAttributes, parseHTML: () => [{ tag: 'section[data-ss-container]' }],
      renderHTML: ({ HTMLAttributes }) => ['section', { ...HTMLAttributes, 'data-ss-container': 'true' }, 0],
      addNodeView() { return ({ node, editor, getPos }) => {
        let current = node;
        const dom = document.createElement('section'); dom.className = 'layout-block';
        const contentDOM = document.createElement('div'); contentDOM.className = 'layout-content'; dom.append(contentDOM);
        const dispose = blockInteractions({ dom, editor, getPos, getNode: () => current });
        applyLayout(dom, node.attrs.layout);
        return { dom, contentDOM, stopEvent: event => !!event.target.closest('.block-resize-edge'),
          ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
          update(next) { if (next.type !== current.type) return false; current = next; applyLayout(dom, next.attrs.layout); return true; }, destroy: dispose };
      }; } })
  ];
}
