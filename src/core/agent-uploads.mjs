import fs from 'node:fs';
import path from 'node:path';
import { canonical, check, hashFile, isHash, isId, noSymlink, sha, uuid } from './util.mjs';
import { managedRoot } from './material-center.mjs';

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const key = 'agentUploadSessions';
export class AgentUploads {
  constructor(access) { this.access = access; this.store = access.store; this.busy = new Set(); }
  sessions() { return this.store.local(key) || []; }
  save(session) { this.store.local(key, [...this.sessions().filter(item => item.id !== session.id), session]); }
  file(session) {
    check(isId(session.id), '上传标识无效');
    const file = path.join(managedRoot(this.store, true), 'staging', 'agent-uploads', `${session.id}.partial`); noSymlink(file); return file;
  }
  public(session) { return { id: session.id, state: session.state, received: session.received, size: session.size, sha256: session.sha256, chunkBytes: UPLOAD_CHUNK_BYTES, ...(session.assetId ? { assetId: session.assetId } : {}) }; }
  check(grant, input, writing = true) {
    check(!this.access.closed, 'Agent 接口已关闭', 'UNAUTHORIZED');
    const current = this.access.grants().find(g => g.id === grant.id && g.hash === grant.hash && !g.revoked && Date.parse(g.expiresAt) > Date.now());
    check(current && current.permissions.includes(writing ? 'collect' : 'read'), '授权已撤销或过期', 'UNAUTHORIZED');
    check(!this.store.permanentDeleting && !this.store.materialMigrating, '资料维护正在进行', 'BUSY');
    if (writing) { const prefs = this.access.preferences(); check(!prefs.conflict && input.preferencesVersion === prefs.version, '整理偏好已变化，请重新读取 bootstrap', 'PREFERENCES_CHANGED'); }
  }
  async invoke(grant, method, input, requestId) {
    this.check(grant, input, method !== 'assetUploadStatus');
    if (method !== 'assetUploadStatus') check(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(requestId), '上传写入需要唯一 requestId');
    if (method === 'assetUploadStart') {
      const prior = this.sessions().find(s => s.grantId === grant.id && s.requestId === requestId), digest = sha(canonical(input));
      if (prior) { check(prior.digest === digest, '上传请求标识已用于不同参数', 'CONFLICT'); return this.public(prior); }
      this.access.scope(grant, input.domain);
      check(typeof input.filename === 'string' && input.filename && input.filename.length <= 200 && !/[\\/\0]/.test(input.filename), '文件名无效');
      check(Number.isSafeInteger(input.size) && input.size >= 0 && input.size <= 1024 ** 4 && isHash(input.sha256), '文件大小或哈希无效（单文件最大 1 TiB）');
      check(this.sessions().filter(s => s.state === 'uploading').length < 16, '同时暂存最多 16 个原件，请先完成或取消已有上传');
      const session = { id: uuid(), grantId: grant.id, requestId, digest, filename: input.filename, domain: input.domain, size: input.size, sha256: input.sha256,
        mime: String(input.mime || 'application/octet-stream').slice(0, 200), sensitive: input.sensitive === true, state: 'uploading', received: 0, chunks: [], assetId: uuid() };
      const file = this.file(session); fs.mkdirSync(path.dirname(file), { recursive: true });
      const space = fs.statfsSync(path.dirname(file)); check(space.bavail * space.bsize >= Math.min(input.size, UPLOAD_CHUNK_BYTES) + 64 * 1024 * 1024, '暂存磁盘空间不足');
      const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); this.save(session); return this.public(session);
    }
    const session = this.sessions().find(s => s.id === input.id && s.grantId === grant.id); check(session, '本凭证没有此上传会话', 'FORBIDDEN');
    if (method === 'assetUploadStatus') return this.public(session);
    check(!this.busy.has(session.id), '上传正在校验，请稍后重试', 'BUSY');
    const file = this.file(session);
    if (method === 'assetUploadCancel') {
      check(session.state !== 'complete', '已入库原件不能通过取消上传删除');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      session.state = 'cancelled'; this.save(session); return this.public(session);
    }
    if (method === 'assetUploadFinish' && session.state === 'complete') { check(this.store.get(session.assetId), '原件已被清理，不能重建'); return this.public(session); }
    check(session.state === 'uploading', '上传已取消');
    if (method === 'assetUploadChunk') {
      check(Number.isSafeInteger(input.offset) && input.offset >= 0 && typeof input.data === 'string' && input.data.length <= Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4, '分块位置或大小无效');
      const bytes = Buffer.from(input.data, 'base64'); check(bytes.length > 0 && bytes.length <= UPLOAD_CHUNK_BYTES && bytes.toString('base64') === input.data && sha(bytes) === input.sha256, '分块校验失败');
      const prior = session.chunks.find(c => c.offset === input.offset);
      if (prior) {
        check(prior.hash === input.sha256 && prior.size === bytes.length, '已接收分块内容不一致', 'CONFLICT');
        const fd = fs.openSync(file, 'r'), received = Buffer.alloc(prior.size);
        try { check(fs.readSync(fd, received, 0, prior.size, prior.offset) === prior.size && sha(received) === prior.hash, '已接收分块损坏，请取消后重新上传'); }
        finally { fs.closeSync(fd); }
        return this.public(session);
      }
      check(input.offset === session.received && session.received + bytes.length <= session.size && session.chunks.length < 300000, '请从已确认接收位置继续上传');
      const free = fs.statfsSync(path.dirname(file)); check(free.bavail * free.bsize >= bytes.length + 64 * 1024 * 1024, '暂存磁盘空间不足');
      const fd = fs.openSync(file, 'r+');
      try {
        check(fs.fstatSync(fd).size >= session.received, '暂存文件短于已确认进度，请取消后重传');
        fs.ftruncateSync(fd, session.received);
        let written = 0; while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, session.received + written);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      session.chunks.push({ offset: session.received, size: bytes.length, hash: input.sha256 }); session.received += bytes.length; this.save(session); return this.public(session);
    }
    check(method === 'assetUploadFinish' && session.received === session.size, '原件尚未完整上传');
    this.busy.add(session.id);
    try {
      check(fs.statSync(file).size === session.size && await hashFile(file) === session.sha256, '完整原件校验失败，未入库');
      this.check(grant, input); this.access.scope(grant, session.domain);
      const data = { title: session.filename, filename: session.filename, domain: session.domain, sha256: session.sha256, size: session.size, mime: session.mime,
        sensitive: session.sensitive, priority: session.size > 16 * 1024 * 1024 ? 'large' : 'normal', centralized: true, collectionIds: [], libraryDomains: session.domain === '__materials__' ? [] : [session.domain] };
      const target = this.store.directories.assetPath(data.domain, data.sha256, { id: session.assetId, data });
      if (!fs.existsSync(target)) {
        const free = fs.statfsSync(path.dirname(target)); check(free.bavail * free.bsize >= session.size + 64 * 1024 * 1024, '原件入库空间不足，可保留进度后重试');
        const temp = `${target}.${session.id}.uploading`; noSymlink(temp);
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
          await fs.promises.copyFile(file, temp, fs.constants.COPYFILE_EXCL);
          check(await hashFile(temp) === session.sha256, '复制原件校验失败');
          const handle = await fs.promises.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          try { await fs.promises.link(temp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      }
      check(fs.statSync(target).size === session.size && await hashFile(target) === session.sha256, '目标原件校验失败，未覆盖');
      this.check(grant, input);
      this.store.transaction(() => {
        const existing = this.store.get(session.assetId); check(!existing || !existing.deleted && !existing.conflict && existing.data.sha256 === session.sha256, '上传原件身份已变化');
        if (!existing) this.store.change('Agent 导入原件', `Agent：${grant.name}`, () => this.store.writeRaw({ id: session.assetId, type: 'asset', data, parents: [] }));
        this.store.bindAsset(session.assetId, target); session.state = 'complete'; this.save(session);
      });
      try { fs.unlinkSync(file); } catch { session.cleanupPending = true; this.save(session); }
      return this.public(session);
    } finally { this.busy.delete(session.id); }
  }
}
