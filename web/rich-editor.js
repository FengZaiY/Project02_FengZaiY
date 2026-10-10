import { Node, mergeAttributes } from '@tiptap/core';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './rich.css';
import { createElement, icons } from 'lucide';
import { validateBlock, safeNoteLink, encodeBlock } from '../src/core/rich-schema.mjs';
import { openCanvas } from './rich-canvas.js';
import { layoutAttributes, applyLayout, fitMedia, blockInteractions, layoutExtensions } from './block-layout.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const diagramTemplates = {
  flow: ['流程图', 'flowchart TD\n  A[收集资料] --> B[整理笔记]\n  B --> C{确认}\n  C -->|通过| D[入库]\n  C -->|修改| B'],
  architecture: ['框架 / 架构图', 'flowchart TB\n  subgraph 用户界面\n    A[笔记编辑器]\n    B[资料阅读器]\n  end\n  subgraph 本机服务\n    C[版本管理]\n    D[附件管理]\n  end\n  A --> C\n  B --> D\n  C --> E[(知识库)]\n  D --> E'],
  mindmap: ['思维导图', 'mindmap\n  root((学习主题))\n    基础概念\n      定义\n      示例\n    实践\n      步骤\n      问题'],
  kanban: ['看板', 'kanban\n  todo[待办]\n    a[收集资料]\n    b[核对来源]\n  doing[进行中]\n    c[整理笔记]\n  done[已完成]\n    d[创建知识库]'],
  gantt: ['甘特图', 'gantt\n  title 学习安排\n  dateFormat YYYY-MM-DD\n  section 准备\n  收集资料 :a, 2026-10-09, 3d\n  section 实践\n  整理笔记 :after a, 4d'],
  sequence: ['UML 时序图', 'sequenceDiagram\n  participant U as 用户\n  participant N as 笔记\n  participant D as 数据库\n  U->>N: 编辑\n  N->>D: 保存版本\n  D-->>U: 保存完成'],
  class: ['UML 类图', 'classDiagram\n  class Note {\n    +String title\n    +save()\n  }\n  class Asset {\n    +String hash\n  }\n  Note "1" --> "*" Asset : 引用'],
  state: ['UML 状态图', 'stateDiagram-v2\n  [*] --> 草稿\n  草稿 --> 待确认\n  待确认 --> 正式笔记\n  正式笔记 --> [*]'],
  pie: ['饼图', 'pie title 学习时间\n  "阅读" : 40\n  "实践" : 45\n  "整理" : 15'],
  bar: ['柱状图', 'xychart-beta\n  x-axis ["周一", "周二", "周三", "周四"]\n  y-axis "小时" 0 --> 5\n  bar [2, 3, 1, 4]'],
  line: ['折线图', 'xychart-beta\n  x-axis ["周一", "周二", "周三", "周四"]\n  y-axis "小时" 0 --> 5\n  line [2, 3, 1, 4]']
};
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true,
  maxTextSize: 30000, maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false },
  fontFamily: 'Microsoft YaHei, sans-serif' });
let diagramId = 0;
const renderTokens = new WeakMap();

export function cleanNoteHtml(html) {
  // JSON arrows such as --> must not look like XML comment delimiters to the sanitizer.
  const inert = document.createElement('template'); inert.innerHTML = html;
  for (const figure of inert.content.querySelectorAll('figure[data-ss-block]')) {
    try { figure.setAttribute('data-ss-block', encodeBlock(JSON.parse(figure.getAttribute('data-ss-block')))); } catch {}
  }
  const clean = DOMPurify.sanitize(inert.innerHTML, { ALLOW_DATA_ATTR: false, ADD_ATTR: ['data-ss-block', 'data-ss-layout', 'data-ss-row', 'data-ss-container', 'data-type', 'data-checked', 'data-callout', 'colwidth'],
    ADD_URI_SAFE_ATTR: ['data-ss-block', 'data-ss-layout', 'data-ss-row', 'data-ss-container', 'data-type', 'data-checked', 'data-callout', 'colwidth'],
    FORBID_ATTR: ['id', 'name'], FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'style', 'input', 'form', 'button', 'select', 'textarea', 'svg', 'math'],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|studyself:\/\/(?:note|asset|local)\/)/i });
  const template = document.createElement('template'); template.innerHTML = clean;
  for (const a of template.content.querySelectorAll('a')) if (!safeNoteLink(a.getAttribute('href'))) a.removeAttribute('href');
  return template.innerHTML;
}
export async function renderBlock(host, block, mediaUrl) {
  const token = {}; renderTokens.set(host, token); host.replaceChildren(); host.classList.remove('rich-error');
  try {
    validateBlock(block);
    if (block.kind === 'formula') host.innerHTML = katex.renderToString(block.source, { displayMode: true, throwOnError: true, trust: false, strict: 'error', maxExpand: 500, maxSize: 20 });
    else if (block.kind === 'diagram') {
      if (/%%\{|^\s*---|\bclick\s|<\/?(?:script|iframe|img|image)\b/i.test(block.source)) throw new Error('图表不允许配置指令、外部图片或交互脚本');
      const result = await mermaid.render(`ss-diagram-${++diagramId}`, block.source);
      if (renderTokens.get(host) !== token) return false;
      host.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a'] });
      host.querySelector('svg')?.removeAttribute('height');
    } else if (['image', 'video'].includes(block.kind)) {
      const media = document.createElement(block.kind === 'image' ? 'img' : 'video');
      if (block.kind === 'video') { media.controls = true; media.preload = 'metadata'; }
      else { media.alt = block.label; media.loading = 'lazy'; media.draggable = false; }
      media.addEventListener(block.kind === 'video' ? 'loadedmetadata' : 'load', () => {
        const figure = host.closest('.rich-block'); if (figure) fitMedia(figure);
      });
      media.src = mediaUrl(block.assetId); host.append(media);
      media.onerror = () => { if (renderTokens.get(host) === token) { host.textContent = '媒体未下载、格式不支持或校验失败。'; const a = document.createElement('a'); a.href = `studyself://asset/${block.assetId}`; a.textContent = '关联附件'; host.append(a); } };
    } else if (block.kind === 'sticker') {
      const paper = document.createElement('div'); paper.className = `rich-sticker ${block.color}`; paper.textContent = block.text; host.append(paper);
    } else if (block.kind === 'canvas') {
      const { canvasPreview } = await import('./rich-canvas.js');
      canvasPreview(host, block.shapes);
    }
    host.removeAttribute('data-error'); return true;
  } catch (error) {
    if (renderTokens.get(host) !== token) return false;
    host.dataset.error = 'true'; host.classList.add('rich-error'); host.textContent = `无法显示：${error.message}`; return false;
  }
}
export function hydrateRich(root, mediaUrl) {
  for (const element of root.querySelectorAll('[data-ss-layout], [data-ss-container], [data-ss-row]')) {
    if (element.dataset.ssRow) element.classList.add('block-row');
    else {
      if (element.dataset.ssContainer) {
        element.classList.add('layout-block');
        if (!element.dataset.hydrated) {
          const content = document.createElement('div'); content.className = 'layout-content';
          content.append(...element.childNodes); element.append(content); element.dataset.hydrated = 'true';
        }
      }
      try { applyLayout(element, element.dataset.ssLayout ? JSON.parse(element.dataset.ssLayout) : null); } catch {}
    }
  }
  for (const figure of root.querySelectorAll('figure[data-ss-block]')) {
    if (figure.dataset.hydrated) continue;
    figure.dataset.hydrated = 'true'; figure.classList.add('rich-block');
    try {
      const block = JSON.parse(figure.dataset.ssBlock), host = document.createElement('div'); host.className = 'rich-content';
      figure.dataset.blockKind = block.kind;
      figure.replaceChildren(host); void renderBlock(host, block, mediaUrl);
      const caption = document.createElement('figcaption'); caption.textContent = block.label; figure.append(caption);
    } catch { figure.textContent = '富内容数据不可读取，原始内容仍保留在版本中。'; }
  }
}
export function richExtensions({ mediaUrl, edit }) {
  return [...layoutExtensions(), TaskList, TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' }, a11y: { checkboxLabel: node => `完成任务：${node.textContent || '未命名任务'}` } }), Highlight.configure({ multicolor: false }),
    Node.create({ name: 'callout', group: 'block', content: 'block+', defining: true,
      parseHTML: () => [{ tag: 'aside[data-callout]' }], renderHTML: ({ HTMLAttributes }) => ['aside', mergeAttributes(HTMLAttributes, { 'data-callout': 'note', class: 'note-callout' }), 0] }),
    Node.create({ name: 'richBlock', group: 'block', atom: true,
      addAttributes: () => ({ ...layoutAttributes(), payload: { default: '', parseHTML: element => element.getAttribute('data-ss-block'), renderHTML: attrs => ({ 'data-ss-block': attrs.payload }) } }),
      parseHTML: () => [{ tag: 'figure[data-ss-block]' }],
      renderHTML: ({ HTMLAttributes, node }) => { let label = '富内容'; try { label = JSON.parse(node.attrs.payload).label; } catch {} return ['figure', mergeAttributes(HTMLAttributes), ['figcaption', label]]; },
      addNodeView() { return ({ node, editor, getPos }) => {
        const dom = document.createElement('figure'); dom.className = 'rich-block'; dom.contentEditable = 'false';
        const host = document.createElement('div'); host.className = 'rich-content'; dom.append(host);
        const footer = document.createElement('figcaption'), label = document.createElement('span'); footer.append(label); dom.append(footer);
        let current = node;
        const dispose = blockInteractions({ dom, editor, getPos, getNode: () => current });
        const draw = () => { dom.dataset.ssBlock = current.attrs.payload; dom.dataset.hydrated = 'true'; try { const block = JSON.parse(current.attrs.payload); dom.dataset.blockKind = block.kind; label.textContent = block.label; label.title = block.label; void renderBlock(host, block, mediaUrl); } catch { host.textContent = '富内容数据无法解析'; } };
        const actions = document.createElement('div'); actions.className = 'block-actions'; dom.append(actions);
        const control = (title, icon, handler) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-button'; b.title = title; b.setAttribute('aria-label', title); b.append(createElement(icon)); b.onclick = handler; actions.append(b); };
        control('编辑内容块', icons.Pencil, () => edit(JSON.parse(current.attrs.payload), next => {
          if (editor.isDestroyed || typeof getPos() !== 'number') return;
          editor.chain().focus().setNodeSelection(getPos()).updateAttributes('richBlock', { payload: encodeBlock(validateBlock(next)) }).run();
        }));
        control('移除内容块', icons.Trash2, () => { if (typeof getPos() === 'number') editor.chain().focus().setNodeSelection(getPos()).deleteSelection().run(); });
        // Async renderers mutate their display DOM, never the serialized editor document.
        applyLayout(dom, node.attrs.layout);
        draw(); return { dom, stopEvent: event => !!event.target.closest('button,video,a'), ignoreMutation: mutation => mutation.type !== 'selection',
          update(next) { if (next.type !== current.type) return false; const changed = next.attrs.payload !== current.attrs.payload; current = next; applyLayout(dom, next.attrs.layout); if (changed) draw(); return true; },
          destroy() { dispose(); renderTokens.delete(host); } };
      }; }
    })];
}
export function addRichMarkdownRules(converter) {
  converter.addRule('studyself-layout', { filter: node => node.hasAttribute?.('data-ss-row') || node.hasAttribute?.('data-ss-container'),
    replacement: (_text, node) => `\n\n${node.outerHTML}\n\n` });
  converter.addRule('studyself-block', { filter: node => node.nodeName === 'FIGURE' && node.hasAttribute('data-ss-block'),
    replacement: (_text, node) => `\n\n${node.outerHTML}\n\n` });
  converter.addRule('studyself-callout', { filter: node => node.nodeName === 'ASIDE' && node.hasAttribute('data-callout'), replacement: text => `\n\n> [!NOTE]\n${text.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n` });
  converter.addRule('studyself-task', { filter: node => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem', replacement: (text, node) => `\n- [${node.getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${text.trim()}\n` });
}
export function editRichBlock(block, commit, { openModal, mediaUrl, fail }) {
  if (block.kind === 'canvas') { openCanvas(block, commit, { openModal, fail }); return; }
  const diagramOptions = Object.entries(diagramTemplates).map(([id, [name]]) => `<option value="${id}">${name}</option>`).join('');
  const body = `<form id="rich-form" class="settings-form"><label>标题<input name="label" maxlength="200" value="${esc(block.label)}"></label>
    ${block.kind === 'diagram' ? `<label>图表模板<select id="diagram-template"><option value="">自定义</option>${diagramOptions}</select></label>` : ''}
    ${['formula', 'diagram'].includes(block.kind) ? `<label>${block.kind === 'formula' ? 'LaTeX 公式' : 'Mermaid 图表源文本'}<textarea name="source" rows="8" spellcheck="false" maxlength="${block.kind === 'formula' ? 10000 : 30000}">${esc(block.source)}</textarea></label>` : ''}
    ${block.kind === 'sticker' ? `<label>贴纸内容<textarea name="text" maxlength="2000" rows="4">${esc(block.text)}</textarea></label><fieldset class="sticker-colors"><legend>颜色</legend>${['yellow', 'green', 'pink', 'blue'].map((color, index) => `<label class="color-swatch ${color}" title="${['黄色', '绿色', '粉色', '蓝色'][index]}"><input type="radio" name="color" value="${color}" ${block.color === color ? 'checked' : ''} aria-label="${['黄色', '绿色', '粉色', '蓝色'][index]}"></label>`).join('')}</fieldset>` : ''}
    <div id="rich-preview" class="rich-preview"></div><div class="form-actions"><button type="button" class="secondary" id="preview-rich">预览</button><button type="submit" class="primary">保存内容块</button></div></form>`;
  const dialog = openModal('编辑内容块', body); dialog.classList.add('rich-dialog');
  dialog.addEventListener('close', () => dialog.classList.remove('rich-dialog'), { once: true });
  const form = dialog.querySelector('form'), preview = dialog.querySelector('#rich-preview');
  const value = () => validateBlock({ ...block, ...Object.fromEntries(new FormData(form)) });
  const show = async () => { try { return await renderBlock(preview, value(), mediaUrl); } catch (error) { fail(error.message); return false; } };
  dialog.querySelector('#preview-rich').onclick = show;
  const templates = dialog.querySelector('#diagram-template');
  if (templates) templates.onchange = () => { const template = diagramTemplates[templates.value]; if (template) { form.elements.source.value = template[1]; form.elements.label.value = template[0]; void show(); } };
  form.onsubmit = async event => { event.preventDefault(); if (await show() && dialog.open && form.isConnected) { commit(value()); dialog.close(); } };
  void show();
}
