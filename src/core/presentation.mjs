import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { sha, check, canonical, noSymlink } from './util.mjs';
import { presentationBody, validatePresentation } from './presentation-schema.mjs';
import { requireSaved } from './draft-workflow.mjs';

export const presentationHash = data => sha(presentationBody(data));
export function preservePresentation(data, previous) {
  return !Object.hasOwn(data, 'presentation') && previous?.presentation !== undefined ? { ...data, presentation: previous.presentation } : data;
}
export function samePresentation(a, b) { return canonical(a ?? null) === canonical(b ?? null); }
export function validatePageBasis(store, data, { originals = false } = {}) {
  const page = validatePresentation(data.presentation);
  if (!page) return;
  check(page.basis.contentHash === presentationHash(data), '正文已变化，请重新调整交互页面', 'CONFLICT');
  requireSaved(store, page.basis.sources.map(ref => ref.id));
  for (const ref of page.basis.sources) {
    const record = store.get(ref.id);
    check(record && !record.deleted && !record.conflict && record.heads.length === 1 && record.heads[0] === ref.versionId, '页面设计依据已变化，请重新整理', 'CONFLICT');
  }
  for (const assetId of page.assetIds) {
    const record = store.get(assetId);
    check(record?.type === 'asset' && !record.deleted && !record.conflict, '页面附件不存在或存在冲突');
    if (originals) {
      const local = store.assetLocation(assetId);
      check(local && fs.existsSync(local.path), '页面附件尚未下载', 'ASSET_UNAVAILABLE');
      noSymlink(local.path);
      const fd = fs.openSync(local.path, 'r');
      try {
        const before = fs.fstatSync(fd), digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
        check(before.isFile() && before.size === record.data.size, '页面附件校验失败', 'ASSET_UNAVAILABLE');
        let size;
        while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size));
        const after = fs.fstatSync(fd);
        check(before.mtimeMs === after.mtimeMs && before.size === after.size && digest.digest('hex') === record.data.sha256, '页面附件校验失败', 'ASSET_UNAVAILABLE');
      } finally { fs.closeSync(fd); }
    }
  }
  for (const noteId of page.noteIds) {
    const record = store.get(noteId);
    check(record?.type === 'note' && !record.deleted && !record.conflict, '页面关联笔记不存在或存在冲突');
  }
}
