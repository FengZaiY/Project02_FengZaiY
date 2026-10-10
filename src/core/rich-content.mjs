import { parseFragment } from 'parse5';
import { marked } from 'marked';
import { validateBlock, validateLayout, parseNoteLink } from './rich-schema.mjs';

export function richReferences(data) {
  const refs = new Set(), assets = new Set();
  const sourceLink = parseNoteLink(data.url);
  if (sourceLink && sourceLink.kind !== 'local') { refs.add(sourceLink.id); if (sourceLink.kind === 'asset') assets.add(sourceLink.id); }
  if (typeof data.content !== 'string') return { refs: [...refs], assets: [...assets] };
  const root = parseFragment(data.format === 'html' ? data.content : marked.parse(data.content));
  const pending = [root];
  while (pending.length) {
    const node = pending.pop(), attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
    if (attrs['data-ss-layout']) validateLayout(JSON.parse(attrs['data-ss-layout']));
    if (attrs['data-ss-block']) {
      const block = validateBlock(JSON.parse(attrs['data-ss-block']));
      if (block.assetId) { refs.add(block.assetId); assets.add(block.assetId); }
    }
    if (attrs.href) {
      const link = parseNoteLink(attrs.href);
      if (link && link.kind !== 'local') { refs.add(link.id); if (link.kind === 'asset') assets.add(link.id); }
    }
    pending.push(...(node.childNodes || []));
    if (node.content) pending.push(node.content);
  }
  return { refs: [...refs], assets: [...assets] };
}
