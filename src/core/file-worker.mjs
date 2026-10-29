import { parentPort } from 'node:worker_threads';
import { readSync } from 'node:fs';
import { createHash } from 'node:crypto';

parentPort.on('message', ({ id, fd, size, content }) => {
  try {
    if (!Number.isSafeInteger(fd) || fd < 0 || !Number.isSafeInteger(size) || size < 0 || content && size > 64 * 1024 * 1024) throw new Error('文件读取范围无效');
    const hash = createHash('sha256'), data = content ? new Uint8Array(size) : new Uint8Array(Math.min(size, 1024 * 1024));
    let offset = 0;
    while (offset < size) {
      const length = Math.min(size - offset, 1024 * 1024), start = content ? offset : 0;
      const count = readSync(fd, data, start, length, offset);
      if (!count) throw new Error('附件读取不完整');
      hash.update(data.subarray(start, start + count)); offset += count;
    }
    parentPort.postMessage({ id, hash: hash.digest('hex'), ...(content ? { data } : {}) }, content ? [data.buffer] : []);
  } catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
});
