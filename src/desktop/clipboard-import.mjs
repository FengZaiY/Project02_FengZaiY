import fs from 'node:fs';
import path from 'node:path';
import { check, uuid, noSymlink } from '../core/util.mjs';

export async function importClipboardImage(service, input) {
  const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const extension = extensions[input.mime];
  check(extension && input.data instanceof ArrayBuffer && input.data.byteLength > 0 && input.data.byteLength <= 32 * 1024 * 1024, '剪贴板只支持不超过 32 MiB 的图片');
  const library = service.store.libraries().find(record => record.data.domain === input.domain);
  check(library && !library.deleted && !library.conflict, '请选择可用知识库');
  const folder = path.join(service.store.directory, 'clipboard-import', uuid());
  const file = path.join(folder, `粘贴图片${extension}`);
  noSymlink(folder);
  fs.mkdirSync(folder, { recursive: true });
  try {
    await fs.promises.writeFile(file, new Uint8Array(input.data), { flag: 'wx' });
    return await service.call('assetImport', { path: file, domain: input.domain });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
}
