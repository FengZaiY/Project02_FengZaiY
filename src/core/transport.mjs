import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { uuid, now, sha, canonical, encrypt, decrypt, atomicWrite, check, isId, isHash, hashFile, noSymlink, outside } from './util.mjs';

export const SMALL_ASSET_LIMIT = 16 * 1024 * 1024;
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
      enabled: this.store.local('syncEnabled') === true, lastReport: this.store.local('syncLastReport'),
      channel: this.store.secret('pairing') ? sha(Buffer.from(this.store.secret('pairing'), 'hex')).slice(0, 16) : null };
  }
  root() {
    const config = this.config();
    check(config.configured && config.folder, 'Synchronization has not been configured');
    const root = path.join(config.folder, 'StudySelfSync', 'v1', config.channel);
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
    check(format === 1 && ['events', 'receipt', 'asset'].includes(kind) && isId(id) && isId(deviceId), 'Invalid sync envelope');
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
  async publishAssets(report) {
    for (const asset of this.store.list({ type: 'asset' })) {
      const location = this.store.assetLocation(asset.id);
      if (!location || !fs.existsSync(location.path) || asset.data.size > SMALL_ASSET_LIMIT || asset.conflict) continue;
      const key = `assetPublished:${this.config().channel}:${asset.data.sha256}`;
      if (this.store.local(key)) continue;
      noSymlink(location.path);
      check(fs.statSync(location.path).size === asset.data.size, 'Attachment size changed after import');
      const data = await fs.promises.readFile(location.path);
      check(sha(data) === asset.data.sha256, 'Attachment contents changed after import');
      this.writePacket('asset', { sha256: asset.data.sha256, size: data.length, data: data.toString('base64') });
      this.store.local(key, true);
      report.assetsPublished++;
    }
  }
  acceptAsset(payload) {
    check(isHash(payload.sha256) && Number.isSafeInteger(payload.size) && payload.size >= 0 && payload.size <= SMALL_ASSET_LIMIT
      && typeof payload.data === 'string', 'Invalid attachment packet');
    const data = Buffer.from(payload.data, 'base64');
    check(data.length === payload.size && sha(data) === payload.sha256, 'Attachment integrity verification failed');
    const file = path.join(this.store.directory, 'objects', payload.sha256);
    atomicWrite(file, data);
    return file;
  }
  bindAvailableAssets() {
    for (const asset of this.store.list({ type: 'asset' })) {
      const file = path.join(this.store.directory, 'objects', asset.data.sha256);
      if (fs.existsSync(file) && fs.statSync(file).size === asset.data.size && !this.store.assetLocation(asset.id)) {
        this.store.bindAsset(asset.id, file);
      }
    }
  }
  async cycle() {
    check(!this.running, 'Synchronization is already in progress', 'BUSY');
    check(this.config().enabled, 'Synchronization is paused');
    this.running = true;
    const report = { startedAt: now(), finishedAt: null, published: 0, imported: 0,
      assetsPublished: 0, errors: [], waitingParents: 0, cloudUploadVerified: false };
    try {
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
      await this.publishAssets(report);
      for (const name of fs.readdirSync(root).filter(name => name.endsWith('.ssync')).sort()) {
        await new Promise(resolve => setImmediate(resolve));
        const file = path.join(root, name);
        try {
          noSymlink(file);
          const stat = fs.statSync(file);
          check(stat.isFile() && stat.size <= PACKET_LIMIT, 'Packet exceeds transfer limit');
          const text = fs.readFileSync(file, 'utf8'), digest = sha(text);
          const packet = this.open(text);
          if (packet.deviceId === this.store.deviceId) continue;
          const prior = this.store.db.prepare('SELECT hash FROM packets WHERE id=?').get(packet.id);
          if (prior) { check(prior.hash === digest, 'Previously received packet was changed'); continue; }
          if (packet.kind === 'events') {
            check(packet.payload && Array.isArray(packet.payload.events), 'Missing revisions');
            const result = this.store.importEvents(packet.payload.events);
            report.imported += result.count;
            report.errors.push(...result.rejected.map(item => ({ file: item.id, message: item.message })));
          } else if (packet.kind === 'receipt') {
            check(Array.isArray(packet.payload.eventIds), 'Invalid acknowledgement');
            this.store.receipt(packet.payload.eventIds, packet.deviceId, packet.payload.at);
          } else {
            this.acceptAsset(packet.payload);
          }
          this.store.db.prepare('INSERT INTO packets VALUES(?,?)').run(packet.id, digest);
        } catch (error) {
          report.errors.push({ file: name, message: error.message });
        }
      }
      this.bindAvailableAssets();
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

export async function importAttachment(store, input, { expectedId, pinned = false, domain = '通用' } = {}) {
  const file = path.resolve(input);
  noSymlink(file);
  const stat = fs.statSync(file);
  check(stat.isFile(), 'Choose a regular file');
  const hash = await hashFile(file);
  const extension = path.extname(file).toLowerCase();
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.txt': 'text/plain', '.md': 'text/markdown' })[extension] || 'application/octet-stream';
  let record;
  if (expectedId) {
    record = store.get(expectedId);
    check(record?.type === 'asset' && !record.conflict, 'Attachment metadata not found or conflicted');
    check(record.data.sha256 === hash && record.data.size === stat.size, 'This file does not match the requested attachment');
  }
  const owned = path.join(store.directory, 'objects', hash);
  fs.mkdirSync(path.dirname(owned), { recursive: true });
  if (!fs.existsSync(owned)) {
    const temp = `${owned}.${uuid()}.partial`;
    try {
      await fs.promises.copyFile(file, temp);
      check(await hashFile(temp) === hash, 'Source changed during attachment import');
      await fs.promises.rename(temp, owned);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  record ||= store.write({ type: 'asset', data: {
    title: path.basename(file), domain, tags: [], sensitive: false, filename: path.basename(file),
    size: stat.size, sha256: hash, mime, priority: stat.size > SMALL_ASSET_LIMIT ? 'large' : 'normal'
  } });
  store.bindAsset(record.id, owned, pinned);
  return record;
}
