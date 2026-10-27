import { encodeBlock } from '../src/core/rich-schema.mjs';

const dragType = 'application/x-fengzaiy-attachment';
let activeDrag;

export function attachmentContent(asset, label = asset.data.title) {
  const kind = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.data.mime) ? 'image'
    : ['video/mp4', 'video/webm', 'video/quicktime'].includes(asset.data.mime) ? 'video' : null;
  return kind ? { type: 'richBlock', attrs: { payload: encodeBlock({ v: 1, kind, assetId: asset.id, label: label.slice(0, 200) }) } }
    : { type: 'paragraph', content: [{ type: 'text', text: label,
      marks: [{ type: 'link', attrs: { href: `fengzaiy://asset/${asset.id}` } }] }] };
}

function clearDrag() {
  activeDrag?.clear?.();
  activeDrag?.source.classList.remove('source-dragging');
  activeDrag = null;
}

export function bindAttachmentSources(pane, assets, editor, recordId) {
  if (!editor || editor.isDestroyed) return;
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  for (const control of pane.querySelectorAll('[data-preview-asset]')) {
    const asset = byId.get(control.dataset.previewAsset);
    if (!asset || asset.deleted || asset.conflict || !asset.available) continue;
    control.draggable = true;
    if (!control.title) control.title = asset.data.title;
    control.ondragstart = event => {
      if (!event.dataTransfer || editor.isDestroyed) { event.preventDefault(); return; }
      clearDrag();
      activeDrag = { asset, editor, recordId, source: control, token: crypto.randomUUID() };
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(dragType, activeDrag.token);
      control.classList.add('source-dragging');
    };
    control.ondragend = clearDrag;
  }
}

export function bindAttachmentDrop(editor, area, { recordId, validate, fail }) {
  let marker, frame, point;
  const valid = event => activeDrag?.editor === editor && activeDrag.recordId === recordId
    && [...(event.dataTransfer?.types || [])].includes(dragType);
  const clear = () => {
    cancelAnimationFrame(frame); frame = null; point = null;
    marker?.remove(); marker = null;
  };
  const positionAt = (x, y) => {
    const rect = editor.view.dom.getBoundingClientRect();
    if (y >= rect.bottom) return editor.state.doc.content.size;
    if (y <= rect.top) return 0;
    return editor.view.posAtCoords({ left: Math.max(rect.left + 1, Math.min(x, rect.right - 1)), top: y })?.pos ?? null;
  };
  const showPosition = () => {
    if (!point || editor.isDestroyed) return;
    const pos = positionAt(point.x, point.y);
    if (pos === null) { marker?.remove(); marker = null; return; }
    const coords = editor.view.coordsAtPos(pos), bounds = area.getBoundingClientRect();
    if (!marker) {
      marker = document.createElement('div'); marker.className = 'attachment-drop-marker';
      marker.setAttribute('aria-hidden', 'true'); document.body.append(marker);
    }
    const top = Math.max(bounds.top, coords.top), bottom = Math.min(bounds.bottom, coords.bottom);
    Object.assign(marker.style, { left: `${coords.left}px`, top: `${top}px`, height: `${Math.max(3, bottom - top)}px` });
  };
  const scroll = () => {
    if (!point || editor.isDestroyed) return;
    const bounds = area.getBoundingClientRect();
    const delta = point.y < bounds.top + 36 ? -10 : point.y > bounds.bottom - 36 ? 10 : 0;
    if (delta) { area.scrollTop += delta; showPosition(); }
    frame = requestAnimationFrame(scroll);
  };
  const over = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    activeDrag.clear = clear;
    point = { x: event.clientX, y: event.clientY }; showPosition();
    if (!frame) frame = requestAnimationFrame(scroll);
  };
  const leave = event => { if (!area.contains(event.relatedTarget)) clear(); };
  const drop = event => {
    if (![...(event.dataTransfer?.types || [])].includes(dragType)) return;
    event.preventDefault(); event.stopPropagation();
    const drag = activeDrag;
    let position = positionAt(event.clientX, event.clientY);
    const accepted = valid(event) && event.dataTransfer.getData(dragType) === drag.token;
    clearDrag(); clear();
    if (!accepted || position === null) return;
    // Keep the drop location anchored while metadata is checked and the user keeps typing.
    const map = ({ transaction }) => { position = transaction.mapping.map(position, 1); };
    editor.on('transaction', map);
    void (async () => {
      try {
        const asset = await validate(drag.asset.id);
        if (!asset || editor.isDestroyed) return;
        editor.chain().focus().insertContentAt(Math.min(position, editor.state.doc.content.size), attachmentContent(asset)).run();
      } catch (error) { if (!editor.isDestroyed) fail(error.message); }
      finally { editor.off('transaction', map); }
    })();
  };
  const escape = event => { if (event.key === 'Escape') clearDrag(); };
  area.addEventListener('dragover', over, true);
  area.addEventListener('dragleave', leave);
  area.addEventListener('drop', drop, true);
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('keydown', escape);
  window.addEventListener('blur', clearDrag);
  editor.on('destroy', () => {
    if (activeDrag?.editor === editor) clearDrag();
    clear();
    area.removeEventListener('dragover', over, true);
    area.removeEventListener('dragleave', leave);
    area.removeEventListener('drop', drop, true);
    document.removeEventListener('dragend', clearDrag);
    document.removeEventListener('keydown', escape);
    window.removeEventListener('blur', clearDrag);
  });
}
