import { hierarchy, tree } from 'd3-hierarchy';

export const mindmapPalettes = {
  classic: ['#347bb5', '#c15c70', '#26958c', '#8c6ab1', '#b78326', '#5576bf'],
  bright: ['#087fbc', '#dc597a', '#008d6b', '#9c55b5', '#bd8015', '#5969ce'],
  quiet: ['#52798f', '#a76d7b', '#578e83', '#817696', '#a38751', '#7186ac']
};
const requireValue = (value, message) => { if (!value) throw new Error(message); };
export const isMindmap = source => /^\s*(?:%%[^\n]*\n\s*)*mindmap\b/.test(source || '');
export function flattenMindmap(root) {
  const result = [];
  const walk = (node, parent = null, depth = 0) => {
    requireValue(depth <= 40 && result.length < 500, '可视化编辑最多支持 500 个主题、40 层；请使用源文本保留原图');
    result.push({ node, parent, depth });
    node.children.forEach(child => walk(child, node, depth + 1));
  };
  walk(root);
  return result;
}

// Mermaid owns parsing; raw declarations remain intact until that topic is edited.
export function mindmapFromParsed(source, parsed, plainText = text => text) {
  const lines = source.split(/\r?\n/);
  const metadataLine = line => /^%% (?:fengzaiy|studyself)-mindmap:/.test(line.trim());
  const metaLine = lines.find(metadataLine);
  requireValue(lines.filter(metadataLine).length <= 1, '导图包含重复布局信息，请先在源文本中处理');
  let meta = {};
  if (metaLine) {
    meta = JSON.parse(metaLine.trim().replace(/^%% (?:fengzaiy|studyself)-mindmap:/, ''));
    requireValue(meta.v === 1 && ['balanced', 'right'].includes(meta.layout) && Object.hasOwn(mindmapPalettes, meta.palette)
      && Array.isArray(meta.collapsed) && meta.collapsed.every(id => /^m\d+$/.test(id))
      && Object.keys(meta).every(key => ['v', 'layout', 'palette', 'collapsed'].includes(key)), '此导图的布局信息暂不支持可视化编辑，请保留源文本');
  }
  const declarations = lines.map(line => line.trim()).filter(line => line && line !== 'mindmap' && !line.startsWith('%%'));
  requireValue(!declarations.some(line => line.startsWith('::')) && !source.includes('`')
    && !/<[^>]*>|&(?:#\d+|#x[\da-f]+|\w+);/i.test(source), '此导图包含特殊格式，请在源文本中编辑，原内容不会被简化');
  let index = 0;
  const convert = (node, depth = 0) => {
    requireValue(node && depth <= 40 && index < 500, '可视化编辑最多支持 500 个主题、40 层');
    const id = `m${index}`, raw = declarations[index++];
    requireValue(raw && !node.icon && !node.class, '此导图包含特殊格式，请保留源文本');
    const text = plainText(node.descr).replace(/^"([\s\S]*)"$/, '$1');
    requireValue(text.length <= 1000, '主题文字超过 1000 字，请使用源文本保留原图');
    return { id, text, raw, collapsed: meta.collapsed?.includes(id) || false, children: node.children.map(child => convert(child, depth + 1)) };
  };
  const root = convert(parsed);
  requireValue(index === declarations.length, '此导图包含多行主题或特殊语法，请保留源文本');
  return { root, layout: meta.layout || 'balanced', palette: meta.palette || 'classic',
    comments: lines.filter(line => line.trim().startsWith('%%') && !metadataLine(line)) };
}

function labelDeclaration(node) {
  if (node.raw) return node.raw;
  requireValue(typeof node.text === 'string' && node.text.trim() && node.text.length <= 1000, '主题文字须为 1 至 1000 字');
  // Numeric Mermaid entities keep punctuation from becoming grammar or HTML.
  const text = [...node.text.trim()].map(char => /[\p{L}\p{N} _,.!?，。！？、：；-]/u.test(char) ? char : `#${char.codePointAt(0)};`).join('');
  return `${node.id}["${text}"]`;
}
export function serializeMindmap(model) {
  const nodes = flattenMindmap(model.root);
  const meta = { v: 1, layout: model.layout, palette: model.palette,
    collapsed: nodes.flatMap(({ node }, index) => node.collapsed ? [`m${index}`] : []) };
  const source = ['mindmap', `%% fengzaiy-mindmap:${JSON.stringify(meta)}`, ...(model.comments || []),
    ...nodes.map(({ node, depth }) => `${'  '.repeat(depth + 1)}${labelDeclaration(node)}`)].join('\n');
  requireValue(source.length <= 30000, '导图源文本超过 30000 字，请拆分导图');
  return source;
}
export function moveMindmap(model, id, parentId, beforeId = null) {
  const entries = flattenMindmap(model.root), entry = entries.find(item => item.node.id === id), target = entries.find(item => item.node.id === parentId);
  requireValue(entry?.parent && target, '中心主题不能移动');
  requireValue(!flattenMindmap(entry.node).some(item => item.node.id === parentId), '不能移动到自身或自己的下级');
  const height = Math.max(...flattenMindmap(entry.node).map(item => item.depth));
  requireValue(target.depth + height + 1 <= 40, '层级不能超过 40 层');
  entry.parent.children.splice(entry.parent.children.indexOf(entry.node), 1);
  const index = target.node.children.findIndex(child => child.id === beforeId);
  target.node.children.splice(index < 0 ? target.node.children.length : index, 0, entry.node);
  target.node.collapsed = false;
}
export function wrapTopic(text, max = 16) {
  const lines = [];
  for (const line of text.split('\n')) {
    let part = '', width = 0;
    for (const char of line) {
      const size = /[ -~]/.test(char) ? 0.55 : 1;
      if (width + size > max && part) { lines.push(part); part = ''; width = 0; }
      part += char; width += size;
    }
    lines.push(part || ' ');
  }
  return lines;
}
export function layoutMindmap(model) {
  const { root } = model, nodes = [], edges = [];
  const metrics = node => {
    const lines = wrapTopic(node.text, node === root ? 18 : 15);
    const width = Math.min(node === root ? 316 : 268, Math.max(node === root ? 168 : 90,
      Math.max(...lines.map(line => [...line].reduce((sum, char) => sum + (/[ -~]/.test(char) ? 8 : 15), 0))) + 32));
    return { width, height: Math.max(node === root ? 58 : 42, lines.length * 22 + 22), lines };
  };
  const center = { node: root, x: 0, y: 0, depth: 0, side: 1, color: '#334a62', ...metrics(root) };
  nodes.push(center);
  const children = root.collapsed ? [] : root.children;
  for (const side of [1, -1]) {
    const subset = children.filter((_, index) => (model.layout === 'right' || index % 2 === 0 ? 1 : -1) === side);
    if (!subset.length) continue;
    const synthetic = { ...root, children: subset }, branch = hierarchy(synthetic, node => node.collapsed ? [] : node.children);
    branch.each(node => Object.assign(node, metrics(node.depth ? node.data : root)));
    tree().nodeSize([1, 1]).separation((a, b) => (a.height + b.height) / 2 + (a.parent === b.parent ? 20 : 32))(branch);
    branch.eachBefore(item => {
      if (!item.depth) { item.position = center; return; }
      const parent = item.parent.position, main = item.ancestors().find(ancestor => ancestor.depth === 1);
      const color = mindmapPalettes[model.palette][children.indexOf(main.data) % mindmapPalettes[model.palette].length];
      const position = { node: item.data, x: parent.x + side * (parent.width / 2 + item.width / 2 + 66),
        y: item.x, depth: item.depth, side, color, width: item.width, height: item.height, lines: item.lines };
      item.position = position; nodes.push(position); edges.push({ from: parent, to: position });
    });
  }
  const left = Math.min(...nodes.map(node => node.x - node.width / 2)) - 50;
  const top = Math.min(...nodes.map(node => node.y - node.height / 2)) - 50;
  const right = Math.max(...nodes.map(node => node.x + node.width / 2)) + 50;
  const bottom = Math.max(...nodes.map(node => node.y + node.height / 2)) + 50;
  return { nodes, edges, left, top, width: right - left, height: bottom - top };
}
export function mindmapEdge({ from, to }) {
  const x1 = from.x + to.side * from.width / 2, x2 = to.x - to.side * to.width / 2;
  const middle = (x1 + x2) / 2;
  return `M${x1},${from.y} C${middle},${from.y} ${middle},${to.y} ${x2},${to.y}`;
}
