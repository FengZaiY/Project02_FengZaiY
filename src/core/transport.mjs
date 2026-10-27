import { syncRootPath } from './legacy-names.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { uuid, now, sha, canonical, encrypt, decrypt, atomicWrite, check, isId, hashFile, noSymlink, outside } from './util.mjs';
import { AssetTransfer, SMALL_ASSET_LIMIT } from './asset-transfer.mjs';

export { SMALL_ASSET_LIMIT } from './asset-transfer.mjs';
const PACKET_LIMIT = 26 * 1024 * 1024;
export const makePairingKey = () => randomBytes(32).toString('hex');

export class FolderTransport {
  constructor(store) { this.store = store; this.running = false; }
  configure(folder, key) {
    check(typeof folder === 'string' && folder.length > 0 && path.isAbsolute(folder), 'Choose an absolute synchronization directory');
    check(typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), 'Pairing key must contain 64 hexadecimal characters');
    const root = path.resolve(folder);
    check(outside(this.store.directory, root) && outside(root, this.store.directory), 'Synchronization directory must not contain or be inside the local database directory');
    noSymlink(root);
    fs.mkdirSync(root, { recursive: true });
    const previous = this.store.secret('pairing');
    const oldFolder = this.store.local('syncFolder');
    if (previous && (previous !== key.toLowerCase() || oldFolder !== root)) {
      this.store.db.exec('UPDATE events SET exported=0,received=0; DELETE FROM packets; DELETE FROM receipts;');
      this.store.db.prepare("DELETE FROM local_config WHERE key LIKE 'assetPublished:%'").run();
      this.store.local('lastReceiptDigest', null);
    }
    this.store.local('syncFolder', root);
    this.store.setSecret('pairing', key.toLowerCase());
    this.store.local('syncEnabled', true);
    this.store.local('syncLastReport', null);
    return this.config();
  }
  config() {
    return { folder: this.store.local('syncFolder') || '', configured: !!this.store.secret('pairing'),
      enabled: this.store.local('syncEnabled') === true, lastReport: this.store.local('syncLastReport'), attachmentMode: 'all-files',
      channel: this.store.secret('pairing') ? sha(Buffer.from(this.store.secret('pairing'), 'hex')).slice(0, 16) : null };
  }
  root() {
    const config = this.config();
    check(config.configured && config.folder, 'Synchronization has not been configured');
    const root = path.join(syncRootPath(config.folder), 'v1', config.channel);
    noSymlink(root);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }
  seal(kind, payload, id = uuid()) {
    const header = { format: 1, kind, id, deviceId: this.store.deviceId };
    const key = Buffer.from(this.store.secret('pairing'), 'hex');
    const box = encrypt(Buffer.from(canonical(payload)), key, canonical(header));
    return JSON.stringify({ ...header, box });
  }
  open(text) {
    const envelope = JSON.parse(text);
    const { format, kind, id, deviceId, box } = envelope;
    check(format === 1 && ['events', 'receipt', 'asset', 'asset-chunk'].includes(kind) && isId(id) && isId(deviceId), 'Invalid sync envelope');
    const plain = decrypt(box, Buffer.from(this.store.secret('pairing'), 'hex'), canonical({ format, kind, id, deviceId }));
    const payload = JSON.parse(plain.toString('utf8'));
    return { ...envelope, payload };
  }
  writePacket(kind, payload, id = uuid()) {
    const file = path.join(this.root(), `${kind}-${this.store.deviceId}-${id}.ssync`);
    noSymlink(file);
    const text = this.seal(kind, payload, id);
    check(Buffer.byteLength(text) <= PACKET_LIMIT, 'Transfer packet is too large');
    atomicWrite(file, text);
    return file;
  }
  async cycle() {
    check(!this.running, 'Synchronization is already in progress', 'BUSY');
    check(this.config().enabled, 'Synchronization is paused');
    this.running = true;
    const report = { startedAt: now(), finishedAt: null, published: 0, imported: 0,
      assetsPublished: 0, assetChunksPublished: 0, assetsReceived: 0, errors: [], waitingParents: 0, cloudUploadVerified: false };
    try {
      const assets = new AssetTransfer(this);
      const root = this.root();
      const outgoing = this.store.unexported();
      // Bound batches by bytes, not just record count, so a large note stays transferable.
      let batch = [], bytes = 0;
      const flush = () => {
        if (!batch.length) return;
        this.writePacket('events', { events: batch });
        this.store.markExported(batch.map(e => e.id));
        report.published += batch.length;
        batch = []; bytes = 0;
      };
      for (const event of outgoing) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (batch.length >= 100 || bytes + size > 4 * 1024 * 1024) {
          flush();
          await new Promise(resolve => setImmediate(resolve));
        }
        batch.push(event); bytes += size;
      }
      flush();
      for (const name of fs.readdirSync(root).filter(name => name.endsWith('.ssync')).sort()) {
        await new Promise(resolve => setImmediate(resolve));
        const file = path.join(root, name);
        try {
          noSymlink(file);
          const stat = fs.statSync(file);
          check(stat.isFile() && stat.size <= PACKET_LIMIT, 'Packet exceeds transfer limit');
          const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const cacheKey = `packetFile:${sha(file)}`, cached = this.store.local(cacheKey);
          if (cached?.signature === signature) {
            if (cached.deviceId === this.store.deviceId) continue;
            const seen = this.store.db.prepare('SELECT hash FROM packets WHERE id=?').get(cached.id);
            if (seen?.hash === cached.digest && (cached.kind !== 'asset'
              || await assets.valid(assets.target(cached.sha256), cached))) continue;
          }
          const text = fs.readFileSync(file, 'utf8'), digest = sha(text);
          const packet = this.open(text);
          const remember = () => this.store.local(cacheKey, { signature, digest, id: packet.id, kind: packet.kind,
            deviceId: packet.deviceId, ...(packet.kind === 'asset' ? { sha256: packet.payload.sha256, size: packet.payload.size } : {}) });
          if (packet.deviceId === this.store.deviceId) { remember(); continue; }
          const prior = this.store.db.prepare('SELECT hash FROM packets WHERE id=?').get(packet.id);
          if (prior) {
            check(prior.hash === digest, 'Previously received packet was changed');
            remember();
            if (packet.kind !== 'asset' || await assets.valid(assets.target(packet.payload.sha256), packet.payload)) continue;
          }
          if (packet.kind === 'events') {
            check(packet.payload && Array.isArray(packet.payload.events), 'Missing revisions');
            const result = this.store.importEvents(packet.payload.events);
            report.imported += result.count;
            report.errors.push(...result.rejected.map(item => ({ file: item.id, message: item.message })));
          } else if (packet.kind === 'receipt') {
            check(Array.isArray(packet.payload.eventIds), 'Invalid acknowledgement');
            this.store.receipt(packet.payload.eventIds, packet.deviceId, packet.payload.at);
          } else if (packet.kind === 'asset') {
            assets.acceptLegacy(packet.payload); report.assetsReceived++;
          } else {
            assets.acceptChunk(packet.payload, name, digest);
          }
          if (!prior) this.store.db.prepare('INSERT INTO packets VALUES(?,?)').run(packet.id, digest);
          remember();
        } catch (error) {
          report.errors.push({ file: name, message: error.message });
        }
      }
      await assets.finish(report);
      await assets.bind(report);
      await assets.publish(report);
      const received = this.store.db.prepare('SELECT id FROM events WHERE device_id<>? ORDER BY id').all(this.store.deviceId);
      const receiptDigest = sha(received.map(e => e.id).sort().join(','));
      if (received.length && this.store.local('lastReceiptDigest') !== receiptDigest) {
        for (let index = 0; index < received.length; index += 5000) {
          this.writePacket('receipt', { eventIds: received.slice(index, index + 5000).map(e => e.id), at: now() });
        }
        this.store.local('lastReceiptDigest', receiptDigest);
      }
      report.waitingParents = this.store.summary().pendingParents;
      report.finishedAt = now();
      this.store.local('syncLastReport', report);
      return report;
    } finally {
      this.running = false;
    }
  }
}

const importQueues = new WeakMap();
export function importAttachment(store, input, options = {}) {
  const pending = (importQueues.get(store) || Promise.resolve()).catch(() => {}).then(() => importAttachmentSerial(store, input, options));
  importQueues.set(store, pending);
  pending.finally(() => { if (importQueues.get(store) === pending) importQueues.delete(store); }).catch(() => {});
  return pending;
}

async function importAttachmentSerial(store, input, { expectedId, pinned = false, domain = '通用', folderId, duplicateMode = 'reuse' } = {}) {
  check(['reuse', 'separate'].includes(duplicateMode), '重复资料处理方式无效');
  const file = path.resolve(input);
  noSymlink(file);
  const stat = fs.statSync(file);
  check(stat.isFile(), 'Choose a regular file');
  const hash = await hashFile(file);
  const extension = path.extname(file).toLowerCase();
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mov': 'video/quicktime',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv' })[extension] || 'application/octet-stream';
  let record;
  if (expectedId) {
    record = store.get(expectedId);
    check(record?.type === 'asset' && !record.conflict, 'Attachment metadata not found or conflicted');
    check(record.data.sha256 === hash && record.data.size === stat.size, 'This file does not match the requested attachment');
  }
  const reused = !expectedId && duplicateMode === 'reuse' && store.list({ type: 'asset' })
    .filter(item => !item.conflict && item.data.domain === domain && item.data.sha256 === hash && item.data.size === stat.size)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  record ||= reused || undefined;
  const before = record?.heads;
  const local = record && store.assetLocation(record.id);
  if (local && fs.existsSync(local.path)) {
    noSymlink(local.path);
    if (fs.statSync(local.path).size === stat.size && await hashFile(local.path) === hash) {
      check(canonical(store.headIds(record.id)) === canonical(before), '资料已变化，请重新导入', 'CONFLICT');
      if (pinned && !local.pinned) store.bindAsset(record.id, local.path, true);
      return { ...record, reused: !!reused };
    }
  }
  const owned = store.directories.assetPath(record?.data.domain || domain, hash);
  fs.mkdirSync(path.dirname(owned), { recursive: true });
  if (!fs.existsSync(owned)) {
    const temp = `${owned}.${uuid()}.partial`;
    try {
      await fs.promises.copyFile(file, temp);
      check(await hashFile(temp) === hash, 'Source changed during attachment import');
      try { await fs.promises.link(temp, owned); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  check(fs.statSync(owned).size === stat.size && await hashFile(owned) === hash, '已有托管文件校验失败，未覆盖，请检查文件后重试');
  if (record) check(canonical(store.headIds(record.id)) === canonical(before), '资料已变化，请重新导入', 'CONFLICT');
  const saveRecord = () => store.write({ type: 'asset', data: {
    title: path.basename(file), domain, ...(folderId ? { folderId } : {}), tags: [], sensitive: false, filename: path.basename(file),
    ...(store.personalSystem ? { centralized: true, collectionIds: [], libraryDomains: domain === '__materials__' ? [] : [domain] } : {}),
    size: stat.size, sha256: hash, mime, priority: stat.size > SMALL_ASSET_LIMIT ? 'large' : 'normal'
  } });
  record ||= store.personalSystem ? store.change('导入资料', '用户', saveRecord) : saveRecord();
  store.bindAsset(record.id, owned, pinned || local?.pinned === 1);
  return { ...record, reused: !!reused };
}
