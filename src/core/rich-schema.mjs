const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
export const richKinds = ['image', 'video', 'formula', 'diagram', 'canvas', 'sticker'];
export function validateLayout(layout) {
  ensure(layout && typeof layout === 'object' && !Array.isArray(layout), '内容布局无效');
  ensure(Object.keys(layout).every(key => ['width', 'height', 'align'].includes(key)), '内容布局包含未知字段');
  ensure(Number.isFinite(layout.width) && layout.width >= 15 && layout.width <= 100, '内容宽度须为 15% 至 100%');
  ensure(layout.height === null || (Number.isFinite(layout.height) && layout.height >= 60 && layout.height <= 1600), '内容高度无效');
  ensure(['left', 'center', 'right'].includes(layout.align), '内容对齐方式无效');
  return layout;
}
export function encodeBlock(block) {
  return JSON.stringify(block).replace(/[<>&]/g, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[char]));
}
export function parseNoteLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'studyself:' || !['note', 'asset', 'local'].includes(url.hostname)
      || !idPattern.test(url.pathname.slice(1)) || url.search || url.hash || url.username || url.password || url.port) return null;
    return { kind: url.hostname, id: url.pathname.slice(1) };
  } catch { return null; }
}
export function safeNoteLink(value) {
  if (parseNoteLink(value)) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export function validateBlock(block) {
  ensure(block && block.v === 1 && richKinds.includes(block.kind), '不支持的富内容版本或类型');
  ensure(JSON.stringify(block).length <= 200000, '单个富内容块过大');
  const fields = ['v', 'kind', 'label', ...({ image: ['assetId'], video: ['assetId'], formula: ['source'], diagram: ['source'], canvas: ['shapes'], sticker: ['text', 'color'] }[block.kind])];
  ensure(Object.keys(block).every(key => fields.includes(key)), '富内容包含未知字段');
  ensure(typeof block.label === 'string' && block.label.length <= 200, '富内容标题最多 200 字');
  if (['image', 'video'].includes(block.kind)) ensure(idPattern.test(block.assetId), '媒体必须引用附件标识');
  if (['formula', 'diagram'].includes(block.kind)) ensure(typeof block.source === 'string' && block.source.length <= (block.kind === 'formula' ? 10000 : 30000), '公式或图表源文本过长');
  if (block.kind === 'sticker') ensure(typeof block.text === 'string' && block.text.length <= 2000 && ['yellow', 'green', 'pink', 'blue'].includes(block.color), '贴纸内容无效');
  if (block.kind === 'canvas') {
    ensure(Array.isArray(block.shapes) && block.shapes.length <= 500, '画板最多 500 个对象');
    for (const shape of block.shapes) {
      ensure(shape && ['rect', 'ellipse', 'text', 'arrow', 'line'].includes(shape.type), '画板对象类型无效');
      ensure(Object.keys(shape).every(key => ['id', 'type', 'x', 'y', 'width', 'height', 'text', 'fill', 'points'].includes(key)), '画板对象字段无效');
      ensure(typeof shape.id === 'string' && shape.id.length <= 80, '画板对象标识无效');
      for (const key of ['x', 'y', 'width', 'height']) ensure(Number.isFinite(shape[key]) && Math.abs(shape[key]) <= 1000000 && (!['width', 'height'].includes(key) || shape[key] > 0), '画板坐标无效');
      ensure(typeof shape.text === 'string' && shape.text.length <= 2000 && /^#[0-9a-f]{6}$/i.test(shape.fill), '画板样式无效');
      if (['arrow', 'line'].includes(shape.type)) ensure(Array.isArray(shape.points) && shape.points.length >= 4 && shape.points.length <= 10000 && shape.points.length % 2 === 0 && shape.points.every(n => Number.isFinite(n) && Math.abs(n) <= 1000000), '画板线条无效');
    }
    ensure(new Set(block.shapes.map(s => s.id)).size === block.shapes.length, '画板对象标识重复');
  }
  return block;
}
