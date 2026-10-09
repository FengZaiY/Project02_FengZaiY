import fs from 'node:fs';
import path from 'node:path';
import { uuid, now, sha, atomicWrite, check, inside, noSymlink, hashFile, outside } from './util.mjs';
import { validateEvent } from './store.mjs';
import { SMALL_ASSET_LIMIT } from './transport.mjs';

export class BackupManager {
  constructor(store) { this.store = store; this.running = false; }
  async create(destination, includeLarge = false) {
    check(!this.running, 'Backup is already running', 'BUSY');
    check(path.isAbsolute(destination), 'Choose an absolute backup directory');
    noSymlink(destination);
    check(outside(this.store.directory, destination), 'Backup directory must be outside the local database directory');
    this.running = true;
    const id = uuid(), root = path.join(destination, `StudySelf-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`);
    try {
      fs.mkdirSync(root, { recursive: true });
      // Export committed immutable revisions; the running SQLite database and credentials are excluded.
      const events = this.store.allEvents();
      const text = JSON.stringify({ format: 1, events });
      atomicWrite(path.join(root, 'revisions.json'), text);
      const manifest = { format: 1, id, createdAt: now(), deviceName: this.store.getMeta('deviceName'),
        revisionsSha256: sha(text), revisions: events.length, assets: [], pending: [], localComplete: false, cloudVerified: false };
      const allAssets = new Map(events.filter(e => e.type === 'asset').map(e => [e.data.sha256, e]));
      for (const event of allAssets.values()) {
        const file = this.store.assetLocation(event.entityId)?.path;
        if (!file || !fs.existsSync(file)) {
          manifest.pending.push({ assetId: event.entityId, sha256: event.data.sha256, reason: 'missing_local_file' });
          continue;
        }
        if (!includeLarge && event.data.size > SMALL_ASSET_LIMIT) {
          manifest.pending.push({ assetId: event.entityId, sha256: event.data.sha256, reason: 'deferred_large_file' });
          continue;
        }
        await this.copyAsset(root, event, file, manifest);
      }
      manifest.localComplete = manifest.pending.length === 0;
      atomicWrite(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
      this.record(root, manifest);
      return { directory: root, ...manifest };
    } finally { this.running = false; }
  }
  async copyAsset(root, event, file, manifest) {
    noSymlink(file);
    const destination = inside(root, `objects/${event.data.sha256}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temp = `${destination}.${uuid()}.partial`;
    try {
      await fs.promises.copyFile(file, temp);
      check(await hashFile(temp) === event.data.sha256 && fs.statSync(temp).size === event.data.size, 'Attachment changed or is corrupted');
      await fs.promises.rename(temp, destination);
      manifest.assets.push({ assetId: event.entityId, sha256: event.data.sha256, size: event.data.size, path: `objects/${event.data.sha256}` });
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  record(root, manifest) {
    const records = this.store.local('backups') || [];
    const record = { directory: root, id: manifest.id, createdAt: manifest.createdAt,
      pending: manifest.pending.length, deferredLarge: manifest.pending.filter(item => item.reason === 'deferred_large_file').length,
      localComplete: manifest.localComplete, cloudVerified: false, revisions: manifest.revisions };
    this.store.local('backups', [record, ...records.filter(item => item.id !== manifest.id)].slice(0, 100));
  }
  async continue(root) {
    check(!this.running, 'Backup is already running', 'BUSY');
    this.running = true;
    try {
      const { manifest, events } = await this.verify(root);
      const pending = [];
      for (const item of manifest.pending) {
        const event = events.find(e => e.type === 'asset' && e.data.sha256 === item.sha256);
        const file = event && this.store.assetLocation(event.entityId)?.path;
        if (!file || !fs.existsSync(file)) { pending.push(item); continue; }
        await this.copyAsset(root, event, file, manifest);
      }
      manifest.pending = pending; manifest.localComplete = pending.length === 0;
      atomicWrite(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
      this.record(root, manifest);
      return { directory: root, ...manifest };
    } finally { this.running = false; }
  }
  async verify(root) {
    noSymlink(root);
    const manifestPath = inside(root, 'manifest.json'), revisionsPath = inside(root, 'revisions.json');
    noSymlink(manifestPath); noSymlink(revisionsPath);
    check(fs.statSync(manifestPath).size < 16 * 1024 * 1024 && fs.statSync(revisionsPath).size < 512 * 1024 * 1024, 'Backup manifest exceeds limits');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    check(manifest.format === 1 && Array.isArray(manifest.assets) && Array.isArray(manifest.pending), 'Unsupported backup');
    const text = fs.readFileSync(revisionsPath, 'utf8');
    check(sha(text) === manifest.revisionsSha256, 'Backup revision checksum mismatch');
    const content = JSON.parse(text);
    check(content.format === 1 && Array.isArray(content.events), 'Invalid backup revisions');
    content.events.forEach(validateEvent);
    const byId = new Map(content.events.map(event => [event.id, event]));
    check(byId.size === content.events.length, 'Duplicate revision in backup');
    check(manifest.revisions === content.events.length, 'Backup revision count does not match');
    const dependents = new Map(), degree = new Map(), ready = [], ordered = [];
    const assetsById = new Map(), assetsByHash = new Map();
    for (const event of content.events) {
      degree.set(event.id, event.parents.length);
      if (!event.parents.length) ready.push(event);
      for (const parentId of event.parents) {
        const parent = byId.get(parentId);
        check(parent, 'Backup is missing parent revisions');
        check(parent.entityId === event.entityId && parent.type === event.type, 'Invalid backup parent');
        if (!dependents.has(parentId)) dependents.set(parentId, []);
        dependents.get(parentId).push(event.id);
      }
      if (event.type === 'asset') {
        const previous = assetsById.get(event.entityId);
        check(!previous || previous.data.sha256 === event.data.sha256, 'Attachment identity changed within backup');
        assetsById.set(event.entityId, event); assetsByHash.set(event.data.sha256, event);
      }
    }
    while (ready.length) {
      const event = ready.pop(); ordered.push(event);
      for (const child of dependents.get(event.id) || []) {
        degree.set(child, degree.get(child) - 1);
        if (degree.get(child) === 0) ready.push(byId.get(child));
      }
    }
    check(ordered.length === content.events.length, 'Cyclic revision graph in backup');
    const declared = new Set();
    for (const item of [...manifest.assets, ...manifest.pending]) {
      const event = assetsById.get(item.assetId);
      check(event && event.data.sha256 === item.sha256 && !declared.has(item.sha256), 'Invalid or duplicate attachment declaration');
      declared.add(item.sha256);
    }
    check(declared.size === assetsByHash.size, 'Backup omitted attachment availability information');
    check(manifest.localComplete === (manifest.pending.length === 0), 'Backup completeness flag does not match its contents');
    check(manifest.pending.every(item => ['missing_local_file', 'deferred_large_file'].includes(item.reason)), 'Invalid deferred attachment reason');
    for (const item of manifest.assets) {
      check(item.path === `objects/${item.sha256}`, 'Invalid backup asset path');
      const event = assetsById.get(item.assetId);
      check(event && event.data.size === item.size, 'Attachment is not described by backup revisions');
      const file = inside(root, item.path);
      noSymlink(file);
      check(fs.statSync(file).size === item.size && await hashFile(file) === item.sha256, 'Backup attachment checksum mismatch');
    }
    return { manifest, events: ordered };
  }
  async restore(root) {
    check(!this.running, 'Backup operation is in progress', 'BUSY');
    this.running = true;
    try {
      const { manifest, events } = await this.verify(root);
      // Stage verified, content-addressed files before committing revision history.
      for (const item of manifest.assets) {
        const destination = path.join(this.store.directory, 'objects', item.sha256);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temp = `${destination}.${uuid()}.partial`;
        try {
          await fs.promises.copyFile(inside(root, item.path), temp);
          check(await hashFile(temp) === item.sha256, 'Backup changed during restoration');
          await fs.promises.rename(temp, destination);
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      }
      // A restored archive is a merge, not a destructive replacement of current work.
      let imported = 0;
      this.store.transaction(() => {
        for (const event of events) {
          if (this.store.insert(event, false)) imported++;
        }
        const available = new Set(manifest.assets.map(item => item.sha256));
        for (const event of events) {
          if (event.type === 'asset' && available.has(event.data.sha256)) {
            this.store.bindAsset(event.entityId, path.join(this.store.directory, 'objects', event.data.sha256));
          }
        }
      });
      return { imported, unavailableAssets: manifest.pending.length, cloudVerified: false };
    } finally { this.running = false; }
  }
}
