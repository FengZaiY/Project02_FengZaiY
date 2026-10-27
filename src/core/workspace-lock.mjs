import fs from 'node:fs';
import path from 'node:path';
import { check, noSymlink, uuid } from './util.mjs';
import { legacyNames } from './legacy-names.mjs';

export function lockFile(file) {
  noSymlink(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid: process.pid, id: uuid() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      check(Number.isSafeInteger(previous?.pid) && previous.pid > 0, '工作区锁无法核验，请关闭其他实例后检查锁文件', 'BUSY');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (reason) { if (reason.code === 'ESRCH') alive = false; }
      check(!alive, '该工作区正在被另一个实例使用，请先关闭它', 'BUSY');
      // Only remove the dead owner's unchanged lock, never a replacement lock.
      check(JSON.parse(fs.readFileSync(file, 'utf8')).id === previous.id, '工作区占用状态已变化，请重试', 'BUSY');
      fs.unlinkSync(file);
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return () => {
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).id === owner.id) fs.unlinkSync(file);
    };
  }
  throw new Error('无法取得工作区锁');
}

// Hold the legacy lock too, so an older executable cannot open the same SQLite database.
export function compatibleLock(directory, current, previous) {
  const releasePrevious = lockFile(path.join(directory, previous));
  let releaseCurrent;
  try { releaseCurrent = lockFile(path.join(directory, current)); }
  catch (error) { releasePrevious(); throw error; }
  return () => { try { releaseCurrent(); } finally { releasePrevious(); } };
}
export const workspaceLock = directory => compatibleLock(directory, '.fengzaiy-lock.json', legacyNames.workspaceLock);
