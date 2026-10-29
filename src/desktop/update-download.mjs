import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CancellationError } from 'builder-util-runtime';
import { check, noSymlink } from '../core/util.mjs';

const failure = (message, code) => Object.assign(new Error(message), { code });
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

// Keep partial bytes outside electron-updater's pending directory: it clears that
// directory on cancellation. Only fully verified bytes enter its signature/install flow.
export class UpdateDownload {
  constructor({ directory, fetch: fetcher, allowLoopback = false }) {
    this.directory = path.resolve(directory); this.fetch = fetcher; this.allowLoopback = allowLoopback;
  }
  file(hash) {
    check(/^[a-f0-9]{64}$/.test(hash), 'Invalid update cache key');
    const file = path.join(this.directory, `${hash}.part`); noSymlink(file);
    if (fs.existsSync(file)) check(fs.lstatSync(file).isFile() && fs.statSync(file).nlink === 1, 'Invalid update cache file');
    return file;
  }
  async reset() {
    check(!this.running, '下载尚未停止');
    if (this.lastKey) await fs.promises.rm(this.file(this.lastKey), { force: true });
    this.fresh = true;
  }
  async response(url, headers, signal) {
    let target = new URL(url);
    for (let count = 0; count < 10; count++) {
      check((target.protocol === 'https:' || this.allowLoopback && target.protocol === 'http:' && target.hostname === '127.0.0.1')
        && !target.username && !target.password, 'Invalid update download URL', 'UPDATE_URL_INVALID');
      const response = await this.fetch(target.href, { headers, signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      check(response.headers.get('location'), 'Missing update redirect', 'UPDATE_REDIRECT_FAILED');
      const next = new URL(response.headers.get('location'), target);
      if (next.origin !== target.origin) { headers.delete('authorization'); headers.delete('cookie'); }
      target = next;
    }
    throw failure('Too many update redirects', 'UPDATE_REDIRECT_LIMIT');
  }
  async download(url, destination, options) {
    check(!this.running, '已有更新下载进行中');
    check(typeof options.sha512 === 'string' && Buffer.from(options.sha512, 'base64').length === 64, '更新缺少 SHA512 校验');
    const key = createHash('sha256').update(options.sha512).digest('hex');
    this.lastKey = key;
    const file = this.file(key), token = options.cancellationToken, controller = new AbortController();
    const cancel = () => controller.abort();
    token.onCancel(cancel); this.running = true;
    let handle, response, timeout, timedOut = false;
    const active = () => { if (token.cancelled) throw new CancellationError(); };
    const armTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000); timeout.unref?.(); };
    try {
      active(); await fs.promises.mkdir(this.directory, { recursive: true });
      if (this.fresh) { await fs.promises.rm(file, { force: true }); this.fresh = false; }
      let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
      check(offset <= MAX_BYTES, '更新缓存过大');
      const digest = async (target = file) => {
        const hash = createHash('sha512');
        for await (const chunk of fs.createReadStream(target)) { active(); hash.update(chunk); }
        return hash.digest('base64');
      };
      const promote = async () => {
        active(); await fs.promises.copyFile(file, destination); active();
        if (await digest(destination) !== options.sha512) throw failure('Invalid copied update', 'ERR_CHECKSUM_MISMATCH');
        await fs.promises.rm(file, { force: true });
        return destination;
      };
      if (offset && await digest() === options.sha512) {
        return await promote();
      }
      const headers = new Headers(options.headers || {}); headers.set('accept-encoding', 'identity');
      if (offset) headers.set('range', `bytes=${offset}-`);
      armTimeout(); response = await this.response(url, headers, controller.signal);
      // The server may reject a range after replacing the file or expiring a URL.
      if (response.status === 416 && offset) {
        await response.body?.cancel(); headers.delete('range'); offset = 0;
        armTimeout(); response = await this.response(url, headers, controller.signal);
      }
      let total;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (!range || Number(range[1]) !== offset || Number(range[2]) + 1 !== Number(range[3])) {
          throw failure('Invalid update range response', 'UPDATE_RANGE_INVALID');
        }
        total = Number(range[3]);
      } else if (response.status === 200) {
        offset = 0;
        total = Number(response.headers.get('content-length')) || 0;
      } else throw failure(`Update HTTP ${response.status}`, `HTTP_${response.status}`);
      check(Number.isSafeInteger(total) && total >= offset && total <= MAX_BYTES, '更新大小无效');
      check(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity', '更新编码无效');
      check(response.body, 'Empty update response');
      active(); handle = await fs.promises.open(file, offset ? 'a' : 'w', 0o600);
      let transferred = offset, lastReport = 0; const started = Date.now();
      const progress = force => {
        if (!force && Date.now() - lastReport < 250) return;
        lastReport = Date.now();
        options.onProgress?.({ transferred, total, percent: total ? Math.min(100, 100 * transferred / total) : 0,
          bytesPerSecond: (transferred - offset) / Math.max(1, (Date.now() - started) / 1000) });
      };
      progress(true);
      for await (const chunk of response.body) {
        active(); armTimeout();
        if (transferred + chunk.length > (total || MAX_BYTES)) throw failure('Update exceeds expected size', 'UPDATE_SIZE_MISMATCH');
        await handle.writeFile(chunk); transferred += chunk.length; progress(false);
      }
      await handle.sync(); await handle.close(); handle = null; clearTimeout(timeout); active(); progress(true);
      if (total && transferred !== total) throw failure('Incomplete update', 'UPDATE_SIZE_MISMATCH');
      if (await digest() !== options.sha512) {
        await fs.promises.rm(file, { force: true });
        throw failure('Invalid update checksum', 'ERR_CHECKSUM_MISMATCH');
      }
      return await promote();
    } catch (error) {
      if (token.cancelled) throw new CancellationError();
      if (timedOut) throw failure('Update download timed out', 'UPDATE_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timeout); controller.abort();
      try {
        await response?.body?.cancel().catch(() => {});
        if (handle) { try { await handle.sync(); } finally { await handle.close(); } }
      } finally { token.removeListener('cancel', cancel); this.running = false; }
    }
  }
}

export function attachUpdateDownload(updater, options) {
  const transfer = new UpdateDownload(options);
  updater.disableDifferentialDownload = true;
  updater.httpExecutor.download = (url, file, request) => transfer.download(url, file, request);
  updater.resetDownload = async () => {
    await transfer.reset();
    // A pause can race with final verification. Remove only the known installer,
    // never recursively clear a provider-specified directory or the user workspace.
    const helper = updater.downloadedUpdateHelper, file = helper?.file;
    if (file) {
      check(path.dirname(path.resolve(file)) === path.resolve(helper.cacheDirForPendingUpdate), 'Invalid updater cache location');
      noSymlink(file); await fs.promises.rm(file, { force: true });
    }
  };
  return updater;
}
