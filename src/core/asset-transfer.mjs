import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, check, hashFile, inside, isHash, noSymlink, sha } from './util.mjs';

export const SMALL_ASSET_LIMIT = 16 * 1024 * 1024;
export const ASSET_CHUNK_SIZE = 4 * 1024 * 1024;

export class AssetTransfer {
  constructor(transport) {
    this.transport = transport;
    this.store = transport.store;
    this.verified = new Map();
  }
  records() { return [...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })]; }
  key(prefix, hash) { return `${prefix}:${this.transport.config().channel}:${hash}`; }
  async valid(file, data) {
    if (!file || !fs.existsSync(file)) return false;
    noSymlink(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== data.size) return false;
    const signature = `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!this.verified.has(signature)) {
      const key = `assetVerified:${sha(file)}`, saved = this.store.local(key);
      const digest = saved?.signature === signature ? saved.hash : await hashFile(file);
      this.verified.set(signature, digest);
      if (digest === data.sha256 && saved?.signature !== signature) this.store.local(key, { signature, hash: digest });
    }
    return this.verified.get(signature) === data.sha256;
  }
  target(hash) {
    const saved = this.store.local(`assetReceivedPath:${hash}`);
    const asset = !saved && this.records().find(record => record.data.sha256 === hash);
    const file = saved ? inside(this.store.directory, saved) : asset
      ? this.store.directories.assetPath(asset.data.domain, hash) : path.join(this.store.directory, 'objects', hash);
    check(path.basename(file) === hash, 'Invalid received attachment location');
    noSymlink(file);
    return file;
  }
  received(hash, file) {
    this.store.local(`assetReceivedPath:${hash}`, path.relative(this.store.directory, file));
    // Do not echo files received through this channel back into the same sync directory.
    this.store.local(this.key('assetPublished', hash), true);
  }
  async publish(report) {
    const groups = new Map();
    for (const asset of this.records()) {
      const group = groups.get(asset.data.sha256) || [];
      group.push(asset); groups.set(asset.data.sha256, group);
    }
    for (const [hash, assets] of groups) {
      if (this.store.local(this.key('assetPublished', hash))) continue;
      const data = assets[0].data;
      try {
        let file;
        for (const asset of assets) {
          const candidate = this.store.assetLocation(asset.id)?.path;
          if (await this.valid(candidate, data)) { file = candidate; break; }
        }
        if (!file) continue;
        if (data.size <= ASSET_CHUNK_SIZE) {
          const bytes = await fs.promises.readFile(file);
          check(bytes.length === data.size && sha(bytes) === hash, '原文件在传输期间发生变化');
          this.transport.writePacket('asset', { sha256: hash, size: bytes.length, data: bytes.toString('base64') });
        } else {
          const count = Math.ceil(data.size / ASSET_CHUNK_SIZE);
          const key = this.key('assetOutgoing', hash);
          const progress = this.store.local(key) || { parts: {} };
          const handle = await fs.promises.open(file, 'r');
          const digest = createHash('sha256');
          try {
            for (let index = 0; index < count; index++) {
              const offset = index * ASSET_CHUNK_SIZE;
              const bytes = Buffer.alloc(Math.min(ASSET_CHUNK_SIZE, data.size - offset));
              let read = 0;
              while (read < bytes.length) {
                const result = await handle.read(bytes, read, bytes.length - read, offset + read);
                check(result.bytesRead > 0, '原文件在传输期间被截断'); read += result.bytesRead;
              }
              digest.update(bytes);
              const chunkHash = sha(bytes), old = progress.parts[index];
              const oldFile = old && inside(this.transport.root(), old.name);
              if (oldFile) noSymlink(oldFile);
              const reusable = oldFile && old.chunkHash === chunkHash && fs.existsSync(oldFile)
                && fs.statSync(oldFile).size <= 26 * 1024 * 1024 && sha(fs.readFileSync(oldFile)) === old.digest;
              if (!reusable) {
                const packet = this.transport.writePacket('asset-chunk', { sha256: hash, size: data.size,
                  index, count, chunkSize: ASSET_CHUNK_SIZE, chunkSha256: chunkHash, data: bytes.toString('base64') });
                progress.parts[index] = { name: path.basename(packet), digest: sha(fs.readFileSync(packet)), chunkHash };
                this.store.local(key, progress); report.assetChunksPublished++;
              }
              await new Promise(resolve => setImmediate(resolve));
            }
            check(digest.digest('hex') === hash && (await handle.stat()).size === data.size, '原文件在传输期间发生变化');
          } finally { await handle.close(); }
        }
        this.store.local(this.key('assetPublished', hash), true); report.assetsPublished++;
      } catch (error) { report.errors.push({ file: assets[0].id, message: error.message }); }
    }
  }
  acceptLegacy(payload) {
    check(payload && isHash(payload.sha256) && Number.isSafeInteger(payload.size) && payload.size >= 0
      && payload.size <= SMALL_ASSET_LIMIT && typeof payload.data === 'string', 'Invalid attachment packet');
    const bytes = Buffer.from(payload.data, 'base64');
    check(bytes.length === payload.size && sha(bytes) === payload.sha256, 'Attachment integrity verification failed');
    const file = this.target(payload.sha256);
    atomicWrite(file, bytes); this.received(payload.sha256, file);
  }
  chunk(payload) {
    check(payload && isHash(payload.sha256) && Number.isSafeInteger(payload.size) && payload.size > ASSET_CHUNK_SIZE
      && payload.chunkSize === ASSET_CHUNK_SIZE && Number.isSafeInteger(payload.count)
      && payload.count === Math.ceil(payload.size / ASSET_CHUNK_SIZE) && Number.isSafeInteger(payload.index)
      && payload.index >= 0 && payload.index < payload.count && isHash(payload.chunkSha256)
      && typeof payload.data === 'string' && payload.data.length <= Math.ceil(ASSET_CHUNK_SIZE / 3) * 4,
    'Invalid attachment chunk');
    const bytes = Buffer.from(payload.data, 'base64');
    check(bytes.length === Math.min(ASSET_CHUNK_SIZE, payload.size - payload.index * ASSET_CHUNK_SIZE)
      && sha(bytes) === payload.chunkSha256, 'Attachment chunk integrity verification failed');
    return bytes;
  }
  acceptChunk(payload, name, digest) {
    this.chunk(payload);
    const key = this.key('assetIncoming', payload.sha256);
    const progress = this.store.local(key) || { sha256: payload.sha256, size: payload.size, count: payload.count, parts: {} };
    check(progress.size === payload.size && progress.count === payload.count, 'Inconsistent attachment chunks');
    progress.parts[payload.index] = { name, digest };
    this.store.local(key, progress);
  }
  async finish(report) {
    const prefix = this.key('assetIncoming', '');
    const rows = this.store.db.prepare('SELECT key FROM local_config WHERE key LIKE ?').all(`${prefix}%`);
    for (const { key } of rows) {
      const progress = this.store.local(key);
      if (Object.keys(progress.parts).length !== progress.count) continue;
      let temp, ownsTemp = false;
      try {
        const file = this.target(progress.sha256);
        if (await this.valid(file, progress)) { this.received(progress.sha256, file); continue; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // A stable staging name lets a restarted receiver replace its own unfinished assembly.
        temp = `${file}.sync.partial`; noSymlink(temp);
        const output = await fs.promises.open(temp, 'w', 0o600), digest = createHash('sha256');
        ownsTemp = true;
        try {
          for (let index = 0; index < progress.count; index++) {
            const ref = progress.parts[index];
            check(ref && typeof ref.name === 'string' && path.basename(ref.name) === ref.name, 'Missing attachment chunk');
            const input = inside(this.transport.root(), ref.name); noSymlink(input);
            check(fs.statSync(input).size <= 26 * 1024 * 1024, 'Attachment chunk packet is too large');
            const text = fs.readFileSync(input, 'utf8');
            check(sha(text) === ref.digest, 'Attachment chunk changed after arrival');
            const packet = this.transport.open(text), payload = packet.payload;
            check(packet.kind === 'asset-chunk' && payload.sha256 === progress.sha256 && payload.size === progress.size
              && payload.index === index && payload.count === progress.count, 'Attachment chunk does not match file');
            const bytes = this.chunk(payload); digest.update(bytes); await output.writeFile(bytes);
          }
          check(digest.digest('hex') === progress.sha256, 'Complete attachment integrity verification failed');
          await output.sync();
        } finally { await output.close(); }
        noSymlink(file); await fs.promises.rename(temp, file); temp = null;
        this.received(progress.sha256, file); report.assetsReceived++;
      } catch (error) { report.errors.push({ file: progress.sha256, message: error.message }); }
      finally { if (ownsTemp && temp && fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
  }
  async bind(report) {
    const records = this.records();
    report.assetsTotal = records.length; report.assetsAvailable = 0;
    for (const asset of records) {
      try {
        const local = this.store.assetLocation(asset.id);
        if (await this.valid(local?.path, asset.data)) { report.assetsAvailable++; continue; }
        const saved = this.store.local(`assetReceivedPath:${asset.data.sha256}`);
        const file = saved ? inside(this.store.directory, saved) : path.join(this.store.directory, 'objects', asset.data.sha256);
        if (await this.valid(file, asset.data)) {
          this.store.bindAsset(asset.id, file, local?.pinned === 1); report.assetsAvailable++;
        }
      } catch (error) { report.errors.push({ file: asset.id, message: error.message }); }
    }
    report.assetsMissing = report.assetsTotal - report.assetsAvailable;
  }
}
