import { Extension } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TableMap } from '@tiptap/pm/tables';
import { createElement, icons } from 'lucide';
import { textMatches, parseClipboardTable, quoteTsv, copyText } from './editor-text.js';
import { clipboardCodePaste } from './code-paste.js';
import { parseNoteLink } from '../src/core/rich-schema.mjs';
import { handleEditorShortcut, shortcutHelp } from './editor-shortcuts.js';
import './editor-experience.css';

const markKey = new PluginKey('fengzaiyFind');
export const editorMarkers = Extension.create({
  name: 'fengzaiyMarkers',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: markKey,
      state: {
        init: () => ({ query: '', decorations: DecorationSet.empty }),
        apply(tr, previous) {
          const query = tr.getMeta(markKey)?.query ?? previous.query;
          if (!tr.docChanged && !tr.getMeta(markKey)) return previous;
          return { query, decorations: DecorationSet.create(tr.doc, textMatches(tr.doc, query).map(range =>
            Decoration.inline(range.from, range.to, { class: 'editor-match' }))) };
        }
      },
      props: { decorations: state => markKey.getState(state).decorations }
    })];
  }
});

function control(title, symbol, handler) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'icon-button'; el.title = title; el.setAttribute('aria-label', title);
  el.append(createElement(icons[symbol] || icons.Plus)); el.onclick = handler;
  return el;
}

export const experienceCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('div'); dom.className = 'code-surface';
      const tools = document.createElement('div'); tools.className = 'code-tools'; tools.contentEditable = 'false';
      const symbol = createElement(icons.Code); symbol.classList.add('code-language-icon'); symbol.setAttribute('aria-hidden', 'true');
      const language = document.createElement('select'); language.setAttribute('aria-label', '代码语言');
      for (const [value, label] of [['', '纯文本'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'], ['json', 'JSON'], ['html', 'HTML'], ['css', 'CSS'], ['bash', 'Shell'], ['sql', 'SQL'], ['markdown', 'Markdown']]) {
        language.add(new Option(label, value));
      }
      const setLanguage = () => {
        const value = current.attrs.language || '';
        if (![...language.options].some(option => option.value === value)) language.add(new Option(value, value));
        language.value = value;
      };
      setLanguage();
      language.onchange = () => {
        if (typeof getPos() === 'number') editor.view.dispatch(editor.state.tr.setNodeMarkup(getPos(), undefined, { ...current.attrs, language: language.value || null }));
        editor.commands.focus();
      };
      const wrap = control('代码自动换行', 'WrapText', () => {
        const wrapped = dom.classList.toggle('code-wrap'); wrap.setAttribute('aria-pressed', String(wrapped));
      });
      wrap.setAttribute('aria-pressed', 'false');
      const status = document.createElement('span'); status.className = 'code-copy-status'; status.setAttribute('role', 'status');
      let feedbackTimer;
      const copy = control('复制代码', 'Copy', async () => {
        clearTimeout(feedbackTimer);
        try { await copyText(current.textContent); status.textContent = '已复制'; }
        catch (error) { status.textContent = error.message; }
        feedbackTimer = setTimeout(() => { status.textContent = ''; }, 2500);
      });
      tools.append(symbol, language, status, wrap, copy);
      const pre = document.createElement('pre'), code = document.createElement('code'); pre.append(code); dom.append(tools, pre);
      return { dom, contentDOM: code,
        update(next) { if (next.type !== current.type) return false; current = next; setLanguage(); return true; },
        stopEvent: event => tools.contains(event.target),
        ignoreMutation: mutation => mutation.type !== 'selection' && !code.contains(mutation.target),
        destroy() { clearTimeout(feedbackTimer); }
      };
    };
  }
}).configure({ enableTabIndentation: true, tabSize: 2 });

export function mountEditorExperience({ editor, panel, insert, link, annotate, references, lookup, openRecord, libraryName, toast }) {
  const disposers = [], body = document.body, scroll = panel.querySelector('.editor-scroll');
  let stopped = false, composing = false, menuRange = null, choices = [], choiceIndex = 0, queryStamp = '', referenceAll = false, generation = 0;
  let findIndex = -1, headings = [], outlineFrame, updateTimer, hoverTimer, tipGeneration = 0;
  const listen = (target, name, fn, options) => { target.addEventListener(name, fn, options); disposers.push(() => target.removeEventListener(name, fn, options)); };
  const floating = (className, role) => {
    const el = document.createElement('div'); el.className = className; el.hidden = true;
    el.setAttribute('role', role); body.append(el); disposers.push(() => el.remove()); return el;
  };
  const bubble = floating('selection-tools', 'toolbar'); bubble.setAttribute('aria-label', '选中文字工具');
  const menu = floating('editor-command-menu', 'dialog'); menu.setAttribute('aria-label', '快捷插入');
  const tip = floating('note-link-preview', 'dialog');
  const status = document.createElement('span'); status.className = 'editor-copy-status'; status.setAttribute('role', 'status');
  bubble.append(status);
  const perform = fn => { if (!editor.isDestroyed) fn(); };
  const formatButtons = [];
  for (const [label, icon, mark, command] of [
    ['加粗选中文字', 'Bold', 'bold', 'toggleBold'], ['斜体选中文字', 'Italic', 'italic', 'toggleItalic'],
    ['高亮选中文字', 'Highlighter', 'highlight', 'toggleHighlight'], ['行内代码', 'Code', 'code', 'toggleCode']
  ]) {
    const button = control(label, icon, () => perform(() => editor.chain().focus()[command]().run()));
    formatButtons.push([button, mark]); bubble.append(button);
  }
  bubble.append(control('为选中文字添加链接', 'Link', () => link()), control('为选中文字添加备注', 'MessageSquarePlus', () => annotate()),
    control('清除文字格式', 'Eraser', () => editor.chain().focus().unsetAllMarks().run()),
    control('复制选中文字', 'Copy', async () => {
      try { const { from, to } = editor.state.selection; await copyText(editor.state.doc.textBetween(from, to, '\n')); status.textContent = '已复制'; }
      catch (error) { toast(error.message, true); }
    }));
  listen(bubble, 'mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  const position = (el, rect, below = false) => {
    el.hidden = false;
    const box = el.getBoundingClientRect(), maxLeft = Math.max(8, innerWidth - box.width - 8);
    el.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    const top = below ? rect.bottom + 6 : rect.top - box.height - 7;
    el.style.top = `${Math.max(8, Math.min(top < 8 ? rect.bottom + 6 : top, innerHeight - box.height - 8))}px`;
  };
  const cursorRect = () => editor.view.coordsAtPos(editor.state.selection.from);
  const closeMenu = () => { menu.hidden = true; menuRange = null; queryStamp = ''; generation++; };
  function updateBubble() {
    const selection = editor.state.selection;
    const active = document.activeElement;
    if (composing || editor.view.composing || selection.empty || selection.node || !menu.hidden
      || (!editor.view.hasFocus() && !bubble.contains(active)) || document.querySelector('dialog[open]')) { bubble.hidden = true; return; }
    const range = window.getSelection();
    if (!range?.rangeCount) { bubble.hidden = true; return; }
    const rect = range.getRangeAt(0).getBoundingClientRect(), area = scroll.getBoundingClientRect();
    if (rect.bottom < area.top || rect.top > area.bottom) { bubble.hidden = true; return; }
    formatButtons.forEach(([button, mark]) => button.setAttribute('aria-pressed', String(editor.isActive(mark))));
    position(bubble, rect); status.textContent = '';
  }
  const commands = [
    ...[1, 2, 3, 4, 5, 6].map(level => ({ name: `标题 ${level}`, symbol: 'Heading', execute: () => editor.chain().focus().setHeading({ level }).run() })),
    { name: '正文', symbol: 'Text', execute: () => editor.chain().focus().setParagraph().run() },
    ...[['无序列表', 'List', 'toggleBulletList'], ['有序列表', 'ListOrdered', 'toggleOrderedList'], ['任务列表', 'ListChecks', 'toggleTaskList'],
      ['引用段落', 'Quote', 'toggleBlockquote'], ['代码块', 'Code', 'toggleCodeBlock']].map(([name, symbol, method]) => ({ name, symbol, execute: () => editor.chain().focus()[method]().run() })),
    ...[['表格', 'Table', 'table'], ['图片', 'Image', 'image'], ['视频', 'Video', 'video'], ['高亮块', 'Highlighter', 'callout'],
      ['贴纸', 'StickyNote', 'sticker'], ['数学公式', 'Sigma', 'formula'], ['流程图', 'Workflow', 'diagram:flow'],
      ['架构图', 'Network', 'diagram:architecture'], ['思维导图', 'Brain', 'diagram:mindmap'], ['看板', 'Columns3', 'diagram:kanban'],
      ['甘特图', 'ChartGantt', 'diagram:gantt'], ['时序图', 'GitBranch', 'diagram:sequence'], ['类图', 'Boxes', 'diagram:class'],
      ['状态图', 'Waypoints', 'diagram:state'], ['饼图', 'ChartPie', 'diagram:pie'], ['柱状图', 'ChartColumn', 'diagram:bar'],
      ['折线图', 'ChartLine', 'diagram:line'], ['无限画板', 'PenTool', 'canvas']].map(([name, symbol, kind]) => ({ name, symbol, execute: () => insert(kind) }))
  ];
  function choose(index) {
    const item = choices[index], range = menuRange;
    if (!item || !range || editor.isDestroyed) return;
    closeMenu(); bubble.hidden = true;
    editor.chain().focus().deleteRange(range).run();
    item.execute();
  }
  function drawChoices(items, isReference = false) {
    choices = items; choiceIndex = 0; menu.replaceChildren();
    if (isReference) {
      const label = document.createElement('label'); label.className = 'reference-scope';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = referenceAll;
      label.append(input, '其他知识库');
      input.onchange = () => { referenceAll = input.checked; queryStamp = ''; void updateCommands(); };
      menu.append(label);
    }
    const list = document.createElement('div'); list.className = 'editor-command-list'; list.setAttribute('role', 'listbox');
    items.forEach((item, i) => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(i === 0));
      button.append(createElement(icons[item.symbol] || icons.FileText));
      const text = document.createElement('span'); text.textContent = item.name; button.append(text);
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => choose(i); list.append(button);
    });
    if (!items.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配项'; list.append(empty); }
    menu.append(list); position(menu, cursorRect(), true); bubble.hidden = true;
  }
  async function updateCommands() {
    if (stopped || composing || editor.view.composing || !editor.state.selection.empty || editor.isActive('codeBlock')) return;
    const { $from, from } = editor.state.selection;
    const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
    const slash = before.match(/^\s*\/([^/\n]{0,60})$/), reference = before.match(/\[\[([^[\]\n]{0,80})$/);
    if (!slash && !reference) { if (!menu.hidden && queryStamp !== 'manual') closeMenu(); return; }
    const match = reference || slash, query = match[1].trim(), stamp = `${reference ? 'ref' : 'slash'}:${from}:${query}:${referenceAll}`;
    if (stamp === queryStamp) return;
    queryStamp = stamp; menuRange = { from: from - match[0].length, to: from };
    if (reference) {
      const serial = ++generation;
      try {
        const records = await references(query, referenceAll);
        if (stopped || serial !== generation || queryStamp !== stamp) return;
        drawChoices(records.map(record => ({ name: `${record.data.title} · ${libraryName(record.data.domain)}`, symbol: 'FileText',
          execute: () => editor.chain().focus().insertContent({ type: 'text', text: record.data.title,
            marks: [{ type: 'link', attrs: { href: `fengzaiy://note/${record.id}` } }] })
            .command(({ tr }) => { tr.removeStoredMark(editor.schema.marks.link); return true; }).insertContent(' ').run()
        })), true);
      } catch (error) { closeMenu(); toast(error.message, true); }
    } else drawChoices(commands.filter(item => item.name.toLowerCase().includes(query.toLowerCase())));
  }
  const toolbar = panel.querySelector('.editor-toolbar');
  listen(toolbar, 'mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  const add = control('在光标处插入', 'Plus', () => {
    editor.commands.focus(); menuRange = { from: editor.state.selection.from, to: editor.state.selection.to }; queryStamp = 'manual'; drawChoices(commands);
  });
  toolbar.append(add);
  const tableTools = document.createElement('div'); tableTools.className = 'context-table-tools'; tableTools.hidden = true; tableTools.setAttribute('aria-label', '表格就地操作');
  for (const [name, symbol, method] of [['在下方插入行', 'Rows3', 'addRowAfter'], ['在右侧插入列', 'Columns3', 'addColumnAfter'],
    ['删除当前行', 'ListMinus', 'deleteRow'], ['删除当前列', 'Columns2', 'deleteColumn'], ['合并选中单元格', 'Combine', 'mergeCells'], ['拆分当前单元格', 'Split', 'splitCell']]) {
    const b = control(name, symbol, () => editor.chain().focus()[method]().run()); b.dataset.command = method; tableTools.append(b);
  }
  tableTools.append(control('复制整张表格', 'Copy', async () => {
    let { $from } = editor.state.selection, table;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'table') { table = $from.node(depth); break; }
    if (!table) return;
    const cells = [], map = TableMap.get(table), seen = new Set();
    for (let row = 0; row < map.height; row++) {
      const values = [];
      for (let col = 0; col < map.width; col++) {
        const position = map.map[row * map.width + col], cell = table.nodeAt(position);
        values.push(seen.has(position) ? '' : quoteTsv(cell?.textBetween(0, cell.content.size, '\n') || '')); seen.add(position);
      }
      cells.push(values.join('\t'));
    }
    try { await copyText(cells.join('\n')); toast('表格已复制'); } catch (error) { toast(error.message, true); }
  }));
  toolbar.after(tableTools);
  listen(tableTools, 'mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });

  const reading = document.createElement('div'); reading.className = 'reading-controls';
  reading.innerHTML = `<label>字号<select aria-label="正文字号"><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option></select></label><label>正文宽度<select aria-label="正文宽度"><option value="comfortable">适中</option><option value="wide">宽屏</option></select></label>`;
  const outline = document.createElement('aside'); outline.className = 'document-outline'; outline.setAttribute('aria-label', '正文目录');
  const outlineTitle = document.createElement('strong'); outlineTitle.textContent = '正文目录';
  const outlineHeading = document.createElement('div'); outlineHeading.className = 'outline-heading';
  outlineHeading.append(outlineTitle, control('收起正文目录', 'X', () => { prefs.outline = false; applyReading(); directoryButton.focus(); }));
  outline.append(outlineHeading);
  const outlineItems = document.createElement('nav'); outline.append(outlineItems);
  const surface = document.createElement('div'); surface.className = 'editor-surface'; scroll.before(surface); surface.append(scroll, outline);
  const readBar = document.createElement('div'); readBar.className = 'editor-reading-bar';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('fengzaiy-reading') ?? localStorage.getItem('studyself-reading') ?? '{}'); } catch {}
  function applyReading() {
    panel.style.setProperty('--reading-size', `${[14, 16, 18, 20].includes(prefs.size) ? prefs.size : 16}px`);
    panel.dataset.readingWidth = prefs.width === 'wide' ? 'wide' : 'comfortable';
    outline.hidden = !prefs.outline;
    document.querySelector('#app')?.classList.toggle('editor-focus', !!prefs.focus);
    directoryButton.setAttribute('aria-pressed', String(!!prefs.outline)); focusButton.setAttribute('aria-pressed', String(!!prefs.focus));
    try { localStorage.setItem('fengzaiy-reading', JSON.stringify(prefs)); } catch {}
  }
  const directoryButton = control('展开或收起正文目录', 'ListTree', () => { prefs.outline = !prefs.outline; applyReading(); });
  const focusButton = control('专注编辑', 'Maximize2', () => { prefs.focus = !prefs.focus; applyReading(); });
  const font = reading.querySelector('[aria-label="正文字号"]'), width = reading.querySelector('[aria-label="正文宽度"]');
  font.value = String([14, 16, 18, 20].includes(prefs.size) ? prefs.size : 16); width.value = prefs.width === 'wide' ? 'wide' : 'comfortable';
  font.onchange = () => { prefs.size = Number(font.value); applyReading(); };
  width.onchange = () => { prefs.width = width.value; applyReading(); };
  readBar.append(directoryButton, focusButton, reading, control('查找与替换', 'Search', () => { finder.hidden = !finder.hidden; if (!finder.hidden) findInput.focus(); }));
  readBar.append(shortcutHelp());
  for (const [action, keys] of [['undo', 'Ctrl+Z'], ['redo', 'Ctrl+Y / Ctrl+Shift+Z']]) {
    const button = toolbar.querySelector(`[data-action="fmt-${action}"]`);
    if (button) button.title = `${button.getAttribute('aria-label')} (${keys})`;
  }
  toolbar.before(readBar); applyReading();
  const finder = document.createElement('div'); finder.className = 'editor-find'; finder.hidden = true;
  finder.innerHTML = '<input aria-label="文内查找" placeholder="查找"><input aria-label="替换为" placeholder="替换为"><output aria-live="polite"></output>';
  const [findInput, replaceInput] = finder.querySelectorAll('input'), count = finder.querySelector('output');
  function mark(query) { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(markKey, { query }).setMeta('addToHistory', false)); }
  function find(step = 1) {
    const matches = textMatches(editor.state.doc, findInput.value);
    count.textContent = `${matches.length ? ((findIndex + step + matches.length) % matches.length) + 1 : 0} / ${matches.length}`;
    mark(findInput.value);
    if (matches.length) { findIndex = (findIndex + step + matches.length) % matches.length; jump(matches[findIndex]); }
  }
  function jump(range) { editor.chain().focus().setTextSelection(range).scrollIntoView().run(); }
  findInput.oninput = () => { findIndex = -1; mark(findInput.value); count.textContent = `${textMatches(editor.state.doc, findInput.value).length} 处`; };
  finder.append(control('上一个匹配', 'ChevronUp', () => find(-1)), control('下一个匹配', 'ChevronDown', () => find(1)));
  const replace = document.createElement('button'); replace.textContent = '替换当前';
  replace.onclick = () => {
    const matches = textMatches(editor.state.doc, findInput.value), selected = matches.find(item => item.from === editor.state.selection.from && item.to === editor.state.selection.to);
    if (!selected) { find(1); return; }
    editor.chain().focus().insertContentAt(selected, replaceInput.value ? { type: 'text', text: replaceInput.value } : '').run(); findIndex = -1; find(1);
  };
  finder.append(replace, control('关闭文内查找', 'X', () => { finder.hidden = true; mark(''); editor.commands.focus(); }));
  readBar.after(finder);
  function refreshOutline() {
    headings = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'heading') headings.push({ pos, title: node.textContent || '未命名章节', level: node.attrs.level }); });
    outlineItems.replaceChildren();
    headings.forEach(heading => {
      const button = document.createElement('button'); button.textContent = heading.title; button.style.paddingLeft = `${8 + (heading.level - 1) * 12}px`;
      button.onclick = () => jump({ from: heading.pos + 1, to: heading.pos + 1 }); outlineItems.append(button); heading.button = button;
    });
    if (!headings.length) outlineItems.textContent = '暂无章节标题';
    trackOutline();
  }
  function trackOutline() {
    cancelAnimationFrame(outlineFrame);
    outlineFrame = requestAnimationFrame(() => {
      if (stopped) return;
      const top = scroll.getBoundingClientRect().top + 45;
      let current = headings[0];
      for (const heading of headings) {
        if (editor.view.nodeDOM(heading.pos)?.getBoundingClientRect?.().top <= top) current = heading;
        heading.button?.removeAttribute('aria-current');
      }
      current?.button?.setAttribute('aria-current', 'location');
    });
  }
  function update() {
    updateBubble();
    const inTable = editor.isActive('table'); tableTools.hidden = !inTable;
    tableTools.querySelectorAll('[data-command]').forEach(button => { button.disabled = !editor.can()[button.dataset.command](); });
    toolbar.querySelectorAll('[data-action^="fmt-"]').forEach(button => {
      const type = { bold: 'bold', italic: 'italic', highlight: 'highlight', list: 'bulletList', ordered: 'orderedList', task: 'taskList', quote: 'blockquote', code: 'codeBlock' }[button.dataset.action.slice(4)];
      if (type) button.setAttribute('aria-pressed', String(editor.isActive(type)));
    });
  }
  const onSelection = () => {
    if (queryStamp === 'manual' && menuRange && (editor.state.selection.from !== menuRange.from || editor.state.selection.to !== menuRange.to)) closeMenu();
    update(); if (queryStamp !== 'manual') void updateCommands();
  };
  const onUpdate = () => {
    if (queryStamp === 'manual') closeMenu();
    update(); void updateCommands(); clearTimeout(updateTimer); updateTimer = setTimeout(refreshOutline, 120);
  };
  editor.on('selectionUpdate', onSelection); editor.on('update', onUpdate);
  listen(document, 'selectionchange', updateBubble);
  listen(editor.view.dom, 'compositionstart', () => { composing = true; bubble.hidden = true; closeMenu(); });
  listen(editor.view.dom, 'compositionend', () => { composing = false; queueMicrotask(() => { if (!stopped) { update(); void updateCommands(); } }); });
  listen(editor.view.dom, 'keydown', event => {
    if (event.isComposing || composing || editor.view.composing) return;
    if (handleEditorShortcut(editor, event)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); finder.hidden = false; findInput.focus(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); link(); return; }
    if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { closeMenu(); return; }
      if (event.key === 'Enter') { choose(choiceIndex); return; }
      choiceIndex = (choiceIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % (choices.length || 1);
      menu.querySelectorAll('[role=option]').forEach((button, i) => { button.setAttribute('aria-selected', String(i === choiceIndex)); if (i === choiceIndex) button.scrollIntoView({ block: 'nearest' }); });
    }
  }, true);
  listen(findInput, 'keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); find(event.shiftKey ? -1 : 1); } });
  listen(document, 'mousedown', event => {
    if (!menu.contains(event.target) && !editor.view.dom.contains(event.target) && !add.contains(event.target)) closeMenu();
    if (!bubble.contains(event.target) && !editor.view.dom.contains(event.target)) bubble.hidden = true;
    if (!tip.contains(event.target)) { tip.hidden = true; tipGeneration++; }
  });
  listen(scroll, 'scroll', () => { updateBubble(); trackOutline(); if (!menu.hidden) position(menu, cursorRect(), true); tip.hidden = true; }, { passive: true });
  listen(window, 'resize', () => { updateBubble(); if (!menu.hidden) position(menu, cursorRect(), true); });

  listen(editor.view.dom, 'paste', event => {
    if (event.defaultPrevented || editor.isActive('codeBlock')) return;
    const clipboard = event.clipboardData; if (!clipboard || clipboard.files.length) return;
    const html = clipboard.getData('text/html'), text = clipboard.getData('text/plain');
    const code = clipboardCodePaste(text, html);
    if (code) {
      event.preventDefault();
      editor.view.pasteHTML(code);
      return;
    }
    if (!html && text.includes('\t') && !editor.isActive('table')) {
      const rows = parseClipboardTable(text); if (!rows) return;
      event.preventDefault();
      editor.chain().focus().insertContent({ type: 'table', content: rows.map(row => ({ type: 'tableRow', content: row.map(value => ({
        type: 'tableCell', content: value.split('\n').map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) }))
      })) })) }).run();
    }
    if (html) {
      const template = document.createElement('template'); template.innerHTML = html;
      if (template.content.querySelector('img,video,iframe,object')) toast('已粘贴可保留的正文；来源中的图片或嵌入内容需另行导入，未自动下载', true);
    }
  }, true);

  listen(editor.view.dom, 'mouseover', event => {
    const anchor = event.target.closest('a'), parsed = parseNoteLink(anchor?.getAttribute('href'));
    clearTimeout(hoverTimer); const serial = ++tipGeneration;
    if (parsed?.kind !== 'note') return;
    hoverTimer = setTimeout(async () => {
      try {
        const record = await lookup(parsed.id);
        if (stopped || tipGeneration !== serial || !anchor.isConnected) return;
        tip.replaceChildren();
        const title = document.createElement('strong'); title.textContent = record?.data.title || '笔记不存在';
        const scope = document.createElement('small'); scope.textContent = record ? libraryName(record.data.domain) : '';
        const summary = document.createElement('p'); summary.textContent = record?.deleted ? '笔记已在回收站' : record?.conflict ? '笔记存在待处理的版本冲突' : record?.summary || '';
        tip.append(title, scope, summary);
        if (record) { const open = document.createElement('button'); open.textContent = '打开笔记'; open.onclick = () => { tip.hidden = true; openRecord(record.id); }; tip.append(open); }
        position(tip, anchor.getBoundingClientRect(), true);
      } catch { if (!stopped && tipGeneration === serial) tip.hidden = true; }
    }, 350);
  });
  listen(editor.view.dom, 'mouseout', event => { if (event.target.closest('a') && !event.target.closest('a').contains(event.relatedTarget)) { clearTimeout(hoverTimer); tipGeneration++; } });
  refreshOutline(); update();

  // Splitter changes only local reading layout, never document dimensions.
  const layout = panel.closest('.reading-layout'), source = layout.querySelector('.source-pane');
  const splitter = document.createElement('div'); splitter.className = 'source-splitter'; splitter.tabIndex = 0;
  splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-label', '调整原附件宽度'); splitter.setAttribute('aria-orientation', 'vertical');
  const resizeSource = value => {
    const width = Math.round(Math.max(180, Math.min(500, value, layout.clientWidth * 0.55)));
    layout.style.setProperty('--source-width', `${width}px`); splitter.setAttribute('aria-valuenow', String(width)); prefs.sourceWidth = width;
  };
  resizeSource(Number(prefs.sourceWidth) || 280); source.after(splitter);
  let drag;
  listen(splitter, 'pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); splitter.setPointerCapture(event.pointerId); drag = { x: event.clientX, width: source.getBoundingClientRect().width }; });
  listen(splitter, 'pointermove', event => { if (drag) resizeSource(drag.width + event.clientX - drag.x); });
  listen(splitter, 'pointerup', () => { drag = null; applyReading(); });
  listen(splitter, 'lostpointercapture', () => { drag = null; });
  listen(splitter, 'keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); resizeSource(prefs.sourceWidth + (event.key === 'ArrowLeft' ? -20 : 20)); applyReading(); } });
  return {
    locate(quote) {
      const matches = textMatches(editor.state.doc, quote);
      mark(quote);
      if (!matches.length) { toast('原文已修改或不在当前正文，备注仍保留', true); return; }
      if (matches.length === 1) { jump(matches[0]); return; }
      menuRange = { from: editor.state.selection.from, to: editor.state.selection.to }; queryStamp = 'manual';
      drawChoices(matches.map((range, i) => ({ name: `第 ${i + 1} 处 · ${editor.state.doc.textBetween(Math.max(0, range.from - 20), Math.min(editor.state.doc.content.size, range.to + 20), ' ')}`, symbol: 'TextSearch', execute: () => jump(range) })));
      // Locating must not delete any selected text.
      menu.querySelectorAll('[role=option]').forEach((button, i) => { button.onclick = () => { closeMenu(); jump(matches[i]); }; });
      choices = matches.map(range => ({ execute: () => jump(range) }));
      menuRange.to = menuRange.from;
      toast(`找到 ${matches.length} 处相同原文，请选择位置`);
    },
    destroy() {
      stopped = true; generation++; tipGeneration++; clearTimeout(updateTimer); clearTimeout(hoverTimer); cancelAnimationFrame(outlineFrame);
      editor.off('selectionUpdate', onSelection); editor.off('update', onUpdate); disposers.forEach(dispose => dispose());
      document.querySelector('#app')?.classList.remove('editor-focus');
    }
  };
}
