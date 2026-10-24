import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { check, noSymlink, uuid } from './util.mjs';

const contention = new Set(['EPERM', 'EACCES', 'EBUSY']);
const retryDelays = [200, 400, 800, 1600, 2000, 2000, 2000];

// Only the mutable latest pointer needs replacement retries. Never unlink the old
// pointer: readers must continue to see the previous complete publication.
export async function writeSyncPointer(file, data, { shouldPause = () => false, onRetry = () => {}, delays = retryDelays } = {}) {
  const temp = `${file}.${uuid()}.partial`;
  let created = false, replaced = false, failure;
  const checkPause = () => check(!shouldPause(), '已暂停，最新清单尚未更新；发布进度已保留，可继续发布', 'PAUSED');
  try {
    checkPause(); noSymlink(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(temp, 'wx', 0o600); created = true;
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let attempt = 0; ; attempt++) {
      checkPause(); noSymlink(file); noSymlink(temp);
      try { fs.renameSync(temp, file); replaced = true; return; }
      catch (error) {
        if (!contention.has(error.code)) throw error;
        if (attempt >= delays.length) throw Object.assign(new Error(
          `最新内容清单暂时被占用或没有替换权限（${error.code}），自动重试后仍未成功。旧清单和发布进度已保留。请等待百度客户端完成传输，必要时临时退出客户端后点击“继续发布”；若仍失败，请检查同步目录及文件的权限。`, { cause: error }), { code: 'SYNC_FILE_BUSY' });
        onRetry({ attempt: attempt + 1, total: delays.length });
        // Short slices keep Pause responsive throughout the bounded backoff.
        for (let remaining = delays[attempt]; remaining > 0; remaining -= 100) {
          checkPause(); await delay(Math.min(100, remaining));
        }
      }
    }
  } catch (error) {
    failure = error;
    if (contention.has(error.code)) failure = Object.assign(new Error(
      `无法写入同步清单临时文件（${error.code}），请检查同步目录权限或文件占用后继续发布。旧清单和发布进度已保留。`, { cause: error }), { code: 'SYNC_FILE_BUSY' });
    throw failure;
  } finally {
    if (created && !replaced) {
      try { noSymlink(temp); fs.unlinkSync(temp); }
      catch (error) {
        if (error.code !== 'ENOENT' && failure) failure.message += ' 临时交接文件暂无法清理，已保留；它不会作为完整发布导入。';
      }
    }
  }
}
