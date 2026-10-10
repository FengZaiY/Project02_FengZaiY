import Konva from 'konva';
import { createElement, icons } from 'lucide';
import { validateBlock } from '../src/core/rich-schema.mjs';

function shapeNode(shape, editable = false) {
  const group = new Konva.Group({ x: shape.x, y: shape.y, draggable: editable, id: shape.id });
  const common = { fill: shape.fill, stroke: '#4d6262', strokeWidth: 1.5 };
  if (shape.type === 'ellipse') group.add(new Konva.Ellipse({ ...common, x: shape.width / 2, y: shape.height / 2, radiusX: shape.width / 2, radiusY: shape.height / 2 }));
  else if (shape.type === 'rect') group.add(new Konva.Rect({ ...common, width: shape.width, height: shape.height, cornerRadius: 4 }));
  else if (['arrow', 'line'].includes(shape.type)) group.add(new (shape.type === 'arrow' ? Konva.Arrow : Konva.Line)({ points: shape.points, stroke: shape.fill, fill: shape.fill, strokeWidth: 3, lineCap: 'round', lineJoin: 'round' }));
  if (!['arrow', 'line'].includes(shape.type)) group.add(new Konva.Text({ text: shape.text, width: shape.width, height: shape.height, padding: 10, fontSize: 16, fill: '#243735', fontFamily: 'Microsoft YaHei, sans-serif', wrap: 'char' }));
  return group;
}
export function canvasPreview(host, shapes) {
  const stage = new Konva.Stage({ container: host, width: 700, height: 340 }), layer = new Konva.Layer(); stage.add(layer);
  try {
    shapes.forEach(shape => layer.add(shapeNode(shape)));
    const box = layer.getClientRect();
    if (shapes.length) {
      const scale = Math.min(1.5, 650 / Math.max(1, box.width), 290 / Math.max(1, box.height));
      layer.scale({ x: scale, y: scale }); layer.position({ x: 25 - box.x * scale, y: 25 - box.y * scale });
    } else layer.add(new Konva.Text({ x: 25, y: 25, text: '空白画板', fontSize: 18, fill: '#60706c' }));
    layer.draw(); const image = document.createElement('img'); image.alt = '画板预览'; image.src = stage.toDataURL();
    stage.destroy(); host.replaceChildren(image);
  } finally { if (stage.container()) stage.destroy(); }
}
export function openCanvas(block, commit, { openModal, fail }) {
  const dialog = openModal('无限画板', `<form id="canvas-form"><div class="canvas-top"><input id="canvas-title" aria-label="画板标题" maxlength="200"><div id="canvas-tools" role="toolbar" aria-label="画板工具"></div><output id="canvas-zoom">100%</output></div><div class="canvas-workspace"><div id="canvas-stage" tabindex="0" aria-label="画板"></div><aside class="canvas-properties"><label>对象文字<textarea id="shape-text" rows="5" maxlength="2000"></textarea></label><label>颜色<input id="shape-color" type="color" value="#d8efe8"></label><label>宽度<input id="shape-width" type="number" min="10" max="2000" value="180"></label><label>高度<input id="shape-height" type="number" min="10" max="2000" value="90"></label></aside></div><div class="form-actions"><button class="primary" type="submit">保存画板</button></div></form>`);
  dialog.classList.add('canvas-dialog');
  const q = selector => dialog.querySelector(selector), container = q('#canvas-stage'); q('#canvas-title').value = block.label;
  let shapes = structuredClone(block.shapes), history = [structuredClone(shapes)], cursor = 0, selected = null, mode = 'select', drawing = null, oldShapes;
  const stage = new Konva.Stage({ container, width: Math.max(200, container.clientWidth), height: Math.max(260, container.clientHeight) });
  const layer = new Konva.Layer(); stage.add(layer);
  const transformer = new Konva.Transformer({ rotateEnabled: false, enabledAnchors: ['bottom-right'], boundBoxFunc: (old, next) => next.width < 10 || next.height < 10 ? old : next });
  const record = () => { history = history.slice(0, cursor + 1); history.push(structuredClone(shapes)); if (history.length > 50) history.shift(); cursor = history.length - 1; };
  const props = () => {
    const shape = shapes.find(item => item.id === selected);
    for (const [id, key] of [['shape-text', 'text'], ['shape-color', 'fill'], ['shape-width', 'width'], ['shape-height', 'height']]) {
      q(`#${id}`).disabled = !shape; if (shape) q(`#${id}`).value = shape[key];
    }
  };
  const draw = () => {
    transformer.nodes([]); transformer.remove(); layer.destroyChildren();
    for (const shape of shapes) {
      const node = shapeNode(shape, mode === 'select'); layer.add(node);
      node.on('click tap', () => { if (mode !== 'select') return; selected = shape.id; draw(); });
      node.on('dragend', () => { shape.x = node.x(); shape.y = node.y(); record(); });
      node.on('transformend', () => {
        const sx = node.scaleX(), sy = node.scaleY(); shape.x = node.x(); shape.y = node.y(); shape.width *= sx; shape.height *= sy;
        if (shape.points) shape.points = shape.points.map((n, i) => n * (i % 2 ? sy : sx));
        node.scale({ x: 1, y: 1 }); record(); draw();
      });
      if (shape.id === selected && mode === 'select') transformer.nodes([node]);
    }
    layer.add(transformer); layer.draw(); props();
  };
  const world = () => stage.getAbsoluteTransform().copy().invert().point(stage.getPointerPosition() || { x: stage.width() / 2, y: stage.height() / 2 });
  const add = type => {
    if (shapes.length >= 500) { fail('画板最多 500 个对象'); return; }
    const pos = stage.getAbsoluteTransform().copy().invert().point({ x: stage.width() / 2 - 90, y: stage.height() / 2 - 45 });
    const shape = { id: crypto.randomUUID(), type, ...pos, width: 180, height: 90, text: type === 'text' ? '文字' : '', fill: type === 'arrow' ? '#376e68' : '#d8efe8', ...(type === 'arrow' ? { points: [0, 0, 160, 0] } : {}) };
    shapes.push(shape); selected = shape.id; setMode('select'); record(); draw();
  };
  const zoom = (factor, point = { x: stage.width() / 2, y: stage.height() / 2 }) => {
    const before = stage.scaleX(), next = Math.min(4, Math.max(0.1, before * factor));
    const origin = { x: (point.x - stage.x()) / before, y: (point.y - stage.y()) / before };
    stage.scale({ x: next, y: next }); stage.position({ x: point.x - origin.x * next, y: point.y - origin.y * next });
    q('#canvas-zoom').value = `${Math.round(next * 100)}%`; stage.batchDraw();
  };
  const fit = () => {
    const bounds = layer.getClientRect({ skipTransform: true });
    const scale = shapes.length ? Math.min(1, (stage.width() - 40) / Math.max(1, bounds.width), (stage.height() - 40) / Math.max(1, bounds.height)) : 1;
    stage.scale({ x: scale, y: scale });
    stage.position(shapes.length ? { x: (stage.width() - bounds.width * scale) / 2 - bounds.x * scale, y: (stage.height() - bounds.height * scale) / 2 - bounds.y * scale } : { x: 0, y: 0 });
    q('#canvas-zoom').value = `${Math.round(scale * 100)}%`; stage.batchDraw();
  };
  const setMode = value => { mode = value; stage.draggable(mode === 'pan'); container.style.cursor = mode === 'pan' ? 'grab' : mode === 'draw' ? 'crosshair' : 'default';
    dialog.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode))); draw(); };
  const tool = (name, symbol, action, toolMode) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-button'; b.title = name; b.setAttribute('aria-label', name); b.append(createElement(symbol));
    if (toolMode) { b.dataset.mode = toolMode; b.setAttribute('aria-pressed', String(mode === toolMode)); }
    b.onclick = action; q('#canvas-tools').append(b);
  };
  tool('选择对象', icons.MousePointer2, () => setMode('select'), 'select'); tool('平移画板', icons.Hand, () => setMode('pan'), 'pan'); tool('自由画笔', icons.Pencil, () => setMode('draw'), 'draw');
  tool('添加矩形', icons.Square, () => add('rect')); tool('添加椭圆', icons.Circle, () => add('ellipse')); tool('添加文字', icons.Type, () => add('text')); tool('添加箭头', icons.ArrowUpRight, () => add('arrow'));
  tool('画板撤销', icons.Undo2, () => { if (cursor > 0) { shapes = structuredClone(history[--cursor]); selected = null; draw(); } });
  tool('画板重做', icons.Redo2, () => { if (cursor < history.length - 1) { shapes = structuredClone(history[++cursor]); selected = null; draw(); } });
  tool('删除对象', icons.Trash2, () => { if (selected) { shapes = shapes.filter(s => s.id !== selected); selected = null; record(); draw(); } });
  tool('放大画板', icons.ZoomIn, () => zoom(1.2)); tool('缩小画板', icons.ZoomOut, () => zoom(1 / 1.2));
  tool('画板归位', icons.Scan, fit);
  for (const [id, key] of [['shape-text', 'text'], ['shape-color', 'fill'], ['shape-width', 'width'], ['shape-height', 'height']]) q(`#${id}`).onchange = event => {
    const shape = shapes.find(s => s.id === selected); if (!shape) return;
    const next = ['width', 'height'].includes(key) ? Math.min(2000, Math.max(10, Number(event.target.value) || 10)) : event.target.value;
    if (shape.points && ['width', 'height'].includes(key)) shape.points = shape.points.map((n, index) => index % 2 === (key === 'width' ? 0 : 1) ? n * next / shape[key] : n);
    shape[key] = next; record(); draw();
  };
  stage.on('wheel', event => { event.evt.preventDefault(); zoom(event.evt.deltaY > 0 ? 1 / 1.1 : 1.1, stage.getPointerPosition()); });
  stage.on('mousedown touchstart', event => {
    if (mode === 'select' && event.target === stage) { selected = null; draw(); }
    if (mode !== 'draw' || shapes.length >= 500) return;
    oldShapes = structuredClone(shapes); const pos = world();
    drawing = { id: crypto.randomUUID(), type: 'line', x: pos.x, y: pos.y, width: 1, height: 1, text: '', fill: '#376e68', points: [0, 0, 0, 0] }; shapes.push(drawing); draw();
  });
  stage.on('mousemove touchmove', () => { if (!drawing || drawing.points.length >= 10000) return; const pos = world(); drawing.points.push(pos.x - drawing.x, pos.y - drawing.y); draw(); });
  const finish = () => { if (drawing) { try { validateBlock({ ...block, shapes }); record(); } catch (error) { shapes = oldShapes; fail(error.message); } drawing = null; draw(); } };
  stage.on('mouseup touchend', finish); window.addEventListener('mouseup', finish);
  const resize = new ResizeObserver(() => { const width = Math.max(200, container.clientWidth), height = Math.max(260, container.clientHeight); stage.position({ x: stage.x() + (width - stage.width()) / 2, y: stage.y() + (height - stage.height()) / 2 }); stage.size({ width, height }); stage.batchDraw(); }); resize.observe(container);
  q('#canvas-form').onsubmit = event => { event.preventDefault(); try { finish(); commit(validateBlock({ ...block, label: q('#canvas-title').value, shapes })); dialog.close(); } catch (error) { fail(error.message); } };
  dialog.addEventListener('close', () => { resize.disconnect(); window.removeEventListener('mouseup', finish); stage.destroy(); dialog.classList.remove('canvas-dialog'); }, { once: true });
  draw(); fit();
}
