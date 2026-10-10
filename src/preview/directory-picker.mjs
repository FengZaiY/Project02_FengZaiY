import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { check } from '../core/util.mjs';

const execute = promisify(execFile);
const script = fs.readFileSync(new URL('./directory-picker.ps1', import.meta.url), 'utf8');

export async function chooseWindowsDirectory({ signal, platform = process.platform, run = execute } = {}) {
  check(platform === 'win32', '当前预览环境不支持系统文件夹窗口，请使用 Windows 桌面版', 'PICKER_UNSUPPORTED');
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stdout;
  try {
    ({ stdout } = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024, signal
    }));
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('目录选择已取消'), { code: 'PICKER_CANCELLED' });
    throw Object.assign(new Error('无法完成文件夹选择，请重试或使用桌面版'), { code: 'PICKER_FAILED', cause: error });
  }
  let result;
  try { result = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error('文件夹选择结果无效，请重试'), { code: 'PICKER_FAILED' }); }
  check(result === null || (typeof result === 'string' && path.win32.isAbsolute(result) && !result.includes('\0')), '文件夹选择结果无效，请重试', 'PICKER_FAILED');
  return result;
}

// A preview instance owns at most one native dialog, including requests from other tabs.
export function createDirectoryPicker(run = chooseWindowsDirectory) {
  let active = null, closed = false;
  return {
    async choose(signal) {
      check(!closed, '预览服务正在关闭', 'PICKER_CLOSED');
      check(!active, '文件夹选择窗口已打开，请先完成或取消选择', 'PICKER_BUSY');
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        check(!controller.signal.aborted, '目录选择已取消', 'PICKER_CANCELLED');
        return await run({ signal: controller.signal });
      }
      finally { signal?.removeEventListener('abort', abort); active = null; }
    },
    close() { closed = true; active?.abort(); }
  };
}
