import { syncRootPath } from './legacy-names.mjs';
import { requiresNamingFormat, assertNamingFormat } from './naming-format.mjs';
import { requiresReadableFormat, isReadableAsset } from './readable-storage.mjs';
import { MaterialCenter } from './material-center.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DirectoryChannel, assetObjects, assetAAD, localAsset, sealBinary, validateAssets } from './sync-objects.mjs';
import { describeAsset, assetChunk, diskSpace, receiveResumable } from './resumable-files.mjs';
import { EMPTY_CONTROL, eventHeads, mergeControl, primaryRole, orderedEvents } from './sync-state.mjs';
import { managementRevision, managementState } from './device-management.mjs';
import { LocalHierarchy } from './local-hierarchy.mjs';
import { writeSyncPointer } from './sync-publication.mjs';
import { filterErased, mergeErasures } from './erasures.mjs';
import { readErasureReceipts, readHistoryPart, cleanErasedTransport } from './erasure-sync.mjs';
import { prepareRemoteErasure } from './trash.mjs';
import { scheduleDeletion, runDeletionFiles } from './permanent-files.mjs';
import { retirementReceipts, replacementWorkspaces } from './retired-ai.mjs';
import { sameRevision } from './retired-presentation.mjs';
import { PERSONAL_TYPES, MATERIAL_SCOPE } from './personal-schema.mjs';
import { canonical, check, hashFile, isHash, isId, noSymlink, now, outside, sha, uuid } from './util.mjs';

const PART_BYTES = 2 * 1024 * 1024;
const DEFAULT_BATCH = 256 * 1024 * 1024;
const MIN_BATCH = 4 * 1024 * 1024 + 36;
const MAX_MANIFEST = 32 * 1024 * 1024;
const requiresPersonalFormat = event => PERSONAL_TYPES.includes(event.type) || event.type === 'asset' && (event.data?.centralized || event.data?.domain === MATERIAL_SCOPE || event.data?.collectionIds);
const tick = () => new Promise(resolve => setImmediate(resolve));
const manifestDigest = manifest => sha(canonical({ parts: manifest.parts, control: manifest.control, assets: manifest.assets,
  ...(manifest.format >= 4 ? { erasures: manifest.erasures } : {}) }));

export class CurrentSync {
  constructor(store, options = {}) {
    this.store = store; this.running = false; this.pauseRequested = false;
    this.space = options.space || diskSpace; this.reserveBytes = options.reserveBytes ?? 64 * 1024 * 1024;
    this.recoverLegacy(); this.announce();
    const progress = this.progress();
    if (progress?.state === 'running') this.saveProgress({ ...progress, state: 'paused', reason: '上次发布中断，可继续' });
  }
  config() {
    const key = this.store.secret('pairing');
    return { protocol: this.store.getMeta('presentationRetired') === '1' ? 6 : this.control().management?.length ? 5 : this.store.erasures().length ? 4 : 3, configured: !!key && !!this.store.local('syncFolder'), enabled: false, manual: true,
      folder: this.store.local('syncFolder') || '', channel: key ? sha(Buffer.from(key, 'hex')).slice(0, 16) : null,
      attachmentMode: 'all-files', lastReport: this.store.local('v3LastReport'), cloudUploadVerified: false };
  }
  key(name) { return `v3:${this.config().channel || 'unconfigured'}:${name}`; }
  value(name, value) { return arguments.length === 2 ? this.store.local(this.key(name), value) : this.store.local(this.key(name)); }
  progress() { return this.value('progress'); }
  saveProgress(value) { return this.value('progress', value); }
  control() { return this.store.local('v3Control') || structuredClone(EMPTY_CONTROL); }
  recoverLegacy() {
    const journal = this.store.local('v2Journal');
    if (journal) {
      const events = orderedEvents(journal.snapshot.events, this.store);
      const control = mergeControl(this.store.local('v2Control') || EMPTY_CONTROL, journal.snapshot.control || EMPTY_CONTROL);
      this.store.transaction(() => {
        if (journal.apply) {
          for (const event of events) this.store.insert(event, true);
          for (const [id, file] of journal.context?.bindings || []) this.store.bindAsset(id, file, this.store.assetLocation(id)?.pinned === 1);
        }
        this.store.local('v2Control', control);
        this.store.local('retiredV2Journal', journal);
        this.store.local('v2Journal', null);
      });
    }
    if (!this.store.local('v3Control')) this.store.local('v3Control', mergeControl(EMPTY_CONTROL, this.store.local('v2Control') || EMPTY_CONTROL));
  }
  announce() {
    const control = this.control(), name = this.store.getMeta('deviceName');
    const last = control.devices.filter(item => item.deviceId === this.store.deviceId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).at(-1);
    if (last?.name === name) return;
    control.devices.push({ id: uuid(), deviceId: this.store.deviceId, name, at: now() });
    this.store.local('v3Control', control);
  }
  configure(folder, key) {
    check(!this.running && !['ready', 'paused', 'blocked'].includes(this.progress()?.state), '请先完成或取消当前同步任务');
    check(typeof folder === 'string' && path.isAbsolute(folder), '请选择绝对路径的同步目录');
    check(typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), '配对密钥必须是 64 位十六进制');
    const root = path.resolve(folder);
    check(outside(this.store.directory, root) && outside(root, this.store.directory), '同步目录和工作目录不能互相包含');
    noSymlink(root); fs.mkdirSync(root, { recursive: true });
    this.store.transaction(() => {
      this.store.local('syncFolder', root); this.store.setSecret('pairing', key.toLowerCase());
      this.store.local('syncBindingRevision', uuid());
      this.store.local('syncEnabled', false);
    });
    return this.config();
  }
  disconnectPreview() {
    check(!this.running, '请先暂停同步并等待当前操作结束，再解除绑定', 'BUSY');
    const status = this.status(), devices = this.devices();
    const preview = { configured: status.config.configured, folder: status.config.folder, channel: status.config.channel,
      pendingChanges: status.pendingChanges, pendingControl: status.pendingControl, unconfirmed: status.unconfirmed,
      primary: devices.primary === this.store.deviceId, roleConflict: devices.conflict,
      transferPending: !!devices.transfer || devices.transferConflict,
      cancelTask: !!status.job && !['complete', 'cancelled'].includes(status.job.state) };
    return { ...preview, token: sha(canonical({ ...preview, binding: this.store.local('syncBindingRevision'),
      control: devices.revision, job: status.job, latest: status.latest })) };
  }
  disconnect({ confirmed, token } = {}) {
    check(confirmed === true, '请明确确认解除本机同步绑定');
    const preview = this.disconnectPreview();
    if (!preview.configured && !this.store.secret('pairing') && !this.store.local('syncFolder')) return this.config();
    check(typeof token === 'string' && token === preview.token, '同步配置或任务已变化，请重新确认解除绑定', 'CONFLICT');
    this.store.transaction(() => {
      // Cancel in the old channel before removing its key; keep files and recovery metadata.
      if (preview.cancelTask) this.saveProgress({ ...this.progress(), state: 'cancelled', reason: '已解除本机同步绑定；交接文件保留' });
      const remove = this.store.db.prepare('DELETE FROM local_config WHERE key=?');
      for (const name of ['secret:pairing', 'syncFolder', 'syncEnabled', 'syncBindingRevision', 'v3LastReport', 'syncLastReport']) remove.run(name);
    });
    this.pauseRequested = false;
    return this.config();
  }
  channel() {
    const config = this.config(); check(config.configured, '请先配置同步目录与配对密钥');
    return new DirectoryChannel(path.join(syncRootPath(config.folder), 'v3', config.channel), Buffer.from(this.store.secret('pairing'), 'hex'));
  }
  async exclusive(fn) {
    check(!this.running, '同步操作正在进行', 'BUSY'); this.running = true; this.pauseRequested = false;
    try { return await fn(); } finally { this.running = false; }
  }
  guardEditing() {
    check(!(this.store.local('workspace')?.tabs || []).some(tab => tab.dirty), '请先保存未保存的笔记标签', 'UNSAVED');
    check(!Object.values(this.store.local('personalDrafts') || {}).some(Boolean), '请先保存或放弃未提交的业务表单', 'UNSAVED');
  }
  guardParticipation() {
    const status = this.devices(), local = status.devices.find(device => device.local);
    check(!local?.suspended && !local?.statusConflict, '本机已停用或设备状态存在冲突，请由主力机恢复后拉取最新管理状态', 'FORBIDDEN');
  }
  applyControl(control) {
    this.store.local('v3Control', control);
    const local = managementState(control, primaryRole(control)).states.get(this.store.deviceId);
    if (local?.name && !local.nameConflict) this.store.setMeta('deviceName', local.name);
  }
  status() {
    const plan = this.value('plan'), latest = this.value('latest');
    const pendingChanges = this.store.unexported().length;
    const pendingControl = latest ? canonical(latest.control) !== canonical(this.control())
      || canonical(latest.erasures || []) !== canonical(this.store.erasures()) : true;
    const progress = this.progress();
    return { busy: this.running, config: this.config(), pendingChanges, pendingControl,
      unpublished: pendingChanges || pendingControl ? 1 : 0, unconfirmed: latest && !latest.userConfirmedAt ? 1 : 0,
      latest: latest ? { id: latest.id, at: latest.at, userConfirmedAt: latest.userConfirmedAt } : null,
      job: plan ? { id: plan.manifest.id, at: plan.manifest.at, ...progress,
        totalBytes: plan.totalBytes, estimatedAdditionalBytes: plan.additionalBytes, totalObjects: plan.objects.length,
        freeBytesAtPlan: plan.freeBytes, reserveBytes: this.reserveBytes, batchBytes: plan.batchBytes,
        estimatedBatches: plan.estimatedBatches } : null,
      receives: this.store.db.prepare("SELECT value FROM local_config WHERE key LIKE 'v3Receive:%'").all()
        .map(row => JSON.parse(row.value)).filter(Boolean) };
  }
  knownAssets() {
    return [this.value('latest'), ...Object.values(this.value('remotes') || {})].flatMap(item => item?.assets || []);
  }
  reusableObjects() {
    const proofs = { ...(this.value('confirmedObjects') || {}) };
    const add = object => { proofs[object.name] = `${object.hash}:${object.size}`; };
    const latest = this.value('latest'), plan = this.value('plan'), progress = this.progress();
    if (latest?.userConfirmedAt) {
      latest.parts.forEach(add); latest.assets.flatMap(asset => asset.chunks).forEach(add);
    }
    for (const object of (plan?.objects || []).slice(0, progress?.confirmedThrough || 0)) add(object);
    // Downloaded remote indexes can be inherited by index-only devices. Importing our
    // own pointer is not evidence that our unconfirmed objects reached another device.
    for (const remote of Object.values(this.value('remotes') || {})) {
      if (remote.deviceId !== this.store.deviceId) remote.assets.flatMap(asset => asset.chunks).forEach(add);
    }
    return proofs;
  }
  async plan({ batchBytes = DEFAULT_BATCH } = {}) {
    return this.exclusive(async () => {
      this.guardParticipation();
      this.guardEditing();
      check(Number.isSafeInteger(batchBytes) && batchBytes >= MIN_BATCH && batchBytes <= 4 * 1024 ** 3, '批次大小须在 5 MiB 至 4 GiB 之间');
      if (this.value('plan') && !['complete', 'cancelled'].includes(this.progress()?.state)) return this.status();
      const channel = this.channel(), events = orderedEvents(this.store.allEvents(), this.store).sort((a, b) => a.id.localeCompare(b.id));
      const parts = [], metadata = {}, objects = [];
      let group = [], size = 2;
      const flush = () => {
        if (!group.length) return;
        const text = canonical(group), hash = sha(text), name = `history-${hash}.ssobj`;
        const part = { name, hash, size: Buffer.byteLength(text), count: group.length };
        parts.push(part); metadata[name] = group;
        objects.push({ kind: 'history', ...part }); group = []; size = 2;
      };
      for (const event of events) {
        const length = Buffer.byteLength(canonical(event)) + 1;
        if (size + length > PART_BYTES) flush();
        group.push(event); size += length;
      }
      flush();
      const known = new Map(this.knownAssets().map(asset => [asset.hash, asset])), assets = [], proofs = this.reusableObjects();
      for (const asset of assetObjects(events)) {
        check(!this.pauseRequested, '空间预估已取消', 'PAUSED');
        const descriptor = await describeAsset(this.store, asset, known.get(asset.hash));
        const assetIndex = assets.length; assets.push(descriptor);
        descriptor.chunks.forEach((chunk, index) => objects.push({ kind: 'asset', ...chunk, assetIndex, index }));
      }
      const erasures = this.store.erasures();
      const format = events.some(requiresReadableFormat) || erasures.some(requiresReadableFormat) ? 9 : events.some(requiresNamingFormat) ? 8 : events.some(requiresPersonalFormat) || erasures.some(requiresPersonalFormat) ? 7 : events.some(event => event.retiredPresentation) ? 6 : this.control().management?.length ? 5 : erasures.length ? 4 : 3;
      const manifest = { format, ...(format >= 4 ? { erasures } : {}), id: uuid(), deviceId: this.store.deviceId, deviceName: this.store.getMeta('deviceName'),
        at: now(), parts, assets, control: mergeControl(EMPTY_CONTROL, this.control()) };
      manifest.digest = manifestDigest(manifest);
      for (const object of objects) object.reusable = proofs[object.name] === `${object.hash}:${object.size}`;
      if (this.value('latest')?.digest === manifest.digest && this.value('latest')?.format === manifest.format
        && fs.existsSync(channel.file(`current-${this.store.deviceId}.sscurrent`))
        && objects.every(object => object.reusable || fs.existsSync(channel.file(object.name)))) return { ...this.status(), unchanged: true };
      const latestBytes = Buffer.byteLength(canonical(manifest)) + 36;
      check(latestBytes <= MAX_MANIFEST, '文件索引超过当前单清单容量，请减少本批资料或联系维护者');
      const freeBytes = this.space(channel.root).freeBytes, capacity = Math.min(batchBytes, Math.max(0, freeBytes - this.reserveBytes - latestBytes));
      const additionalBytes = objects.filter(object => !object.reusable && !fs.existsSync(channel.file(object.name))).reduce((sum, object) => sum + object.size + 36, latestBytes);
      const plan = { manifest, metadata, objects, totalBytes: objects.reduce((sum, object) => sum + object.size + 36, latestBytes),
        additionalBytes, freeBytes, batchBytes, latestBytes, estimatedBatches: capacity >= MIN_BATCH ? Math.max(1, Math.ceil(additionalBytes / capacity)) : null };
      this.store.transaction(() => {
        this.value('confirmedObjects', proofs);
        this.value('plan', plan);
        this.saveProgress({ state: 'ready', next: 0, generatedBytes: 0, confirmedThrough: 0, completedObjects: 0, reason: '' });
      });
      return this.status();
    });
  }
  pause() {
    this.pauseRequested = true;
    const progress = this.progress();
    if (progress && !this.running && !['complete', 'cancelled'].includes(progress.state)) this.saveProgress({ ...progress, state: 'paused', reason: '用户暂停' });
    return this.status();
  }
  cancel() {
    check(!this.running, '请先暂停并等待当前分块完成');
    const progress = this.progress();
    if (progress) this.saveProgress({ ...progress, state: 'cancelled', reason: '已取消；已有交接文件保留' });
    return this.status();
  }
  confirmBatch({ confirmed }) {
    check(confirmed === true && !this.running, '请等待本批生成完成并明确确认上传');
    const progress = this.progress(); check(progress, '尚无发布批次');
    this.saveProgress({ ...progress, confirmedThrough: progress.next, batchConfirmedAt: now() });
    this.value('confirmedObjects', this.reusableObjects());
    return this.status();
  }
  async publish({ batchBytes } = {}) {
    if (!this.value('plan') || ['complete', 'cancelled'].includes(this.progress()?.state)) {
      const result = await this.plan({ batchBytes });
      if (result.unchanged) return result;
    }
    return this.exclusive(async () => {
      this.guardEditing();
      this.guardParticipation();
      const plan = this.value('plan'), channel = this.channel(), progress = { ...this.progress(), state: 'running', phase: 'objects', reason: '' };
      assertNamingFormat(plan.manifest.format, Object.values(plan.metadata).flat());
      check(plan.manifest.format >= 9 || !Object.values(plan.metadata).flat().some(requiresReadableFormat), '目录结构已升级，请取消旧发布任务并重新规划');
      check(canonical(plan.manifest.control.management || []) === canonical(this.control().management || [])
        && canonical(plan.manifest.control.roles) === canonical(this.control().roles), '设备管理或主力角色已变化，请取消旧发布任务后重新发布', 'CONFLICT');
      this.saveProgress(progress);
      const save = (state, reason) => { Object.assign(progress, { state, reason }); this.saveProgress(progress); return this.status(); };
      const proofs = this.reusableObjects();
      const reusable = object => proofs[object.name] === `${object.hash}:${object.size}`;
      // Re-evaluate persisted plans from earlier clients and repair vanished, unconfirmed
      // objects even when they were generated before a pause or process interruption.
      const missing = plan.objects.findIndex(object => !reusable(object) && !fs.existsSync(channel.file(object.name)));
      if (missing >= 0) progress.next = Math.min(progress.next, missing);
      let batchBytes = 0;
      try {
        for (let i = progress.next; i < plan.objects.length; i++) {
          if (this.pauseRequested) return save('paused', '用户暂停，已保留进度');
          const object = plan.objects[i], asset = object.kind === 'asset' ? plan.manifest.assets[object.assetIndex] : null;
          const aad = asset ? assetAAD(asset, object.index) : `v3:history:${object.hash}`;
          const exists = fs.existsSync(channel.file(object.name));
          if (exists) {
            const data = channel.read(object.name, aad);
            check(data.length === object.size && sha(data) === object.hash, '交接对象损坏，请重新下载或移开损坏副本');
          } else if (!reusable(object)) {
            const required = object.size + 36;
            if (batchBytes + required > plan.batchBytes) return save('paused', '本批已生成，确认客户端上传后可继续下一批');
            if (this.space(channel.root).freeBytes - this.reserveBytes - plan.latestBytes < required) {
              return save('blocked', '同步目录可用空间不足；可在百度客户端上传并仅释放本地副本后继续');
            }
            const data = asset ? await assetChunk(this.store, asset, object.index) : Buffer.from(canonical(plan.metadata[object.name]));
            channel.write(object.name, data, aad); batchBytes += required;
            progress.generatedBytes += required;
          }
          progress.next = i + 1; progress.completedObjects = i + 1;
          this.saveProgress(progress); await tick();
        }
        // Missing newly generated objects are safe to reference only after the user confirms
        // that batch was uploaded. This never claims an API-verified cloud upload.
        for (let i = 0; i < plan.objects.length; i++) {
          const object = plan.objects[i];
          check(reusable(object) || fs.existsSync(channel.file(object.name)),
            '已生成分块不在本机，请确认对应批次已上传后再继续');
        }
        check(this.space(channel.root).freeBytes - this.reserveBytes >= plan.latestBytes, '空间不足，无法写入最新内容清单', 'SPACE');
        const name = `current-${this.store.deviceId}.sscurrent`;
        progress.phase = 'manifest'; save('running', '交接对象已就绪，正在更新最新内容清单');
        await writeSyncPointer(channel.file(name), sealBinary(Buffer.from(canonical(plan.manifest)), channel.key, `v3:current:${this.store.deviceId}`), {
          shouldPause: () => this.pauseRequested,
          onRetry: ({ attempt, total }) => save('running', `最新内容清单暂时被占用或访问受限，正在等待重试（${attempt}/${total}），可点击暂停`)
        });
        this.store.transaction(() => {
          this.value('latest', plan.manifest);
          for (const events of Object.values(plan.metadata)) for (const event of events) this.store.db.prepare('UPDATE events SET exported=1 WHERE id=?').run(event.id);
          this.saveProgress({ ...progress, state: 'complete', reason: '最新内容已生成，等待客户端上传', finishedAt: now() });
        });
        const cleanup = cleanErasedTransport(this);
        return { ...this.status(), cleanup };
      } catch (error) {
        if (error.code === 'PAUSED') return save('paused', error.message);
        save('blocked', error.message); throw error;
      }
    });
  }
  validateManifest(manifest, deviceId) {
    check([3, 4, 5, 6, 7, 8, 9].includes(manifest?.format) && isId(manifest.id) && manifest.deviceId === deviceId && isId(deviceId)
      && typeof manifest.deviceName === 'string' && manifest.deviceName.length <= 100 && Number.isFinite(Date.parse(manifest.at)), '无效的最新内容清单');
    check(Object.keys(manifest).sort().join() === (manifest.format >= 4
      ? 'assets,at,control,deviceId,deviceName,digest,erasures,format,id,parts' : 'assets,at,control,deviceId,deviceName,digest,format,id,parts'), '清单含未知字段');
    if (manifest.format >= 4) mergeErasures(manifest.erasures);
    check(manifest.format >= 5 || !manifest.control?.management?.length, '设备管理需要 format 5，请升级所有同步电脑');
    check(Array.isArray(manifest.parts) && manifest.parts.length <= 100000, 'Invalid history parts');
    const names = new Set();
    for (const part of manifest.parts) {
      check(isHash(part.hash) && part.name === `history-${part.hash}.ssobj` && !names.has(part.name)
        && Number.isSafeInteger(part.size) && part.size > 0 && part.size <= PART_BYTES
        && Number.isSafeInteger(part.count) && part.count > 0, 'Invalid history part');
      names.add(part.name);
    }
    validateAssets(manifest.assets); mergeControl(EMPTY_CONTROL, manifest.control);
    check(manifest.digest === manifestDigest(manifest), '最新内容清单校验失败');
    const seen = (this.value('seen') || {})[manifest.id];
    check(!seen || seen === sha(canonical(manifest)), '已接收的同步内容发生变化');
    return manifest;
  }
  loadCurrent(name) {
    check(/^current-[a-f0-9-]{36}\.sscurrent$/.test(name), 'Invalid current file');
    const deviceId = name.slice(8, -10);
    return this.validateManifest(this.channel().json(name, `v3:current:${deviceId}`), deviceId);
  }
  scan() {
    const channel = this.channel(), entries = [], errors = [], seen = this.value('seen') || {};
    const erased = new Set(mergeErasures(this.store.erasures(), readErasureReceipts(channel)).map(item => item.entityId));
    for (const name of channel.names('.sscurrent')) {
      try {
        const manifest = this.loadCurrent(name), missing = [], invalid = [];
        for (const part of manifest.parts) {
          try { readHistoryPart(channel, part); } catch (error) {
            if (error.code === 'ENOENT') missing.push(part.name);
            else { invalid.push(part.name); errors.push({ file: part.name, message: error.message }); }
          }
        }
        for (const object of manifest.assets.filter(asset => asset.ids.some(id => !erased.has(id))).flatMap(asset => asset.chunks)) {
          const file = channel.file(object.name);
          if (!fs.existsSync(file) || fs.statSync(file).size !== object.size + 36) missing.push(object.name);
        }
        entries.push({ id: manifest.id, deviceId: manifest.deviceId, deviceName: manifest.deviceName, at: manifest.at,
          own: manifest.deviceId === this.store.deviceId, imported: !!seen[manifest.id], missing, invalid });
      } catch (error) { errors.push({ file: name, message: error.message }); }
    }
    this.readReceipts(errors);
    const report = { entries, errors, finishedAt: now(), cloudUploadVerified: false };
    this.store.local('v3LastReport', { errors, finishedAt: report.finishedAt, availablePublications: entries.length });
    return report;
  }
  async importLatest({ metadataOnly = false } = {}) {
    return this.exclusive(async () => {
      this.guardEditing();
      const channel = this.channel(), manifests = channel.names('.sscurrent').map(name => this.loadCurrent(name)), union = new Map(), descriptors = new Map();
      check(manifests.length, '尚未发现最新内容，请先在百度客户端下载');
      let control = manifests.reduce((value, manifest) => mergeControl(value, manifest.control), this.control());
      const management = managementState(control, primaryRole(control)), local = management.states.get(this.store.deviceId);
      if (local?.suspended || local?.statusConflict) {
        this.store.transaction(() => this.applyControl(control));
        return { imported: 0, unchanged: true, managementOnly: true, devices: manifests.length,
          receiptWarning: '本机已停用，仅接收设备管理状态，笔记和原件保留' };
      }
      const incoming = manifests.filter(manifest => {
        const device = management.states.get(manifest.deviceId); return !device?.suspended && !device?.statusConflict;
      });
      const histories = new Map(incoming.map(manifest => [manifest.id, manifest.parts.flatMap(part => readHistoryPart(channel, part))]));
      let erasures = mergeErasures(this.store.erasures(), readErasureReceipts(channel), ...incoming.map(manifest => manifest.erasures || []));
      erasures = mergeErasures(erasures, retirementReceipts(this.store, [...this.store.allEvents(), ...[...histories.values()].flat()], erasures));
      const erasedIds = new Set(erasures.map(item => item.entityId));
      for (const manifest of incoming) {
        const original = histories.get(manifest.id);
        assertNamingFormat(manifest.format, original);
        check(manifest.format >= 7 || ![...original, ...(manifest.erasures || [])].some(requiresPersonalFormat), '个人管理记录需要 format 7，请升级所有同步客户端');
        check(manifest.format >= 9 || !original.some(requiresReadableFormat), '资料分类与路径方案需要 format 9，请升级所有同步客户端');
        const events = [...filterErased(original, erasures), ...replacementWorkspaces(original, erasures)];
        orderedEvents(events, this.store);
        const assets = manifest.assets.map(asset => ({ ...asset, ids: asset.ids.filter(id => !erasedIds.has(id)) })).filter(asset => asset.ids.length);
        check(canonical(assetObjects(events)) === canonical(assets.map(({ hash, size, ids }) => ({ hash, size, ids }))), '原件索引与修改记录不一致');
        for (const event of events) {
          check(!union.has(event.id) || sameRevision(union.get(event.id), event), '同步记录身份冲突'); union.set(event.id, event);
        }
        for (const asset of assets) {
          const previous = descriptors.get(asset.hash);
          check(!previous || canonical(previous.chunks) === canonical(asset.chunks), '原件分块身份冲突');
          descriptors.set(asset.hash, { ...asset, ids: [...new Set([...(previous?.ids || []), ...asset.ids])].sort() });
        }
        control = mergeControl(control, manifest.control);
      }
      check(incoming.length, '所有已发现设备均已停用，请等待主力机发布');
      prepareRemoteErasure(this.store, erasures, [...union.values()]);
      const role = primaryRole(control);
      check(!metadataOnly || role.primary && !role.conflict && role.primary !== this.store.deviceId, '仅已确定的非主力机可以只导入索引');
      const current = assetObjects(eventHeads([...union.values()])), paths = new Map();
      if (!metadataOnly) for (const asset of current) {
        paths.set(asset.hash, await receiveResumable(channel, this.store, descriptors.get(asset.hash),
          { space: this.space, reserveBytes: this.reserveBytes, paused: () => this.pauseRequested }));
      }
      this.guardEditing();
      const events = orderedEvents([...union.values()], this.store);
      let count = 0;
      this.store.transaction(() => {
        const deletion = prepareRemoteErasure(this.store, erasures, [...union.values()]);
        if (erasures.length) {
          scheduleDeletion(this.store, deletion.ids, deletion.files);
          this.store.eraseRaw(erasures);
        }
        for (const event of events) {
          if (this.store.insert(event, true)) count++;
          this.store.db.prepare('DELETE FROM pending WHERE id=?').run(event.id);
        }
        this.applyControl(mergeControl(this.control(), control));
        for (const [hash, file] of paths) for (const id of descriptors.get(hash).ids) this.store.bindAsset(id, file, this.store.assetLocation(id)?.pinned === 1);
        const remotes = this.value('remotes') || {}, seen = this.value('seen') || {};
        for (const manifest of incoming) { remotes[manifest.deviceId] = manifest; seen[manifest.id] = sha(canonical(manifest)); }
        this.value('remotes', remotes); this.value('seen', seen); this.value('receivedAt', now());
      });
      const cleanup = erasures.length ? await runDeletionFiles(this.store) : null;
      let directoryWarning;
      if (this.store.personalSystem && paths.size) {
        const materials = new MaterialCenter(this.store, new LocalHierarchy(this.store));
        const ids = [...paths.keys()].flatMap(hash => descriptors.get(hash).ids);
        try { const preview = materials.preview({ ids }); if (preview.rows.length) { const job = await materials.migrate({ token: preview.token, confirmed: true, ids }); if (job.state !== 'complete') directoryWarning = '部分原件目录待整理，已保留校验后的接收原件'; } }
        catch (error) { directoryWarning = error.message; }
      }
      if (erasures.length || this.store.getMeta('presentationRetired') === '1') cleanErasedTransport(this);
      let receiptWarning;
      try { await this.verifyPrimary(); } catch (error) { receiptWarning = error.message; }
      return { imported: count, unchanged: !count, metadataOnly, devices: incoming.length,
        skippedDevices: manifests.length - incoming.length, receiptWarning, directoryWarning, cleanup };
    });
  }
  confirmUpload({ id, confirmed }) {
    check(!this.running && confirmed === true, '请在百度客户端确认上传完成');
    const latest = this.value('latest'); check(latest && (!id || latest.id === id), '最新发布已变化，请刷新后确认');
    latest.userConfirmedAt = now(); this.value('latest', latest);
    this.value('confirmedObjects', this.reusableObjects());
    const progress = this.value('progress');
    if (progress?.state === 'complete' && this.value('plan')?.manifest.id === latest.id) {
      progress.reason = '用户已确认本次上传'; this.value('progress', progress);
    }
    return this.status();
  }
  async currentFiles() {
    const assets = assetObjects([...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })].flatMap(record => record.versions));
    const missing = [], available = [];
    for (const asset of assets) (await localAsset(this.store, asset) ? available : missing).push(asset);
    return { total: assets.length, available, missing, at: now() };
  }
  devices() {
    const control = this.control(), role = primaryRole(control), devices = new Map(), remotes = this.value('remotes') || {};
    const management = managementState(control, role);
    for (const item of [...control.devices].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) devices.set(item.deviceId, item);
    return { ...role, revision: managementRevision(control), canManage: !role.conflict && role.primary === this.store.deviceId,
      transfer: management.transfer, transferConflict: management.transferConflict,
      devices: [...devices.values()].map(item => ({ ...item, ...management.states.get(item.deviceId),
      name: management.states.get(item.deviceId)?.name || item.name, local: item.deviceId === this.store.deviceId,
      primary: item.deviceId === role.primary, lastReceivedAt: remotes[item.deviceId] ? this.value('receivedAt') : null })),
    completeness: this.store.local('v3Completeness') };
  }
  async manageDevice({ deviceId, action, name, revision, requestId, confirmed }) {
    return this.exclusive(async () => {
      check(confirmed === true && isId(requestId), '请明确确认设备管理操作');
      const control = this.control(), role = primaryRole(control), management = managementState(control, role);
      const existing = control.management?.find(event => event.id === requestId);
      if (existing) {
        check(existing.actor === this.store.deviceId && existing.deviceId === deviceId && existing.action === action
          && existing.name === name, '重复请求内容不一致', 'CONFLICT');
        return this.devices();
      }
      check(!role.conflict && role.primary === this.store.deviceId, '仅当前唯一主力机可以管理设备', 'FORBIDDEN');
      check(revision === managementRevision(control), '设备状态已变化，请刷新后重新确认', 'CONFLICT');
      check(management.states.has(deviceId), '设备不存在');
      const local = management.states.get(this.store.deviceId), target = management.states.get(deviceId);
      check(!local?.suspended || (action === 'resume' && deviceId === this.store.deviceId), '请先恢复本机设备状态');
      if (action === 'suspend') check(deviceId !== role.primary && management.transfer?.deviceId !== deviceId,
        '不能停用主力机或待接管设备，请先完成或取消主力机转移');
      if (action === 'transfer') check(deviceId !== role.primary && !target.suspended && !target.statusConflict,
        '请选择已启用且无状态冲突的其他设备');
      if (action === 'cancel-transfer') check(management.transfer || management.transferConflict, '没有待处理的主力机转移');
      const event = { id: requestId, at: now(), actor: this.store.deviceId, epoch: role.epoch, parents: management.heads,
        deviceId, action, ...(action === 'rename' ? { name } : {}) };
      const next = mergeControl(control, { ...EMPTY_CONTROL, management: [event] });
      this.store.transaction(() => this.applyControl(next));
      return this.devices();
    });
  }
  async setPrimary({ deviceId, parents, confirmed, revision, transferId }) {
    return this.exclusive(async () => {
      check(confirmed === true && deviceId === this.store.deviceId, '必须在目标主力机上明确确认');
      const control = this.control(), role = primaryRole(control);
      const management = managementState(control, role), local = management.states.get(deviceId);
      check(!local?.suspended && !local?.statusConflict, '本机已停用或状态冲突，不能接管主力角色', 'FORBIDDEN');
      if (control.management?.length) check(revision === managementRevision(control), '设备状态已变化，请刷新后重新确认', 'CONFLICT');
      check(Array.isArray(parents) && canonical([...parents].sort()) === canonical(role.heads.map(item => item.id).sort()), '主力角色已变化，请刷新');
      if (role.primary === deviceId) return this.devices();
      if (role.conflict) check(role.recoveryDevices.includes(deviceId), '请在主力角色冲突的参与设备上处理', 'FORBIDDEN');
      if (role.primary && role.primary !== deviceId) check(!management.transferConflict && management.transfer?.id === transferId
        && management.transfer?.deviceId === deviceId, '请先由当前主力机发起转移并拉取最新内容', 'FORBIDDEN');
      const files = await this.currentFiles(); check(!files.missing.length, '当前资料未齐全，不能设为主力机');
      check(managementRevision(this.control()) === managementRevision(control), '校验期间设备状态已变化，请重新确认', 'CONFLICT');
      control.roles.push({ id: uuid(), primary: deviceId, parents, at: now(), ...(role.primary ? { transferId } : {}),
        ...(control.management?.length ? { managementParents: management.heads, ...(role.conflict ? { recovery: true } : {}) } : {}) });
      const next = mergeControl(EMPTY_CONTROL, control);
      this.store.transaction(() => {
        this.applyControl(next); this.store.local('v3Completeness', { total: files.total, available: files.total, at: files.at });
      });
      return this.devices();
    });
  }
  async verifyPrimary() {
    const role = primaryRole(this.control()), files = await this.currentFiles();
    this.store.local('v3Completeness', { total: files.total, available: files.available.length, missing: files.missing.length, at: files.at });
    const local = managementState(this.control(), role).states.get(this.store.deviceId);
    if (local?.suspended || local?.statusConflict || role.conflict || role.primary !== this.store.deviceId || files.missing.length || !this.config().configured) return { ...files, receipt: false };
    const published = new Set(this.knownAssets().map(asset => asset.hash));
    const hashes = files.available.map(asset => asset.hash).filter(hash => published.has(hash)).sort();
    const digest = sha(canonical({ epoch: role.epoch, hashes }));
    if (this.value('receiptDigest') === digest) return { ...files, receipt: true };
    const receipt = { id: uuid(), deviceId: this.store.deviceId, epoch: role.epoch, hashes, at: now() };
    this.channel().writeJson(`receipt-${receipt.id}.ssreceipt`, receipt, `v3:receipt:${receipt.id}`);
    this.value('receiptDigest', digest);
    return { ...files, receipt: true };
  }
  readReceipts(errors) {
    const channel = this.channel(), receipts = this.value('receipts') || {};
    for (const name of channel.names('.ssreceipt')) {
      try {
        const id = name.slice(8, -10), receipt = channel.json(name, `v3:receipt:${id}`);
        check(receipt.id === id && isId(id) && isId(receipt.deviceId) && isId(receipt.epoch)
          && Number.isFinite(Date.parse(receipt.at)) && Array.isArray(receipt.hashes) && receipt.hashes.every(isHash), 'Invalid file receipt');
        check(!receipts[id] || canonical(receipts[id]) === canonical(receipt), 'Receipt collision'); receipts[id] = receipt;
      } catch (error) { errors.push({ file: name, message: error.message }); }
    }
    this.value('receipts', receipts);
  }
  async hydrate({ id }) {
    return this.exclusive(async () => {
      this.guardParticipation();
      const record = this.store.get(id); check(record?.type === 'asset', '请选择附件');
      const asset = this.knownAssets().find(asset => asset.hash === record.data.sha256);
      check(asset, '请先拉取最新文件索引');
      const file = await receiveResumable(this.channel(), this.store, asset,
        { space: this.space, reserveBytes: this.reserveBytes, paused: () => this.pauseRequested });
      for (const assetId of asset.ids) if (this.store.get(assetId)?.data.sha256 === asset.hash) this.store.bindAsset(assetId, file, this.store.assetLocation(assetId)?.pinned === 1);
      let directoryWarning = '';
      if (this.store.personalSystem) {
        const materials = new MaterialCenter(this.store, new LocalHierarchy(this.store)), ids = asset.ids.filter(assetId => this.store.get(assetId)?.data.sha256 === asset.hash);
        try {
          const preview = materials.preview({ ids });
          if (preview.rows.length && (await materials.migrate({ token: preview.token, confirmed: true, ids })).state !== 'complete') directoryWarning = '原件已下载，部分目录待整理，已保留可用接收原件';
        } catch (error) { directoryWarning = `原件已下载，目录待整理：${error.message}`; }
        this.store.local('hierarchyDirty', true);
      }
      await this.verifyPrimary(); return { available: true, directoryWarning };
    });
  }
  async evict({ id, confirmed }) {
    return this.exclusive(async () => {
      this.guardParticipation();
      this.guardEditing(); check(confirmed === true, '释放原件需要明确确认');
      const role = primaryRole(this.control()); check(role.primary && !role.conflict, '请先确定唯一主力机');
      check(role.primary !== this.store.deviceId, '主力机当前资料和回收站原件必须保留');
      const record = this.store.get(id), local = this.store.assetLocation(id);
      check(record?.type === 'asset' && local && fs.existsSync(local.path), '本机没有可释放的原件');
      check(!record.conflict && !this.store.unexported().length, '存在冲突或尚未发布的修改，不能释放');
      check(Object.values(this.value('receipts') || {}).some(receipt => receipt.deviceId === role.primary
        && receipt.epoch === role.epoch && receipt.hashes.includes(record.data.sha256)), '尚未收到当前主力机对此原件的校验回执');
      check(this.knownAssets().some(asset => asset.hash === record.data.sha256), '没有可恢复的原件索引');
      const file = path.resolve(local.path); noSymlink(file);
      const allowed = ['objects', 'received-objects'].map(folder => path.join(this.store.directory, folder, record.data.sha256));
      allowed.push(this.store.directories.assetPath(record.data.domain, record.data.sha256));
      if (isReadableAsset(this.store, file)) allowed.push(file);
      check((allowed.some(value => path.resolve(value).toLowerCase() === file.toLowerCase()) || new LocalHierarchy(this.store).managedOriginal(file))
        && outside(this.config().folder, file), '只能释放系统托管原件');
      const protectedFile = () => {
        check(!Object.values(this.store.local('localFileLinks') || {}).some(value => path.resolve(value).toLowerCase() === file.toLowerCase()), '原件仍被本机文件链接引用');
        const aliases = [...this.store.list({ type: 'asset' }), ...this.store.list({ type: 'asset', trash: true })]
          .filter(asset => this.store.assetLocation(asset.id)?.path.toLowerCase() === file.toLowerCase());
        check(!aliases.some(asset => asset.conflict || this.store.assetLocation(asset.id)?.pinned || this.store.activeAssetReads?.get(asset.id)), '原件有冲突、指定保留或正在使用的引用');
      };
      protectedFile(); check(await hashFile(file) === record.data.sha256, '原件已变化，拒绝释放');
      protectedFile(); this.guardEditing(); check(!this.store.unexported().length, '校验期间产生新修改，原件未释放');
      fs.unlinkSync(file); this.store.local('hierarchyDirty', true); return { released: true, cloudDeleted: false };
    });
  }
}
