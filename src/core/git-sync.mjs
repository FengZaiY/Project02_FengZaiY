import fs from 'node:fs';
import path from 'node:path';
import { GitVersions, SHARED, eventHeads, primaryRole } from './git-versions.mjs';
import { DirectoryChannel, assetObjects, publishAsset, receiveAsset, localAsset, validateAssets } from './sync-objects.mjs';
import { canonical, check, sha, uuid, now, noSymlink, outside, hashFile, isId, isHash } from './util.mjs';

const hexCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export class GitSync {
  constructor(store) {
    this.store = store; this.versions = new GitVersions(store); this.running = false;
    this.versions.announce();
  }
  config() {
    const key = this.store.secret('pairing');
    return { protocol: 2, configured: !!key && !!this.store.local('syncFolder'), enabled: false,
      manual: true, folder: this.store.local('syncFolder') || '', channel: key ? sha(Buffer.from(key, 'hex')).slice(0, 16) : null,
      attachmentMode: 'all-files', lastReport: this.store.local('v2LastReport'), cloudUploadVerified: false,
      legacyPreserved: true };
  }
  configure(folder, key) {
    check(!this.running && !this.store.local('v2Journal'), '请等待版本操作完成后更改同步配置', 'BUSY');
    check(typeof folder === 'string' && path.isAbsolute(folder), '请选择绝对路径的同步目录');
    check(typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), '配对密钥必须是 64 位十六进制');
    const root = path.resolve(folder);
    check(outside(this.store.directory, root) && outside(root, this.store.directory), '同步目录和工作目录不能互相包含');
    noSymlink(root); fs.mkdirSync(root, { recursive: true });
    this.store.local('syncFolder', root); this.store.setSecret('pairing', key.toLowerCase());
    this.store.local('syncEnabled', false);
    return this.config();
  }
  channel() {
    const config = this.config(); check(config.configured, '请先配置同步目录与配对密钥');
    return new DirectoryChannel(path.join(config.folder, 'StudySelfSync', 'v2', config.channel), Buffer.from(this.store.secret('pairing'), 'hex'));
  }
  channelKey() { return this.config().channel || 'unconfigured'; }
  publications() { return this.store.local(`v2Publications:${this.channelKey()}`) || []; }
  updatePublications(values) { this.store.local(`v2Publications:${this.channelKey()}`, values); }
  imports() { return this.store.local(`v2Imports:${this.channelKey()}`) || {}; }
  async exclusive(fn) {
    check(!this.running, '版本操作正在进行', 'BUSY'); this.running = true;
    try { this.versions.recover(); this.versions.error = null; return await fn(); } finally { this.running = false; }
  }
  guardEditing() {
    check(!(this.store.local('workspace')?.tabs || []).some(tab => tab.dirty), '请先保存所有未保存的笔记标签', 'UNSAVED');
  }
  commit(input) { return this.exclusive(() => { this.guardEditing(); return this.versions.commit(input.scope, input.message); }); }
  status() {
    const scopes = this.versions.scopes(), publications = this.publications();
    return { scopes, publications, busy: this.running, error: this.versions.error,
      uncommitted: scopes.filter(scope => scope.dirty).length,
      unpublished: scopes.filter(scope => scope.commit && !publications.some(item => item.scope === scope.scope && item.commit === scope.commit)).length,
      unconfirmed: publications.filter(item => !item.userConfirmedAt).length, config: this.config() };
  }
  async publish({ scope }) {
    return this.exclusive(async () => {
      const channel = this.channel(), pointer = this.versions.pointer(scope);
      check(pointer, '请先保存该知识库的版本');
      const publications = this.publications();
      const duplicate = publications.find(item => item.scope === scope && item.commit === pointer.commit);
      if (duplicate) return { ...duplicate, unchanged: true };
      const previous = publications.filter(item => item.scope === scope).at(-1);
      const snapshot = this.versions.read(scope, pointer.commit);
      const journalKey = `v2Publish:${this.channelKey()}:${sha(scope)}`;
      let operation = this.store.local(journalKey);
      if (!operation || operation.commit !== pointer.commit) {
        operation = { id: uuid(), scope, commit: pointer.commit, base: previous?.commit || null, at: now() };
        this.store.local(journalKey, operation);
      }
      const tempDir = path.join(this.store.directory, 'version-staging'); noSymlink(tempDir); fs.mkdirSync(tempDir, { recursive: true });
      const bundle = path.join(tempDir, `${operation.id}.bundle`);
      try {
        const bundleName = `bundle-${operation.id}.ssobj`;
        noSymlink(bundle);
        let bundleData;
        if (fs.existsSync(channel.file(bundleName))) bundleData = channel.read(bundleName, `v2:bundle:${operation.id}:${scope}`);
        else {
          if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
          this.versions.bundle(scope, operation.commit, operation.base, bundle);
          bundleData = fs.readFileSync(bundle);
        }
        check(bundleData.length <= 128 * 1024 * 1024, '版本包超过当前 128 MiB 上限，请缩小单次整理规模');
        channel.write(bundleName, bundleData, `v2:bundle:${operation.id}:${scope}`);
        const catalogue = new Map(publications.flatMap(item => item.assets || []).map(asset => [asset.hash, asset]));
        const assets = [];
        for (const asset of assetObjects(snapshot.events)) {
          const known = catalogue.get(asset.hash);
          assets.push(known ? { ...known, ids: asset.ids } : await publishAsset(channel, this.store, asset));
        }
        const manifest = { format: 2, ...operation, deviceId: this.store.deviceId, deviceName: this.store.getMeta('deviceName'),
          bundle: { name: bundleName, hash: sha(bundleData), size: bundleData.length }, assets };
        channel.writeJson(`release-${operation.id}.ssmanifest`, manifest, `v2:release:${operation.id}`);
        publications.push(manifest); this.updatePublications(publications); this.store.local(journalKey, null);
        this.store.markExported(snapshot.events.map(event => event.id));
        return manifest;
      } finally { if (fs.existsSync(bundle)) fs.unlinkSync(bundle); }
    });
  }
  validateManifest(manifest) {
    check(manifest?.format === 2 && isId(manifest.id) && isId(manifest.deviceId) && hexCommit(manifest.commit)
      && (!manifest.base || hexCommit(manifest.base)), 'Invalid publication');
    check(typeof manifest.scope === 'string' && manifest.scope.length <= 100 && typeof manifest.at === 'string', 'Invalid publication scope');
    check(manifest.bundle?.name === `bundle-${manifest.id}.ssobj` && isHash(manifest.bundle.hash)
      && Number.isSafeInteger(manifest.bundle.size) && manifest.bundle.size <= 128 * 1024 * 1024, 'Invalid bundle descriptor');
    validateAssets(manifest.assets); return manifest;
  }
  loadManifest(id) {
    check(isId(id), 'Invalid publication ID');
    const manifest = this.validateManifest(this.channel().json(`release-${id}.ssmanifest`, `v2:release:${id}`));
    check(manifest.id === id, 'Publication identity mismatch'); return manifest;
  }
  scan() {
    const channel = this.channel(), entries = [], errors = [], imported = this.imports();
    for (const name of channel.names('.ssmanifest')) {
      try {
        const id = name.slice('release-'.length, -'.ssmanifest'.length), manifest = this.loadManifest(id);
        const fingerprint = sha(canonical(manifest));
        check(!imported[id] || imported[id].fingerprint === fingerprint, '已接收的发布内容发生变化');
        const missing = [];
        for (const object of [manifest.bundle, ...manifest.assets.flatMap(asset => asset.chunks)]) {
          const file = channel.file(object.name);
          if (!fs.existsSync(file) || fs.statSync(file).size !== object.size + 36) missing.push(object.name);
        }
        entries.push({ ...manifest, imported: !!imported[id], metadataOnly: imported[id]?.metadataOnly,
          missing, localFilesPresent: missing.length === 0, integrityVerified: false, own: manifest.deviceId === this.store.deviceId });
      } catch (error) { errors.push({ file: name, message: error.message }); }
    }
    for (const name of channel.names('.ssreceipt')) {
      try {
        const id = name.slice('receipt-'.length, -'.ssreceipt'.length), receipt = channel.json(name, `v2:receipt:${id}`);
        check(receipt.id === id && isId(id) && isId(receipt.deviceId) && isId(receipt.epoch)
          && typeof receipt.at === 'string' && Number.isFinite(Date.parse(receipt.at))
          && Array.isArray(receipt.hashes) && receipt.hashes.length <= 100000 && receipt.hashes.every(isHash), 'Invalid file receipt');
        const receipts = this.store.local(`v2Receipts:${this.channelKey()}`) || {};
        check(!receipts[id] || canonical(receipts[id]) === canonical(receipt), 'Receipt collision');
        receipts[id] = receipt; this.store.local(`v2Receipts:${this.channelKey()}`, receipts);
      } catch (error) { errors.push({ file: name, message: error.message }); }
    }
    const report = { entries, errors, finishedAt: now(), cloudUploadVerified: false };
    this.store.local('v2LastReport', { errors, finishedAt: report.finishedAt, availablePublications: entries.length });
    return report;
  }
  async importRelease({ id, metadataOnly = false }) {
    return this.exclusive(async () => {
      this.guardEditing();
      const manifest = this.loadManifest(id), imported = this.imports(), fingerprint = sha(canonical(manifest));
      if (imported[id]) {
        check(imported[id].fingerprint === fingerprint, '已接收的发布内容发生变化');
        return { unchanged: true, ...imported[id] };
      }
      const role = primaryRole(this.versions.control());
      check(!metadataOnly || (role.primary && !role.conflict && role.primary !== this.store.deviceId), '仅已确定的非主力机可以只导入索引');
      this.versions.requireClean(manifest.scope);
      const channel = this.channel(), data = channel.read(manifest.bundle.name, `v2:bundle:${id}:${manifest.scope}`);
      check(data.length === manifest.bundle.size && sha(data) === manifest.bundle.hash, 'Git 版本包校验失败');
      const tempDir = path.join(this.store.directory, 'version-staging'); noSymlink(tempDir); fs.mkdirSync(tempDir, { recursive: true });
      const file = path.join(tempDir, `${id}.incoming.bundle`); noSymlink(file); fs.writeFileSync(file, data, { mode: 0o600 });
      let snapshot;
      try { snapshot = this.versions.receiveBundle(manifest.scope, file, manifest.commit); }
      finally { fs.unlinkSync(file); }
      check(canonical(assetObjects(snapshot.events)) === canonical(manifest.assets.map(({ hash, size, ids }) => ({ hash, size, ids }))), '原件清单与版本不一致');
      const current = new Set(assetObjects(eventHeads(snapshot.events)).map(asset => asset.hash));
      const paths = new Map();
      if (!metadataOnly) for (const asset of manifest.assets.filter(asset => current.has(asset.hash))) {
        paths.set(asset.hash, await receiveAsset(channel, this.store, asset));
      }
      const result = this.versions.merge(manifest.scope, snapshot, manifest.commit, {
        bindings: manifest.assets.filter(asset => paths.has(asset.hash)).flatMap(asset => asset.ids.map(assetId => [assetId, paths.get(asset.hash)])),
        importRecord: { key: `v2Imports:${this.channelKey()}`, id, fingerprint, scope: manifest.scope, at: now(), metadataOnly, manifest }
      });
      let receiptWarning;
      try { await this.verifyPrimary(); } catch (error) { receiptWarning = error.message; }
      return { ...result, metadataOnly, imported: true, receiptWarning };
    });
  }
  confirmUpload({ id, confirmed }) {
    check(!this.running, '请等待版本操作完成', 'BUSY');
    check(confirmed === true, '请在百度客户端确认传输完成');
    const values = this.publications(), publication = values.find(item => item.id === id);
    check(publication, '只能确认本机发布记录'); publication.userConfirmedAt = now(); this.updatePublications(values);
    return { userConfirmedAt: publication.userConfirmedAt, cloudUploadVerified: false };
  }
  async currentFiles() {
    const events = [...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })].flatMap(record => record.versions);
    const assets = assetObjects(events), missing = [], available = [];
    for (const asset of assets) (await localAsset(this.store, asset) ? available : missing).push(asset);
    return { total: assets.length, available, missing, at: now() };
  }
  devices() {
    const control = this.versions.control(), role = primaryRole(control), devices = new Map();
    for (const item of [...control.devices].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) devices.set(item.deviceId, item);
    const received = Object.values(this.imports());
    return { ...role, devices: [...devices.values()].map(item => ({ ...item, lastReceivedAt: received.filter(value => value.manifest?.deviceId === item.deviceId).map(value => value.at).sort().at(-1), local: item.deviceId === this.store.deviceId,
      primary: item.deviceId === role.primary })), completeness: this.store.local('v2Completeness') };
  }
  async setPrimary({ deviceId, parents, confirmed, recovery = false }) {
    return this.exclusive(async () => {
      check(confirmed === true && deviceId === this.store.deviceId, '必须在目标主力机上明确确认');
      const control = this.versions.control(), role = primaryRole(control);
      check(Array.isArray(parents) && parents.every(isId), '请选择当前主力角色版本');
      check(canonical([...parents].sort()) === canonical(role.heads.map(item => item.id).sort()), '主力角色已变化，请刷新', 'CONFLICT');
      check(!role.primary || role.primary === deviceId || recovery, '从其他主力机接管需要明确确认已检查最新同步内容');
      const files = await this.currentFiles(); check(!files.missing.length, '当前资料未齐全，不能设为主力机');
      control.roles.push({ id: uuid(), primary: deviceId, parents, at: now() });
      this.store.local('v2Control', control); this.store.local('v2Completeness', { total: files.total, available: files.total, at: files.at });
      return this.devices();
    });
  }
  async verifyPrimary() {
    const role = primaryRole(this.versions.control()), files = await this.currentFiles();
    this.store.local('v2Completeness', { total: files.total, available: files.available.length, missing: files.missing.length, at: files.at });
    if (role.conflict || role.primary !== this.store.deviceId || files.missing.length || !this.config().configured) return { ...files, receipt: false };
    const shared = this.versions.pointer(SHARED);
    if (!shared || primaryRole(this.versions.read(SHARED, shared.commit).control).epoch !== role.epoch) return { ...files, receipt: false };
    const committedHashes = new Set(this.versions.scopes().filter(scope => scope.commit && !scope.dirty)
      .flatMap(scope => assetObjects(this.versions.read(scope.scope, scope.commit).events).map(asset => asset.hash)));
    const hashes = files.available.map(asset => asset.hash).filter(hash => committedHashes.has(hash)).sort();
    const digest = sha(canonical({ epoch: role.epoch, hashes }));
    if (this.store.local(`v2LastReceipt:${this.channelKey()}`) === digest) return { ...files, receipt: true };
    const receipt = { id: uuid(), deviceId: this.store.deviceId, epoch: role.epoch, hashes, at: now() };
    this.channel().writeJson(`receipt-${receipt.id}.ssreceipt`, receipt, `v2:receipt:${receipt.id}`);
    this.store.local(`v2LastReceipt:${this.channelKey()}`, digest);
    return { ...files, receipt: true };
  }
  knownAssets() {
    return [...this.publications(), ...Object.values(this.imports()).map(item => item.manifest)].flatMap(item => item?.assets || []);
  }
  async hydrate({ id }) {
    return this.exclusive(async () => {
      const record = this.store.get(id); check(record?.type === 'asset', '请选择附件');
      const descriptor = this.knownAssets().find(asset => asset.hash === record.data.sha256);
      check(descriptor, '尚无此原文件的已导入版本，请先下载并导入对应发布清单');
      const file = await receiveAsset(this.channel(), this.store, descriptor);
      for (const assetId of descriptor.ids) if (this.store.get(assetId)) this.store.bindAsset(assetId, file, this.store.assetLocation(assetId)?.pinned === 1);
      await this.verifyPrimary(); return { available: true };
    });
  }
  async evict({ id, confirmed }) {
    return this.exclusive(async () => {
      check(confirmed === true, '释放原件需要明确确认'); this.guardEditing();
      const role = primaryRole(this.versions.control()); check(role.primary && !role.conflict, '请先确定唯一主力机');
      const record = this.store.get(id), local = this.store.assetLocation(id);
      check(record?.type === 'asset' && local && fs.existsSync(local.path), '本机没有可释放的原件');
      check(role.primary !== this.store.deviceId, '主力机当前资料和回收站原件必须保留');
      check(!record.conflict && !local.pinned, '冲突或指定保留的原件不能释放');
      check(!this.store.activeAssetReads?.get(id), '原件正在使用');
      this.versions.requireClean(record.data.domain);
      check(!this.versions.scopes().some(scope => scope.dirty), '请先提交所有本地修改，再释放原件');
      const receipts = Object.values(this.store.local(`v2Receipts:${this.channelKey()}`) || {});
      check(receipts.some(receipt => receipt.deviceId === role.primary && receipt.epoch === role.epoch && receipt.hashes.includes(record.data.sha256)), '尚未收到当前主力机对此原件的校验回执');
      check(this.knownAssets().some(asset => asset.hash === record.data.sha256), '没有可恢复的交接清单');
      const resolved = path.resolve(local.path); noSymlink(resolved);
      check(!Object.values(this.store.local('localFileLinks') || {}).some(file => path.resolve(file).toLowerCase() === resolved.toLowerCase()), '原件仍被本机文件链接引用，不能释放');
      check(!outside(this.store.directory, resolved) && outside(this.config().folder, resolved), '只能释放系统管理目录内的原件');
      const allowed = ['objects', 'received-objects'].map(folder => path.join(this.store.directory, folder, record.data.sha256));
      allowed.push(this.store.directories.assetPath(record.data.domain, record.data.sha256));
      check(allowed.some(file => path.resolve(file).toLowerCase() === resolved.toLowerCase()), '不是系统托管的内容寻址原件');
      const forbidden = ['knowledge.sqlite', 'knowledge.sqlite-wal', 'knowledge.sqlite-shm', 'device-vault.key'];
      check(!forbidden.includes(path.basename(resolved)) && !resolved.includes(`${path.sep}version-repositories${path.sep}`), '不能释放系统文件');
      const aliases = [...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })]
        .filter(asset => this.store.assetLocation(asset.id)?.path === local.path);
      for (const alias of aliases) {
        check(!this.store.assetLocation(alias.id)?.pinned && !this.store.activeAssetReads?.get(alias.id), '同一原件仍有保留或使用中的引用');
        this.versions.requireClean(alias.data.domain);
      }
      check(await hashFile(resolved) === record.data.sha256, '本机文件已变化，拒绝释放');
      check(!this.versions.scopes().some(scope => scope.dirty), '校验期间产生了新修改，原件未释放');
      this.guardEditing();
      check(!aliases.some(alias => this.store.assetLocation(alias.id)?.pinned), '校验期间原件被指定保留');
      check(!aliases.some(alias => this.store.activeAssetReads?.get(alias.id)), '原件正在使用');
      fs.unlinkSync(resolved);
      return { released: true, bytes: record.data.size, cloudDeleted: false };
    });
  }
  async restore(input) {
    return this.exclusive(async () => {
      this.guardEditing(); check(input.confirmed === true, '恢复知识库版本需要确认');
      const snapshot = this.versions.read(input.scope, input.commit);
      for (const asset of assetObjects(eventHeads(snapshot.events))) check(await localAsset(this.store, asset), '请先下载并恢复该历史版本的原文件');
      return this.versions.restore(input.scope, input.commit);
    });
  }
  async cycle() { return this.scan(); }
}
