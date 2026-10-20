import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.mjs';
import { makePairingKey, importAttachment } from './transport.mjs';
import { CurrentSync } from './current-sync.mjs';
import { AgentAccess } from './agent-access.mjs';
import { uuid, check, now, atomicWrite } from './util.mjs';
import { workspaceLock } from './workspace-lock.mjs';
import { LocalHierarchy } from './local-hierarchy.mjs';
import { AssetManagement } from './asset-management.mjs';
import { previewTrash, emptyTrash } from './trash.mjs';
import { previewAssetMerge, mergeAssets } from './asset-merge.mjs';
import { archiveDraft, draftWorkflows } from './draft-workflow.mjs';

const sharedTab = tab => Object.fromEntries(['id', 'recordId', 'title', 'domain', 'scroll']
  .filter(key => Object.hasOwn(tab, key)).map(key => [key, tab[key]]));

export class Service {
  constructor(directory, options = {}) {
    this.releaseLock = workspaceLock(directory);
    this.storage = options.storage;
    try {
      this.store = new Store(directory, options);
      this.transport = new CurrentSync(this.store);
      this.store.migrateNoteHierarchy();
      this.agents = new AgentAccess(this.store);
      this.localHierarchy = new LocalHierarchy(this.store);
      this.materials = new AssetManagement(this.store);
      this.store.local('hierarchyEnabled', true);
      this.store.local('hierarchyDirty', true);
      this.timer = null;
      this.imports = new Set();
      this.idleCheck = options.idleCheck;
      for (const task of this.store.list({ type: 'task' })) {
        if (task.data.ownerDevice === this.store.deviceId && task.data.status === 'running' && !task.conflict) {
          this.store.write({ id: task.id, type: 'task', parents: task.heads, data: { ...task.data, status: 'interrupted_cost_unknown' } });
        }
      }
    } catch (error) { this.store?.close(); this.releaseLock(); throw error; }
  }
  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const status = this.localHierarchy.status();
      if (!this.closed && !this.imports.size && status.enabled && status.pending && !status.busy && !this.transport.running && !status.errors?.length) {
        this.organizeLocal({ verify: false });
      }
    }, 2500);
    this.timer.unref?.();
  }
  organizeLocal({ verify = true } = {}) {
    check(!this.transport.running && !this.localTask && !this.imports.size, '请等待当前同步、导入或目录整理完成');
    this.localTask = this.localHierarchy.refresh({ enable: true, verify }).finally(() => { this.localTask = null; });
    return this.localTask;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.agents.close();
    const finish = () => { this.store.close(); this.releaseLock(); };
    if (this.localTask || this.imports.size) return Promise.allSettled([this.localTask, ...this.imports]).finally(finish);
    finish();
  }
  state() {
    const legacy = [...this.store.list({ type: 'folder' }), ...this.store.list({ type: 'folder', trash: true })];
    const summary = this.store.summary();
    const workflows = draftWorkflows(this.store);
    summary.counts.draft = this.store.list({ type: 'draft' }).filter(record => workflows.get(record.id)?.status !== 'processed').length;
    summary.conflicts -= legacy.filter(item => item.conflict).length;
    summary.trash -= legacy.filter(item => item.deleted).length;
    return { ...summary, libraries: this.store.directories.describe(this.store.libraries()), sync: this.transport.config(),
      workspace: this.store.local('workspace') || { tabs: [], selectedTab: null },
      version: '0.1.1', localDataDirectory: this.store.directory, localHierarchy: this.localHierarchy.status() };
  }
  async call(method, input = {}) {
    if (['syncPlan', 'syncPublish', 'syncImport', 'deviceSetPrimary', 'deviceVerify', 'assetHydrate', 'assetEvict'].includes(method)) {
      if (this.imports.size) await Promise.allSettled([...this.imports]);
      if (this.localTask) await this.localTask;
    }
    switch (method) {
      case 'storageStatus': return this.storage?.status() || { directory: this.store.directory, unavailable: true };
      case 'storageInspect':
      case 'storageSchedule':
      case 'storageCancel':
        check(this.storage, '请重新启动应用以启用本地存储设置');
        return this.storage[({ storageInspect: 'inspect', storageSchedule: 'schedule', storageCancel: 'cancel' })[method]](input);
      case 'state': return this.state();
      case 'agentStatus': return this.agents.status();
      case 'agentConfigure': return this.agents.configure(input.enabled === true);
      case 'agentGrant': return this.agents.createGrant(input);
      case 'agentRevoke': return this.agents.revoke(input.id);
      case 'agentPreferencesSave': return this.agents.savePreferences(input);
      case 'agentSkill': return this.agents.skillPackage();
      case 'agentSkillExport': return this.agents.exportSkill();
      case 'librarySave': return this.store.saveLibrary(input);
      case 'noteTree': return this.store.noteTree(input.domain).map(({ data, versions, ...node }) =>
        ({ ...node, data: { title: data.title, domain: data.domain, parentNoteId: data.parentNoteId, noteOrder: data.noteOrder } }));
      case 'noteMove': return this.store.moveNote(input);
      case 'folders': return this.store.folders(input.domain);
      case 'folderSave': {
        const record = this.store.saveFolder(input);
        this.store.local('hierarchyEnabled', true);
        return record;
      }
      case 'recordMove': return this.store.moveRecord(input);
      case 'localHierarchyStatus': return this.localHierarchy.status();
      case 'localHierarchyRefresh': return this.organizeLocal();
      case 'libraryDirectory': {
        const record = this.store.libraries().find(item => item.id === input.id);
        check(record, '知识库不存在');
        return { directory: this.store.directories.ensure(record) };
      }
      case 'records': {
        let records = this.store.list({ ...input, limit: undefined }).filter(record => !['model', 'provider', 'usage', 'task', 'agentPreferences', 'folder'].includes(record.type));
        if (input.type === 'draft') {
          const workflows = draftWorkflows(this.store);
          records = records.map(record => ({ ...record, processing: workflows.get(record.id) }));
          if (input.processing && input.processing !== 'all') records = records.filter(record => input.processing === 'active'
            ? record.processing.status !== 'processed' : record.processing.status === input.processing);
        }
        if (input.limit) records = records.slice(0, input.limit);
        return input.preview ? records.map(record => ({ ...record, versions: [],
          data: { ...record.data, content: record.data.content?.slice(0, 1500), messages: record.data.messages?.slice(-1) } })) : records;
      }
      case 'record': return this.store.get(input.id);
      case 'draftArchive': return archiveDraft(this.store, input);
      case 'draftWorkflow': return draftWorkflows(this.store).get(input.id) || null;
      case 'save': {
        check(['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'workspace'].includes(input.type), '该类型不允许直接修改；内置聊天与模型管理已移除');
        if (input.notePlacement) {
          check(input.type === 'note', '只有正式笔记可以排序');
          return this.store.moveNote({ ...input, parentNoteId: input.data.parentNoteId || null });
        }
        return this.store.write({ ...input, allowBranch: false });
      }
      case 'saveBranch':
        check(['note', 'draft', 'source', 'annotation'].includes(input.type), 'Only user-editable content can be saved as a branch');
        return this.store.write({ ...input, allowBranch: true });
      case 'delete': return this.store.remove(input.id, input.parents);
      case 'trashPreview': return previewTrash(this.store, input);
      case 'trashEmpty':
        check(!this.transport.running && !this.localTask, '请等待同步或本地资料整理完成', 'BUSY');
        return emptyTrash(this.store, input);
      case 'history': return this.store.history(input.id);
      case 'restoreVersion': return this.store.restoreVersion(input.id, input.revision, input.parents);
      case 'approve': return this.store.approve(input.id, input.itemIds, input.parents);
      case 'propose': {
        check(Array.isArray(input.items) && input.items.length > 0, 'No proposed items');
        return this.store.write({ type: 'proposal', data: { title: input.title || '待确认整理方案', domain: input.domain || '通用',
          ...(input.folderId ? { folderId: input.folderId } : {}),
          items: input.items.map(item => ({ id: uuid(), targetId: item.targetId || uuid(), parents: item.parents || [],
            ...(item.draftRefs !== undefined ? { draftRefs: item.draftRefs } : {}),
            data: { title: item.title, content: item.content || '', domain: input.domain || '通用', tags: item.tags || [],
              ...(item.format !== undefined ? { format: item.format } : {}),
              ...(item.folderId || input.folderId ? { folderId: item.folderId || input.folderId } : {}),
              ...(item.parentNoteId !== undefined || input.parentNoteId !== undefined ? { parentNoteId: item.parentNoteId ?? input.parentNoteId ?? null } : {}),
              sourceIds: item.sourceIds || [], assetIds: item.assetIds || [], sensitive: item.sensitive === true },
            status: 'pending' })) } });
      }
      case 'syncConfigure': return this.transport.configure(input.folder, input.key);
      case 'pairingKey': return { key: this.store.secret('pairing') || makePairingKey() };
      case 'sync':
      case 'syncScan': return this.transport.scan();
      case 'syncStatus': return this.transport.status();
      case 'syncPlan': return this.transport.plan(input);
      case 'syncPublish': return this.transport.publish(input);
      case 'syncImport': {
        const result = await this.transport.importLatest(input);
        this.store.migrateNoteHierarchy();
        return result;
      }
      case 'syncCancel': return this.transport.cancel();
      case 'syncConfirmBatch': return this.transport.confirmBatch(input);
      case 'syncConfirmUpload': return this.transport.confirmUpload(input);
      case 'deviceStatus': return this.transport.devices();
      case 'deviceSetPrimary': return this.transport.setPrimary(input);
      case 'deviceVerify': return this.transport.exclusive(() => this.transport.verifyPrimary());
      case 'assetHydrate': return this.transport.hydrate(input);
      case 'assetEvict': return this.transport.evict(input);
      case 'syncPause': return this.transport.pause();
      case 'deviceName':
        check(typeof input.name === 'string' && input.name.trim().length > 0, 'Enter a device name');
        check(!this.transport.running, '请等待同步操作完成');
        this.store.setMeta('deviceName', input.name.slice(0, 100)); this.transport.announce(); return this.state();
      case 'assetImport': {
        check(!this.transport.running, '请等待当前同步完成后导入');
        const task = (async () => {
          if (this.localTask) await this.localTask;
          return importAttachment(this.store, input.path, input);
        })();
        this.imports.add(task);
        try { return await task; } finally { this.imports.delete(task); }
      }
      case 'assetDuplicates': {
        const record = this.store.get(input.id);
        check(record?.type === 'asset' && !record.deleted, '资料不存在或已回收');
        return this.materials.rows().filter(row => row.data.domain === record.data.domain
          && row.data.sha256 === record.data.sha256 && row.data.size === record.data.size);
      }
      case 'assetMergePreview': return previewAssetMerge(this.store, input);
      case 'assetMerge': {
        check(!this.imports.size && !this.transport.running && !this.localTask, '请等待导入、同步或目录整理完成');
        const task = mergeAssets(this.store, input);
        this.imports.add(task);
        try { return await task; } finally { this.imports.delete(task); }
      }
      case 'assetCatalog': return this.materials.catalog(input);
      case 'assetDetail': return this.materials.detail(input.id);
      case 'assetUpdate': return this.materials.update(input);
      case 'assetBatch': return this.materials.batch(input);
      case 'assets': return this.store.list({ type: 'asset' }).map(record => {
        const local = this.store.assetLocation(record.id);
        return { ...record, available: !!local && fs.existsSync(local.path), pinned: local?.pinned === 1 };
      });
      case 'assetPin': {
        const local = this.store.assetLocation(input.id);
        check(local, 'Download and associate this attachment first');
        this.store.bindAsset(input.id, local.path, !!input.pinned);
        return { pinned: !!input.pinned };
      }
      case 'assetContent': {
        const asset = this.store.get(input.id), local = this.store.assetLocation(input.id);
        check(asset?.type === 'asset' && local && fs.existsSync(local.path), 'Attachment is not available on this computer');
        check(asset.data.size <= 24 * 1024 * 1024, 'This attachment is too large for an inline preview');
        return { mime: asset.data.mime, data: fs.readFileSync(local.path).toString('base64'), filename: asset.data.filename };
      }
      case 'workspaceSave': {
        const workspace = { ...this.store.local('workspace'), ...input };
        this.store.local('workspace', workspace); return workspace;
      }
      case 'workspacePublish': {
        const oldId = this.store.local('workspacePublicationId');
        const old = oldId && this.store.get(oldId);
        const record = this.store.write({ id: old?.id || uuid(), type: 'workspace', parents: old?.heads || [],
          data: { title: `${this.store.getMeta('deviceName')} · 工作区`, domain: '通用',
            tabs: (input.tabs || []).map(sharedTab), selectedTab: input.selectedTab, originDevice: this.store.deviceId } });
        this.store.local('workspacePublicationId', record.id); return record;
      }
      case 'workspaceAdopt': {
        const record = this.store.get(input.id);
        check(record?.type === 'workspace' && !record.conflict, 'Workspace not available');
        const current = this.store.local('workspace') || { tabs: [] };
        const known = new Set(current.tabs.map(t => t.id));
        const incoming = (record.data.tabs || []).filter(t => !known.has(t.id)).map(sharedTab);
        const result = { ...current, tabs: [...current.tabs, ...incoming] };
        this.store.local('workspace', result); return result;
      }
      case 'exportMarkdown': {
        const record = this.store.get(input.id);
        check(record && ['note', 'draft', 'source'].includes(record.type), 'Choose a text note');
        return { filename: `${record.data.title.replace(/[<>:"/\\|?*]/g, '_')}.md`,
          text: `# ${record.data.title}\n\n${record.data.content || ''}\n\n---\n知识库：${this.store.libraries().find(item => item.data.domain === record.data.domain)?.data.title || record.data.domain}\n标签：${record.data.tags.join(', ')}\n` };
      }
      default: throw new Error('Unsupported operation');
    }
  }
}
