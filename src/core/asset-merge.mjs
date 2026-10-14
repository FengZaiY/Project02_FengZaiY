import { parseFragment } from 'parse5';
import fs from 'node:fs';
import { marked } from 'marked';
import { richReferences } from './rich-content.mjs';
import { parseNoteLink, validateBlock, encodeBlock } from './rich-schema.mjs';
import { assetReferenceIndex } from './asset-management.mjs';
import { canonical, check, isId, sha, hashFile, noSymlink } from './util.mjs';
import { hasNoteChildren } from './note-hierarchy.mjs';

const supported = new Set(['note', 'draft', 'source', 'annotation', 'relation', 'proposal']);
const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const linkValue = (value, replacements) => {
  const link = parseNoteLink(value);
  return link?.kind === 'asset' && replacements.has(link.id) ? `studyself://asset/${replacements.get(link.id)}` : value;
};
function applyEdits(text, edits) {
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
function htmlReferences(text, replacements) {
  const root = parseFragment(text, { sourceCodeLocationInfo: true }), pending = [root], edits = [];
  while (pending.length) {
    const node = pending.pop();
    for (const attr of node.attrs || []) {
      let value = attr.value;
      if (attr.name === 'href') value = linkValue(value, replacements);
      if (attr.name === 'data-ss-block') {
        const block = validateBlock(JSON.parse(value));
        if (replacements.has(block.assetId)) value = encodeBlock({ ...block, assetId: replacements.get(block.assetId) });
      }
      if (value === attr.value) continue;
      const location = node.sourceCodeLocation?.attrs?.[attr.name];
      check(location, '无法定位正文引用，请打开并保存笔记后重试');
      edits.push({ start: location.startOffset, end: location.endOffset, value: `${attr.name}="${escapeAttribute(value)}"` });
    }
    pending.push(...(node.childNodes || []));
    if (node.content) pending.push(node.content);
  }
  return applyEdits(text, edits);
}
function markdownReferences(text, replacements) {
  const edits = [];
  const visit = (tokens, offset, end) => {
    let cursor = offset;
    for (const token of tokens || []) {
      if (!token.raw) continue;
      const start = text.indexOf(token.raw, cursor);
      check(start >= cursor && start + token.raw.length <= end, 'Markdown引用无法准确定位，请在笔记中保存正文后重试');
      const stop = start + token.raw.length;
      cursor = stop;
      if (['code', 'codespan'].includes(token.type)) continue;
      if (['link', 'image'].includes(token.type) && linkValue(token.href, replacements) !== token.href) {
        const at = token.raw.lastIndexOf(token.href);
        check(at >= 0, 'Markdown引用式链接暂不能自动合并，请在笔记中保存正文后重试');
        edits.push({ start: start + at, end: start + at + token.href.length, value: linkValue(token.href, replacements) });
      } else if (token.type === 'html') {
        const value = htmlReferences(token.raw, replacements);
        if (value !== token.raw) edits.push({ start, end: stop, value });
      } else if (token.tokens) visit(token.tokens, start, stop);
      else if (token.items) visit(token.items, start, stop);
    }
  };
  visit(marked.lexer(text), 0, text.length);
  return applyEdits(text, edits);
}
export function replaceAssetReferences(data, replacements) {
  const result = { ...data };
  for (const field of ['assetIds', 'sourceIds']) if (Array.isArray(data[field])) {
    result[field] = [...new Set(data[field].map(id => replacements.get(id) || id))];
  }
  for (const field of ['from', 'to', 'noteId']) if (replacements.has(data[field])) result[field] = replacements.get(data[field]);
  if (data.url) result.url = linkValue(data.url, replacements);
  if (typeof data.content === 'string' && richReferences(data).assets.some(id => replacements.has(id))) {
    result.content = data.format === 'html' ? htmlReferences(data.content, replacements) : markdownReferences(data.content, replacements);
  }
  if (data.items) result.items = data.items.map(item => ({ ...item, data: replaceAssetReferences(item.data, replacements) }));
  check(!richReferences(result).assets.some(id => replacements.has(id)), '正文含暂不支持的引用形式，请打开并保存笔记后重试');
  return result;
}
const item = record => ({ id: record.id, title: record.data.title, filename: record.data.filename,
  tags: record.data.tags, sensitive: record.data.sensitive, parents: record.heads });

export function previewAssetMerge(store, { ids, targetId } = {}) {
  check(Array.isArray(ids) && ids.length >= 2 && ids.length <= 100 && ids.every(isId)
    && new Set(ids).size === ids.length && ids.includes(targetId), '请选择 2 至 100 项相同内容，并选择保留的资料');
  const records = ids.map(id => store.get(id)), target = records.find(record => record?.id === targetId);
  check(records.every(record => record?.type === 'asset' && !record.deleted && !record.conflict), '资料已回收或存在冲突，请刷新后重试');
  check(records.every(record => record.data.domain === target.data.domain && record.data.sha256 === target.data.sha256
    && record.data.size === target.data.size), '只能合并同一知识库内内容完全相同的资料');
  const replacements = new Map(ids.filter(id => id !== targetId).map(id => [id, targetId]));
  const index = assetReferenceIndex(store), blocked = [], changes = [];
  const tags = [...new Set(records.flatMap(record => record.data.tags))];
  const sensitive = records.some(record => record.data.sensitive);
  const local = store.assetLocation(targetId);
  try { check(local && fs.statSync(local.path).size === target.data.size, 'missing'); }
  catch { blocked.push('保留项的本机原件缺失，请先下载或选择原件可用的资料'); }
  if (tags.length > 100) blocked.push('合并后的标签超过 100 个，请先整理标签');
  if (index.uncertain) blocked.push('部分正文引用无法核验，请先处理内容格式');
  if (records.some(record => record.data.mime !== target.data.mime)) blocked.push('资料格式标记不同，请先核对文件类型');
  const references = new Map();
  for (const id of ids) for (const ref of index.refs.get(id) || []) {
    const key = `${ref.id}:${ref.pending}`;
    if (!references.has(key)) references.set(key, { ...ref, assetIds: [] });
    references.get(key).assetIds.push(id);
  }
  const dirty = new Set((store.local('workspace')?.tabs || []).filter(tab => tab.dirty).map(tab => tab.recordId));
  const scanned = new Set();
  for (const ref of references.values()) {
    if (ref.pending || dirty.has(ref.id)) { blocked.push(`“${ref.title}”存在未保存编辑，请先处理`); continue; }
    if (!ref.assetIds.some(id => replacements.has(id))) continue;
    if (scanned.has(ref.id)) continue;
    scanned.add(ref.id);
    const record = store.get(ref.id);
    if (record.conflict || record.data.domain !== target.data.domain || !supported.has(record.type)) {
      blocked.push(`“${ref.title}”存在冲突、跨库引用或不支持自动调整的内容`); continue;
    }
    if (record.type === 'proposal' && record.data.items.some(i => i.data.domain !== target.data.domain)) {
      blocked.push(`“${ref.title}”包含跨库方案，请先处理`); continue;
    }
    if (record.deleted && record.type === 'note' && hasNoteChildren(store, record.id)) {
      blocked.push(`“${ref.title}”为含下级的回收笔记，请先恢复后处理`); continue;
    }
    try {
      const data = replaceAssetReferences(record.data, replacements);
      check(canonical(data) !== canonical(record.data), '引用无法完整调整');
      changes.push({ id: record.id, type: record.type, title: record.data.title, deleted: record.deleted, parents: record.heads, data });
    } catch (error) { blocked.push(`“${ref.title}”：${error.message}`); }
  }
  const snapshot = { assets: records.map(item), targetId, changes, references: [...references.values()], tags, sensitive,
    pinned: records.some(record => store.assetLocation(record.id)?.pinned === 1), blocked: [...new Set(blocked)] };
  return { ...snapshot, domain: target.data.domain, token: sha(canonical(snapshot)) };
}

export async function mergeAssets(store, { ids, targetId, token, confirmed } = {}) {
  check(confirmed === true, '合并资料需要明确确认');
  const before = previewAssetMerge(store, { ids, targetId });
  check(before.token === token, '资料或引用已变化，请重新预览后确认', 'CONFLICT');
  check(!before.blocked.length, before.blocked.join('；'));
  const local = store.assetLocation(targetId), targetBefore = store.get(targetId);
  noSymlink(local.path);
  check(await hashFile(local.path) === targetBefore.data.sha256, '保留项原件校验失败，请重新取得原件');
  return store.transaction(() => {
    const preview = previewAssetMerge(store, { ids, targetId });
    check(preview.token === token, '资料或引用已变化，请重新预览后确认', 'CONFLICT');
    check(!preview.blocked.length, preview.blocked.join('；'));
    check(store.assetLocation(targetId)?.path === local.path, '原件位置已变化，请重新预览', 'CONFLICT');
    const target = store.get(targetId), data = { ...target.data, tags: preview.tags, sensitive: preview.sensitive };
    if (canonical(data) !== canonical(target.data)) store.writeRaw({ id: targetId, type: 'asset', data, parents: target.heads });
    for (const change of preview.changes) store.writeRaw(change);
    for (const id of ids.filter(id => id !== targetId)) {
      const record = store.get(id);
      store.writeRaw({ id, type: 'asset', data: record.data, parents: record.heads, deleted: true });
    }
    const location = store.assetLocation(targetId);
    if (preview.pinned && location && !location.pinned) store.bindAsset(targetId, location.path, true);
    return { targetId, retired: ids.filter(id => id !== targetId), changedIds: preview.changes.map(change => change.id) };
  });
}
