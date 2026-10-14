import mermaid from 'mermaid';
import { createElement, icons } from 'lucide';
import { validateBlock } from '../src/core/rich-schema.mjs';
import { mindmapFromParsed, flattenMindmap, serializeMindmap, moveMindmap, layoutMindmap, mindmapEdge } from './mindmap-model.js';
import './mindmap.css';

const svgElement = (name, attributes = {}) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};
const plainText = text => {
  // Mermaid 12's parsed DB retains protected entities; decode once as inert text.
  const inert = document.createElement('template');
  inert.innerHTML = text.replace(/\uFB02\u00B0\u00B0/g, '&#').replace(/\uFB02\u00B0/g, '&').replace(/\u00B6\u00DF/g, ';');
  return inert.content.textContent || '';
};
export async function parseMindmap(source) {
  if (/%%\{|^\s*---|\bclick\s|<\/?(?:script|iframe|img|image)\b/i.test(source)) throw new Error('图表不允许配置指令、外部图片或交互脚本');
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  if (diagram.type !== 'mindmap' || !diagram.db.getMindmap) throw new Error('请使用 mindmap 思维导图格式');
  return mindmapFromParsed(source, diagram.db.getMindmap(), plainText);
}
export function mindmapSvg(model) {
  const layout = layoutMindmap(model);
  const svg = svgElement('svg', { viewBox: `${layout.left} ${layout.top} ${layout.width} ${layout.height}`,
    role: 'img', 'aria-label': model.root.text, class: 'mindmap-preview', xmlns: 'http://www.w3.org/2000/svg' });
  for (const edge of layout.edges) svg.append(svgElement('path', { d: mindmapEdge(edge), fill: 'none',
    stroke: edge.to.color, 'stroke-width': edge.to.depth === 1 ? 3 : 1.8, 'stroke-linecap': 'round' }));
  for (const item of layout.nodes) {
    const group = svgElement('g');
    group.append(svgElement('rect', { x: item.x - item.width / 2, y: item.y - item.height / 2, width: item.width,
      height: item.height, rx: item.depth ? 6 : 8, fill: item.depth === 0 ? '#334a62' : item.depth === 1 ? `${item.color}16` : '#fff',
      stroke: item.depth ? item.color : '#334a62', 'stroke-width': item.depth > 1 ? 1 : 1.5 }));
    const text = svgElement('text', { 'text-anchor': 'middle', fill: item.depth ? '#283645' : '#fff',
      'font-family': 'Microsoft YaHei, sans-serif', 'font-size': item.depth ? 15 : 17, 'font-weight': item.depth < 2 ? 600 : 400 });
    item.lines.forEach((line, index) => { const span = svgElement('tspan', { x: item.x, y: item.y - (item.lines.length - 1) * 11 + index * 22 + 5 }); span.textContent = line; text.append(span); });
    group.append(text);
    if (item.node.collapsed && item.node.children.length) {
      const badge = svgElement('text', { x: item.x + item.width / 2 + 12, y: item.y + 5, fill: item.color, 'font-size': 12 });
      badge.textContent = `+${flattenMindmap(item.node).length - 1}`; group.append(badge);
    }
    svg.append(group);
  }
  return svg;
}

export function openMindmap(block, commit, { openModal, fail }) {
  const dialog = openModal('思维导图', `<section class="mm-editor">
    <div class="mm-toolbar"><input class="mm-title" aria-label="导图标题" maxlength="200">
      <div class="mm-tools" role="toolbar" aria-label="思维导图工具"></div>
      <label class="mm-layout-label">布局<select aria-label="导图布局"><option value="balanced">左右展开</option><option value="right">向右展开</option></select></label>
      <div class="mm-palettes" role="group" aria-label="分支配色"></div>
    </div>
    <div class="mm-message" role="status" hidden></div>
    <div class="mm-workspace">
      <div class="mm-stage" tabindex="0" role="tree" aria-label="思维导图画布"><div class="mm-world"></div></div>
      <div class="mm-source" hidden><label for="mm-source-text">Mermaid 源文本</label><textarea id="mm-source-text" spellcheck="false" maxlength="30000"></textarea><button class="secondary" type="button" data-mm-apply>应用到画布</button></div>
      <div class="mm-viewport-tools"></div>
      <div class="mm-context" role="menu" hidden></div>
    </div>
    <div class="mm-discard" hidden><span>放弃尚未保存的导图修改？</span><button class="secondary" type="button" data-mm-continue>继续编辑</button><button class="secondary" type="button" data-mm-discard>放弃修改</button></div>
    <div class="mm-footer"><span class="mm-count" aria-live="polite">正在读取导图…</span><div><button class="secondary" type="button" data-mm-cancel>取消</button><button class="primary" type="button" data-mm-save disabled>保存导图</button></div></div>
    </section>`);
  dialog.classList.add('mindmap-dialog');
  const root = dialog.querySelector('.mm-editor'), q = selector => root.querySelector(selector);
  const stage = q('.mm-stage'), world = q('.mm-world'), sourceField = q('#mm-source-text'), title = q('.mm-title');
  title.value = block.label; sourceField.value = block.source;
  let model, selected, layout, source = block.source, sourceMode = false, modified = false, disposed = false, parsing = 0;
  let history = [], cursor = -1, inline = null, gesture = null, context = null;
  let scale = 1, pan = { x: 0, y: 0 };
  const buttons = new Map();
  const message = text => { q('.mm-message').textContent = text; q('.mm-message').hidden = !text; };
  const button = (host, name, icon, action, shortcut = '') => {
    const element = document.createElement('button'); element.type = 'button'; element.className = 'icon-button';
    element.title = `${name}${shortcut ? ` (${shortcut})` : ''}`; element.setAttribute('aria-label', name);
    element.append(createElement(icons[icon])); element.onclick = () => invoke(action); host.append(element); buttons.set(name, element); return element;
  };
  const all = () => model ? flattenMindmap(model.root) : [];
  const current = () => all().find(item => item.node.id === selected);
  const transform = () => {
    world.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${scale})`;
    zoomOutput.textContent = `${Math.round(scale * 100)}%`;
  };
  const fit = () => {
    if (!layout || sourceMode) return;
    scale = Math.max(0.025, Math.min(1.2, (stage.clientWidth - 48) / layout.width, (stage.clientHeight - 70) / layout.height));
    pan = { x: stage.clientWidth / 2 - (layout.left + layout.width / 2) * scale,
      y: stage.clientHeight / 2 - (layout.top + layout.height / 2) * scale };
    transform();
  };
  const zoom = (factor, point = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) => {
    const next = Math.max(0.025, Math.min(3, scale * factor));
    pan = { x: point.x - (point.x - pan.x) * next / scale, y: point.y - (point.y - pan.y) * next / scale };
    scale = next; transform();
  };
  const updateControls = () => {
    const enabled = !!model && !sourceMode, item = current();
    for (const name of ['添加子主题', '添加同级主题', '编辑主题', '删除主题', '折叠或展开分支']) buttons.get(name).disabled = !enabled;
    buttons.get('添加同级主题').disabled ||= !item?.parent;
    buttons.get('删除主题').disabled ||= !item?.parent;
    buttons.get('折叠或展开分支').disabled ||= !item?.node.children.length;
    buttons.get('导图撤销').disabled = !enabled || cursor < 1;
    buttons.get('导图重做').disabled = !enabled || cursor >= history.length - 1;
    q('[aria-label="导图布局"]').disabled = !enabled;
    q('.mm-palettes').querySelectorAll('button').forEach(element => { element.disabled = !enabled; element.setAttribute('aria-pressed', String(element.dataset.palette === model?.palette)); });
    buttons.get('源文本').setAttribute('aria-pressed', String(sourceMode));
    q('[data-mm-save]').disabled = !model && !sourceMode;
    q('.mm-count').textContent = model ? `${all().length} 个主题${modified || sourceField.value !== source || title.value !== block.label ? ' · 未保存' : ''}` : '源文本编辑';
  };
  const select = (id, focus = true) => {
    selected = id;
    world.querySelectorAll('.mm-topic').forEach(element => element.setAttribute('aria-selected', String(element.dataset.topic === id)));
    if (id) stage.setAttribute('aria-activedescendant', `mm-topic-${id}`);
    if (focus) { reveal(id); stage.focus({ preventScroll: true }); }
    updateControls();
  };
  const reveal = id => {
    const item = layout?.nodes.find(node => node.node.id === id); if (!item) return;
    const x = pan.x + item.x * scale, y = pan.y + item.y * scale;
    const halfWidth = item.width * scale / 2, halfHeight = item.height * scale / 2;
    if (x - halfWidth < 24 || x + halfWidth > stage.clientWidth - 24) pan.x += stage.clientWidth / 2 - x;
    if (y - halfHeight < 24 || y + halfHeight > stage.clientHeight - 64) pan.y += stage.clientHeight / 2 - y;
    transform();
  };
  const checkpoint = () => {
    source = serializeMindmap(model); sourceField.value = source; modified = source !== block.source;
    remember();
  };
  const remember = () => {
    history = history.slice(0, cursor + 1); history.push({ model: structuredClone(model), selected, source });
    if (history.length > 80) history.shift();
    cursor = history.length - 1;
  };
  const draw = () => {
    if (!model || disposed) return;
    layout = layoutMindmap(model); world.replaceChildren();
    const paths = svgElement('svg', { class: 'mm-edges', width: layout.width, height: layout.height,
      viewBox: `${layout.left} ${layout.top} ${layout.width} ${layout.height}`, 'aria-hidden': 'true' });
    paths.style.cssText = `left:${layout.left}px;top:${layout.top}px;width:${layout.width}px;height:${layout.height}px`;
    layout.edges.forEach(edge => paths.append(svgElement('path', { d: mindmapEdge(edge), fill: 'none', stroke: edge.to.color,
      'stroke-width': edge.to.depth === 1 ? 3 : 1.8, 'stroke-linecap': 'round' }))); world.append(paths);
    for (const item of layout.nodes) {
      const element = document.createElement('div');
      element.className = `mm-topic mm-depth-${Math.min(item.depth, 2)}`; element.dataset.topic = item.node.id;
      element.id = `mm-topic-${item.node.id}`; element.setAttribute('role', 'treeitem'); element.setAttribute('aria-level', String(item.depth + 1));
      element.setAttribute('aria-label', item.node.text); element.setAttribute('aria-selected', String(selected === item.node.id));
      if (item.node.children.length) element.setAttribute('aria-expanded', String(!item.node.collapsed));
      element.style.cssText = `left:${item.x - item.width / 2}px;top:${item.y - item.height / 2}px;width:${item.width}px;height:${item.height}px;--branch:${item.color};--branch-bg:${item.color}16`;
      const text = document.createElement('span'); text.textContent = item.lines.join('\n'); element.append(text);
      element.ondblclick = event => { event.preventDefault(); select(item.node.id); editTopic(); };
      element.oncontextmenu = event => { event.preventDefault(); select(item.node.id); showContext(event); };
      world.append(element);
      if (item.node.children.length) {
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'mm-collapse';
        toggle.setAttribute('aria-label', `${item.node.collapsed ? '展开' : '收起'}分支：${item.node.text}`);
        toggle.title = toggle.getAttribute('aria-label');
        toggle.style.cssText = `left:${item.x + item.side * (item.width / 2 + 20) - 10}px;top:${item.y - 10}px;--branch:${item.color}`;
        if (item.node.collapsed) toggle.textContent = String(flattenMindmap(item.node).length - 1);
        else toggle.append(createElement(icons.Minus));
        toggle.onclick = () => invoke(() => { selected = item.node.id; mutate(() => { item.node.collapsed = !item.node.collapsed; }); });
        world.append(toggle);
      }
    }
    q('[aria-label="导图布局"]').value = model.layout;
    transform(); select(selected, false);
  };
  const mutate = action => {
    const before = structuredClone(model), oldSelected = selected;
    try { action(); checkpoint(); draw(); message(''); }
    catch (error) { model = before; selected = oldSelected; draw(); throw error; }
  };
  const finishEdit = (cancel = false) => {
    if (!inline) return true;
    const { element, id } = inline, text = element.value.trim(); inline = null; element.remove();
    if (!cancel) {
      if (!text) { message('主题文字不能为空'); stage.focus(); return false; }
      const node = all().find(item => item.node.id === id)?.node;
      if (node && text !== node.text) mutate(() => { node.text = text; node.raw = null; });
    }
    stage.focus({ preventScroll: true }); return true;
  };
  const editTopic = () => {
    if (sourceMode || !model) return;
    finishEdit();
    const item = layout.nodes.find(node => node.node.id === selected);
    if (!item) return;
    reveal(selected);
    const element = document.createElement('textarea'); element.className = 'mm-inline'; element.setAttribute('aria-label', '主题文字');
    element.maxLength = 1000; element.value = item.node.text;
    element.style.cssText = `left:${item.x - item.width / 2}px;top:${item.y - item.height / 2}px;width:${item.width}px;height:${Math.max(item.height, 66)}px`;
    world.append(element); inline = { element, id: selected }; element.focus(); element.select();
    element.onpointerdown = event => event.stopPropagation();
    element.onblur = () => { if (inline?.element === element) { try { finishEdit(); } catch (error) { message(error.message); } } };
    element.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEdit(true); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); finishEdit(); }
    };
  };
  const add = sibling => {
    const entry = current(); if (!entry || (sibling && !entry.parent)) return;
    if (all().length >= 500) throw new Error('可视化编辑最多支持 500 个主题');
    const parent = sibling ? entry.parent : entry.node;
    const node = { id: `n${crypto.randomUUID().replaceAll('-', '')}`, text: sibling ? '分支主题' : '子主题', raw: null, collapsed: false, children: [] };
    mutate(() => {
      parent.children.splice(sibling ? parent.children.indexOf(entry.node) + 1 : parent.children.length, 0, node);
      parent.collapsed = false; selected = node.id;
    }); editTopic();
  };
  const remove = () => {
    const entry = current(); if (!entry?.parent) return;
    mutate(() => { entry.parent.children.splice(entry.parent.children.indexOf(entry.node), 1); selected = entry.parent.id; });
  };
  const undo = direction => {
    const next = cursor + direction; if (next < 0 || next >= history.length) return;
    cursor = next; model = structuredClone(history[cursor].model); selected = history[cursor].selected;
    source = history[cursor].source; sourceField.value = source; modified = source !== block.source; draw();
  };
  const closeContext = () => { q('.mm-context').hidden = true; context = null; };
  const invoke = action => {
    try { closeContext(); if (finishEdit()) { const pending = action(); pending?.catch(error => message(error.message)); } }
    catch (error) { message(error.message); }
  };
  button(q('.mm-tools'), '添加子主题', 'GitBranchPlus', () => add(false), 'Tab');
  button(q('.mm-tools'), '添加同级主题', 'ListPlus', () => add(true), 'Enter');
  button(q('.mm-tools'), '编辑主题', 'Pencil', editTopic, 'F2');
  button(q('.mm-tools'), '删除主题', 'Trash2', remove, 'Delete');
  button(q('.mm-tools'), '折叠或展开分支', 'FoldVertical', () => mutate(() => { current().node.collapsed = !current().node.collapsed; }), 'Ctrl+/');
  button(q('.mm-tools'), '导图撤销', 'Undo2', () => undo(-1), 'Ctrl+Z');
  button(q('.mm-tools'), '导图重做', 'Redo2', () => undo(1), 'Ctrl+Shift+Z');
  button(q('.mm-tools'), '源文本', 'Code2', () => sourceMode ? applySource() : setMode(true));
  button(q('.mm-viewport-tools'), '缩小导图', 'Minus', () => zoom(1 / 1.2));
  const zoomOutput = document.createElement('output'); zoomOutput.setAttribute('aria-label', '导图缩放'); q('.mm-viewport-tools').append(zoomOutput);
  button(q('.mm-viewport-tools'), '放大导图', 'Plus', () => zoom(1.2));
  button(q('.mm-viewport-tools'), '适应画布', 'Scan', fit);
  button(q('.mm-viewport-tools'), '实际大小', 'Square', () => zoom(1 / scale));
  for (const [value, name, color] of [['classic', '经典', '#347bb5'], ['bright', '鲜明', '#dc597a'], ['quiet', '柔和', '#578e83']]) {
    const element = document.createElement('button'); element.type = 'button'; element.className = 'mm-palette'; element.dataset.palette = value;
    element.style.setProperty('--swatch', color); element.title = `${name}配色`; element.setAttribute('aria-label', `${name}配色`);
    element.onclick = () => invoke(() => mutate(() => { model.palette = value; })); q('.mm-palettes').append(element);
  }
  q('[aria-label="导图布局"]').onchange = event => invoke(() => { mutate(() => { model.layout = event.target.value; }); fit(); });
  const setMode = value => {
    sourceMode = value; q('.mm-source').hidden = !value; stage.hidden = value; q('.mm-viewport-tools').hidden = value;
    updateControls(); if (value) sourceField.focus(); else { fit(); stage.focus(); }
  };
  const applySource = async () => {
    if (model && sourceField.value === source) { setMode(false); message(''); return true; }
    const ticket = ++parsing, candidate = sourceField.value;
    q('[data-mm-apply]').disabled = true;
    try {
      const parsed = await parseMindmap(candidate);
      if (disposed || ticket !== parsing || candidate !== sourceField.value) return false;
      model = parsed; selected = model.root.id; source = candidate; modified = source !== block.source;
      remember();
      draw(); setMode(false); message(''); return true;
    } catch (error) { if (!disposed && ticket === parsing) message(error.message); return false; }
    finally { if (!disposed && ticket === parsing) q('[data-mm-apply]').disabled = false; }
  };
  q('[data-mm-apply]').onclick = () => void applySource();
  sourceField.oninput = updateControls; title.oninput = updateControls;
  const showContext = event => {
    const menu = q('.mm-context'); menu.replaceChildren(); menu.hidden = false; context = selected;
    for (const name of ['添加子主题', '添加同级主题', '编辑主题', '折叠或展开分支', '删除主题']) {
      const control = document.createElement('button'); control.type = 'button'; control.setAttribute('role', 'menuitem');
      control.textContent = name; control.disabled = buttons.get(name).disabled;
      control.onclick = () => buttons.get(name).click(); menu.append(control);
    }
    const box = q('.mm-workspace').getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(box.width - menu.offsetWidth - 6, event.clientX - box.left))}px`;
    menu.style.top = `${Math.max(4, Math.min(box.height - menu.offsetHeight - 6, event.clientY - box.top))}px`;
    menu.querySelector('button').focus();
  };
  stage.addEventListener('keydown', event => {
    if (inline || event.isComposing || event.keyCode === 229 || sourceMode || !model) return;
    const key = event.key, command = event.ctrlKey || event.metaKey;
    let action;
    if (command && key.toLowerCase() === 'z') action = () => undo(event.shiftKey ? 1 : -1);
    else if (command && key.toLowerCase() === 'y') action = () => undo(1);
    else if (key === 'Tab' && !event.shiftKey) action = () => add(false);
    else if (key === 'Enter') action = () => add(!!current()?.parent);
    else if (key === 'F2' || key === ' ') action = editTopic;
    else if (key === 'Delete' || key === 'Backspace') action = remove;
    else if (command && key === '/') action = () => { if (current().node.children.length) mutate(() => { current().node.collapsed = !current().node.collapsed; }); };
    else if (key.startsWith('Arrow')) action = () => {
      const entry = current();
      if (event.altKey && entry.parent && ['ArrowUp', 'ArrowDown'].includes(key)) {
        const children = entry.parent.children, index = children.indexOf(entry.node), next = index + (key === 'ArrowUp' ? -1 : 1);
        if (next >= 0 && next < children.length) mutate(() => { [children[index], children[next]] = [children[next], children[index]]; });
      } else if (key === 'ArrowLeft' && entry.parent) select(entry.parent.id);
      else if (key === 'ArrowRight' && entry.node.children.length) {
        if (entry.node.collapsed) mutate(() => { entry.node.collapsed = false; }); select(entry.node.children[0].id);
      } else {
        const visible = layout.nodes, index = visible.findIndex(item => item.node.id === selected);
        select(visible[Math.max(0, Math.min(visible.length - 1, index + (key === 'ArrowUp' ? -1 : 1)))].node.id);
      }
    };
    if (action) { event.preventDefault(); event.stopPropagation(); invoke(action); }
  });
  stage.addEventListener('wheel', event => {
    if (inline) return;
    event.preventDefault(); const box = stage.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.002), { x: event.clientX - box.left, y: event.clientY - box.top });
    else { pan.x -= event.deltaX; pan.y -= event.deltaY; transform(); }
  }, { passive: false });
  stage.onpointerdown = event => {
    if (!model || sourceMode || event.button !== 0 || event.target.closest('button,textarea')) return;
    finishEdit(); closeContext();
    const node = event.target.closest('[data-topic]'); if (node) select(node.dataset.topic); else stage.focus();
    gesture = { pointer: event.pointerId, id: node?.dataset.topic, x: event.clientX, y: event.clientY, pan: { ...pan }, moved: false };
  };
  stage.onpointermove = event => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
    gesture.moved = true;
    if (!stage.hasPointerCapture(event.pointerId)) stage.setPointerCapture(event.pointerId);
    if (!gesture.id) { pan = { x: gesture.pan.x + dx, y: gesture.pan.y + dy }; transform(); return; }
    world.querySelectorAll('.mm-drop-target').forEach(element => element.classList.remove('mm-drop-target'));
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-topic]');
    gesture.target = target?.dataset.topic;
    const entry = current();
    if (target && entry?.parent && !flattenMindmap(entry.node).some(item => item.node.id === gesture.target)) target.classList.add('mm-drop-target');
    world.querySelector(`[data-topic="${gesture.id}"]`)?.classList.add('mm-dragging');
  };
  const endGesture = (event, cancel = false) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const previous = gesture; gesture = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    world.querySelectorAll('.mm-drop-target,.mm-dragging').forEach(element => element.classList.remove('mm-drop-target', 'mm-dragging'));
    if (!cancel && previous.moved && previous.id && previous.target && previous.id !== previous.target)
      invoke(() => mutate(() => moveMindmap(model, previous.id, previous.target)));
  };
  stage.onpointerup = event => endGesture(event);
  stage.onpointercancel = event => endGesture(event, true);
  const dirty = () => modified || sourceField.value !== source || title.value !== block.label;
  const requestClose = () => { if (finishEdit() && dirty()) q('.mm-discard').hidden = false; else dialog.close(); };
  q('[data-mm-cancel]').onclick = requestClose;
  dialog.querySelector('[data-modal-close]').onclick = requestClose;
  q('[data-mm-continue]').onclick = () => { q('.mm-discard').hidden = true; (sourceMode ? sourceField : stage).focus(); };
  q('[data-mm-discard]').onclick = () => dialog.close();
  const cancel = event => { event.preventDefault(); if (inline) finishEdit(true); else if (context) { closeContext(); stage.focus(); } else requestClose(); };
  dialog.addEventListener('cancel', cancel);
  q('[data-mm-save]').onclick = async () => {
    if (!finishEdit()) return;
    const save = q('[data-mm-save]'); save.disabled = true;
    try {
      const candidate = sourceMode ? sourceField.value : source;
      const label = title.value;
      const next = validateBlock({ ...block, label, source: candidate });
      // Source fallback can keep advanced Mermaid syntax without a lossy tree conversion.
      if (/%%\{|^\s*---|\bclick\s|<\/?(?:script|iframe|img|image)\b/i.test(candidate)) throw new Error('图表包含不允许的配置或外部内容');
      await mermaid.parse(candidate);
      if (disposed || !dialog.open || !root.isConnected) return;
      if (candidate !== (sourceMode ? sourceField.value : source) || title.value !== label) { message('导图仍在修改，请再次保存'); return; }
      commit(next); dialog.close();
    } catch (error) { message(`无法保存：${error.message}`); fail?.('导图未保存，请检查提示'); }
    finally { if (!disposed) save.disabled = false; }
  };
  const resize = new ResizeObserver(() => { if (!inline) fit(); }); resize.observe(stage);
  dialog.addEventListener('close', () => {
    disposed = true; parsing++; resize.disconnect(); dialog.removeEventListener('cancel', cancel);
    if (dialog.contains(root)) dialog.classList.remove('mindmap-dialog');
  }, { once: true });
  updateControls();
  void (async () => {
    const ticket = ++parsing;
    try {
      const parsed = await parseMindmap(block.source);
      if (disposed || !root.isConnected || ticket !== parsing) return;
      model = parsed;
      selected = model.root.id; history = [{ model: structuredClone(model), selected, source }]; cursor = 0;
      draw(); fit(); if (!sourceMode) stage.focus();
    } catch (error) {
      if (disposed || !root.isConnected || ticket !== parsing) return;
      setMode(true); message(error.message);
    }
  })();
}
