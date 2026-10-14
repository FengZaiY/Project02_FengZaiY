// Positions are derived from the document, never from decorated DOM text.
export function textMatches(doc, query) {
  if (!query) return [];
  const matches = [], blocks = [];
  let text = '';
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    if (blocks.length) text += '\n';
    const content = node.textBetween(0, node.content.size, '', '\ufffc');
    blocks.push({ start: text.length, end: text.length + content.length, pos: pos + 1 });
    text += content;
    return false;
  });
  const position = offset => {
    const block = blocks.find(item => offset >= item.start && offset <= item.end);
    return block ? block.pos + offset - block.start : null;
  };
  for (let start = 0; (start = text.indexOf(query, start)) !== -1; start += Math.max(1, query.length)) {
    const from = position(start), to = position(start + query.length);
    if (from !== null && to !== null) matches.push({ from, to });
  }
  return matches;
}

export function diffBlocks(before, after, key = value => JSON.stringify(value)) {
  const a = before.map(key), b = after.map(key);
  // Bound quadratic work for unusually large documents; exact content remains available.
  if (a.length * b.length > 1000000) return [
    ...before.map((value, index) => ({ kind: 'removed', value, index })),
    ...after.map((value, index) => ({ kind: 'added', value, index }))
  ];
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const changes = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changes.push({ kind: 'same', value: after[j], index: j }); i++; j++;
    } else if (j < b.length && (i === a.length || rows[i][j + 1] > rows[i + 1][j])) {
      changes.push({ kind: 'added', value: after[j], index: j++ });
    } else changes.push({ kind: 'removed', value: before[i], index: i++ });
  }
  return changes;
}

export function parseClipboardTable(text) {
  if (!text.includes('\t')) return null;
  // Quoted TSV is emitted by spreadsheets for cells containing tabs/newlines.
  const rows = [[]];
  let cell = '', quoted = false;
  const source = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' && (quoted || cell === '')) {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === '\t' || ch === '\n')) {
      rows.at(-1).push(cell); cell = '';
      if (ch === '\n') rows.push([]);
    } else cell += ch;
  }
  if (quoted) return null;
  rows.at(-1).push(cell);
  if (source.endsWith('\n')) rows.pop();
  const width = Math.max(...rows.map(row => row.length));
  if (width < 2 || rows.length > 200 || width > 50 || rows.length * width > 5000) return null;
  return rows.map(row => Array.from({ length: width }, (_, i) => row[i] || ''));
}

export function quoteTsv(value) {
  return /[\t\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const active = document.activeElement, selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement('textarea');
  input.value = text; input.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(input); input.select();
  const copied = document.execCommand('copy'); input.remove(); active?.focus({ preventScroll: true });
  selection?.removeAllRanges(); ranges.forEach(range => selection?.addRange(range));
  if (!copied) throw new Error('无法访问剪贴板，请使用 Ctrl+C 复制');
}
