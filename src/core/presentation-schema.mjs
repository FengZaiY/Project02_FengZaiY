import { parseFragment, serialize } from 'parse5';
import { parse, walk } from 'css-tree';

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const key = /^[a-zA-Z][\w-]{0,79}$/;
const ensure = (value, message) => { if (!value) throw new Error(message); };
const fields = (value, names) => ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(name => names.includes(name)), '交互页面包含未知字段');
export const presentationLimits = Object.freeze({ nodes: 2000, commands: 200, message: 256 * 1024, memory: 32 * 1024 * 1024, initMs: 1000, callbackMs: 200 });
export const presentationBody = data => JSON.stringify([data.format || 'markdown', data.content || '']);

export function validatePageCss(source, declarations = false) {
  ensure(typeof source === 'string' && source.length <= 100000, '页面样式过大');
  const ast = parse(source, { context: declarations ? 'declarationList' : 'stylesheet', onParseError: error => { throw error; } });
  walk(ast, node => {
    ensure(node.type !== 'Url' && node.type !== 'Raw', '页面样式不能加载外部资源');
    if (node.type === 'Atrule') ensure(['media', 'supports', 'keyframes', 'container', 'layer'].includes(node.name.toLowerCase()), '页面样式规则不受支持');
    if (node.type === 'Function') ensure(!['url', 'expression', 'image', 'image-set', '-webkit-image-set', 'paint'].includes(node.name.toLowerCase()), '页面样式不能加载或执行外部内容');
    if (node.type === 'Declaration') ensure(!['behavior', '-moz-binding'].includes(node.property.toLowerCase()), '页面样式属性不受支持');
  });
  return source;
}

const tags = new Set('main section article aside header footer nav div span p h1 h2 h3 h4 h5 h6 strong em b i u s mark small sub sup br hr blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col figure figcaption details summary button input label select option optgroup output progress meter img video audio canvas'.split(' '));
const attributes = new Set('id class title role hidden tabindex style type value min max step checked disabled selected multiple placeholder name for rows cols colspan rowspan scope open controls muted loop preload alt width height data-asset-id data-note-id'.split(' '));
export function validatePageHtml(source, resources = { assetIds: [], noteIds: [] }) {
  ensure(typeof source === 'string' && source.length <= 200000, '页面结构过大');
  const fragment = parseFragment(source), pending = [...fragment.childNodes], ids = new Set();
  let count = 0;
  while (pending.length) {
    const node = pending.pop();
    ensure(++count <= presentationLimits.nodes, '页面节点过多');
    if (node.tagName) {
      ensure(tags.has(node.tagName), `页面不支持 ${node.tagName} 元素`);
      for (const attr of node.attrs || []) {
        ensure(!attr.namespace && (attributes.has(attr.name) || /^aria-[a-z-]+$/.test(attr.name)), `页面不支持 ${attr.name} 属性`);
        if (attr.name === 'id') { ensure(key.test(attr.value) && !ids.has(attr.value), '页面元素标识无效或重复'); ids.add(attr.value); }
        if (attr.name === 'style') validatePageCss(attr.value, true);
        if (attr.name === 'data-asset-id') ensure(id.test(attr.value) && resources.assetIds.includes(attr.value), '页面引用了未声明的附件');
        if (attr.name === 'data-note-id') ensure(id.test(attr.value) && resources.noteIds.includes(attr.value), '页面引用了未声明的笔记');
        if (attr.name === 'type' && node.tagName === 'input') ensure(['text', 'number', 'range', 'checkbox', 'radio', 'button'].includes(attr.value), '不支持的页面输入类型');
        if (attr.name === 'preload') ensure(['none', 'metadata'].includes(attr.value), '媒体只能按需读取');
        if (['width', 'height'].includes(attr.name)) ensure(/^\d{1,4}$/.test(attr.value) && Number(attr.value) <= 4096, '媒体尺寸过大');
      }
    }
    pending.push(...(node.childNodes || []));
  }
  return serialize(fragment);
}

export function validatePresentation(value) {
  if (value == null) return value;
  fields(value, ['v', 'html', 'css', 'script', 'data', 'assetIds', 'noteIds', 'basis']);
  ensure(value.v === 1, '不支持的交互页面版本，请更新应用');
  for (const name of ['assetIds', 'noteIds']) ensure(Array.isArray(value[name]) && value[name].length <= 100 && value[name].every(item => id.test(item)) && new Set(value[name]).size === value[name].length, '页面引用列表无效');
  ensure(typeof value.script === 'string' && value.script.length <= 100000, '页面程序过大');
  ensure(value.data && typeof value.data === 'object' && !Array.isArray(value.data) && JSON.stringify(value.data).length <= 200000, '页面初始数据无效或过大');
  fields(value.basis, ['contentHash', 'sources']);
  ensure(hash.test(value.basis.contentHash), '页面正文摘要无效');
  ensure(Array.isArray(value.basis.sources) && value.basis.sources.length <= 100, '页面设计依据过多');
  const seen = new Set();
  for (const ref of value.basis.sources) {
    fields(ref, ['id', 'versionId']);
    ensure(id.test(ref.id) && id.test(ref.versionId) && !seen.has(ref.id), '页面依据版本无效或重复'); seen.add(ref.id);
  }
  validatePageHtml(value.html, value);
  validatePageCss(value.css);
  return value;
}

export function presentationReferences(data) {
  const page = validatePresentation(data.presentation);
  return page ? { refs: [...page.assetIds, ...page.noteIds, ...page.basis.sources.map(ref => ref.id)], assets: page.assetIds } : { refs: [], assets: [] };
}
