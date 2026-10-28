import fs from 'node:fs';
import path from 'node:path';
import { Store, validateEvent } from './store.mjs';
import { migrateRetiredAI, cleanRetiredTabs, retiredAI } from './retired-ai.mjs';
import { makePairingKey, importAttachment } from './transport.mjs';
import { CurrentSync } from './current-sync.mjs';
import { AgentAccess } from './agent-access.mjs';
import { AgentOperations } from './agent-operations.mjs';
import { SkillInstallations } from './skill-installations.mjs';
import { uuid, check, now, atomicWrite } from './util.mjs';
import { workspaceLock } from './workspace-lock.mjs';
import { LocalHierarchy } from './local-hierarchy.mjs';
import { AssetManagement } from './asset-management.mjs';
import { previewTrash, emptyTrash } from './trash.mjs';
import { deletionStatus, runDeletionFiles } from './permanent-files.mjs';
import { cleanErasedTransport } from './erasure-sync.mjs';
import { cleanPrevious, previewPrevious } from './old-workspace-cleanup.mjs';
import { cleanEmptyDirectories, previewEmptyDirectories } from './empty-library-directories.mjs';
import { previewAssetMerge, mergeAssets } from './asset-merge.mjs';
import { archiveDraft, draftWorkflows, cleanupProposal } from './draft-workflow.mjs';
import { receivedObjectsStatus } from './received-objects.mjs';
import { readAssetContent } from './asset-reader.mjs';
import { withoutPresentation } from './retired-presentation.mjs';
import { PersonalManager } from './personal-manager.mjs';
import { PasswordVault } from './password-vault.mjs';
import { ChangeHistory } from './change-history.mjs';
import { MaterialCenter } from './material-center.mjs';
import { SECRET_TYPES } from './personal-schema.mjs';
import { UI_PROTOCOL } from './ui-protocol.mjs';
import { proposedMaterials } from './material-organization.mjs';
import { applyLayout, layoutPreview, scheduleLayout, relocateInternalFiles } from './workspace-layout.mjs';

const sharedTab = tab => Object.fromEntries(['id', 'recordId', 'title', 'domain', 'scroll']
  .filter(key => Object.hasOwn(tab, key)).map(key => [key, tab[key]]));
const cleanWorkspace = (store, value) => withoutPresentation('workspace', cleanRetiredTabs(value,
  new Set(store.erasures().filter(item => retiredAI(item.type)).map(item => item.entityId))));

export class Service {
  constructor(directory, options = {}) {
    this.releaseLock = workspaceLock(directory);
    this.storage = options.storage;
    try {
      applyLayout(directory);
      this.store = new Store(directory, options);
      if (options.initializeInternal) {
        const preview = layoutPreview(this.store);
        if (preview.state === 'legacy') {
          scheduleLayout(this.store, { token: preview.token, confirmed: true });
          this.store.close(); this.store = null;
          applyLayout(directory); this.store = new Store(directory, options);
        }
      }
      this.transport = new CurrentSync(this.store);
      this.store.migrateNoteHierarchy();
      this.agents = new AgentAccess(this.store);
      this.skillInstallations = new SkillInstallations(this.store, this.agents);
      this.localHierarchy = new LocalHierarchy(this.store);
      this.materials = new AssetManagement(this.store);
      this.store.personalSystem = true;
      this.personal = new PersonalManager(this.store);
      this.passwordVault = new PasswordVault(this.store);
      this.changes = new ChangeHistory(this.store, this.passwordVault);
      this.materialCenter = new MaterialCenter(this.store, this.localHierarchy);
      this.agentOperations = new AgentOperations(this);
      this.agents.operations = this.agentOperations;
      this.agentOperationTasks = new Set();
      this.store.local('hierarchyEnabled', true);
      this.store.local('hierarchyDirty', true);
      this.timer = null;
      this.imports = new Set();
      this.idleCheck = options.idleCheck;
      this.store.retiredAI = true;
      const cleanupNeeded = migrateRetiredAI(this.store, validateEvent);
      this.store.importEvents([]);
      this.readyPending = true;
      this.ready = (cleanupNeeded || this.store.local('presentationRetirement')?.pending ? this.finishDeletion() : Promise.resolve())
        .then(() => relocateInternalFiles(this.store)).finally(() => { this.readyPending = false; });
    } catch (error) { this.store?.close(); this.releaseLock(); throw error; }
  }
  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.closed && !this.store.permanentDeleting && !this.imports.size && !this.transport.running && !this.storage?.status().pending) {
        try { this.skillInstallations.tick(); } catch { /* Per-installation errors are retained for the settings page. */ }
      }
      const status = this.localHierarchy.status();
      if (!this.closed && !this.store.permanentDeleting && !this.imports.size && !this.localTask && !this.agents.uploadTasks?.size && status.enabled && status.pending && !status.busy && !this.transport.running && !status.errors?.length) {
        this.organizeLocal({ verify: false }).catch(error => this.store.local('hierarchyReport', { ...status, errors: [{ message: error.message }] }));
      }
    }, 2500);
    this.timer.unref?.();
  }
  organizeLocal({ verify = true } = {}) {
    check(!this.transport.running && !this.localTask && !this.imports.size, '请等待当前同步、导入或目录整理完成');
    this.localTask = (async () => {
      const preview = this.materialCenter.preview({ onlyPlanned: true });
      const migration = preview.rows.length ? await this.materialCenter.migrate({ token: preview.token, confirmed: true, onlyPlanned: true }) : null;
      const report = await this.localHierarchy.refresh({ enable: true, verify });
      if (migration?.errors.length) {
        report.errors = [...report.errors, ...migration.errors]; report.pending = true;
        this.store.local('hierarchyReport', report); this.store.local('hierarchyDirty', true);
      }
      return report;
    })().finally(() => { this.localTask = null; });
    return this.localTask;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.agents.close();
    this.passwordVault.close();
    const finish = () => { this.store.close(); this.releaseLock(); };
    if (this.readyPending || this.localTask || this.imports.size || this.agentOperationTask || this.agents.uploadTasks?.size) return Promise.allSettled([this.ready, this.localTask, ...this.imports, this.agentOperationTask, ...(this.agents.uploadTasks || [])]).finally(finish);
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
      version: '0.1.15', uiProtocol: UI_PROTOCOL, localDataDirectory: this.store.directory, localHierarchy: this.localHierarchy.status(), deletion: deletionStatus(this.store),
      skillInstallations: this.skillInstallations.summary(), agentPending: this.agentOperations.list().filter(item => item.state === 'pending').length };
  }
  async finishDeletion() {
    this.store.permanentDeleting = true;
    const task = (async () => {
      await runDeletionFiles(this.store);
      const retired = this.store.local('retiredAiCleanup');
      if (retired) this.store.local('retiredAiCleanup', { ...retired, pending: deletionStatus(this.store).pending > 0
        || this.store.local('permanentDeletionDatabase')?.state !== 'done' });
      try { this.store.local('permanentDeletionTransport', cleanErasedTransport(this.transport)); }
      catch (error) { this.store.local('permanentDeletionTransport', { state: 'blocked', errors: [{ message: error.message }], cloudVerified: false }); }
      const retiredReading = this.store.local('presentationRetirement');
      if (retiredReading) this.store.local('presentationRetirement', { ...retiredReading,
        pending: this.store.local('permanentDeletionDatabase')?.state !== 'done' });
      return deletionStatus(this.store);
    })();
    this.imports.add(task);
    try { return await task; } finally { this.imports.delete(task); this.store.permanentDeleting = false; }
  }
  async call(method, input = {}) {
    await this.ready;
    if ((this.materialCenter.running || this.store.materialMigrating) && !['state', 'materialMigrationStatus', 'vaultLock', 'vaultStatus'].includes(method)) check(false, '资料迁移正在进行，请稍后操作', 'BUSY');
    check(!this.store.permanentDeleting || ['state', 'deletionStatus'].includes(method), '永久删除正在处理，请稍后操作', 'BUSY');
    if (['syncPlan', 'syncPublish', 'syncImport', 'deviceManage', 'deviceSetPrimary', 'deviceVerify', 'assetHydrate', 'assetEvict'].includes(method)) {
      if (this.imports.size) await Promise.allSettled([...this.imports]);
      if (this.localTask) await this.localTask;
    }
    switch (method) {
      case 'storageInternalPreview': return layoutPreview(this.store);
      case 'storageInternalSchedule': {
        check(!this.transport.running && !this.localTask && !this.imports.size && !this.agents.uploadTasks?.size, '请等待同步、导入与目录任务完成');
        return scheduleLayout(this.store, input);
      }
      case 'storageStatus': return this.storage?.status() || { directory: this.store.directory, unavailable: true };
      case 'storagePreviousPreview':
      case 'storagePreviousClean': {
        check(this.storage && !this.transport.running && !this.localTask && !this.imports.size, '请等待当前工作完成');
        this.store.permanentDeleting = true;
        const task = method === 'storagePreviousPreview' ? previewPrevious(this.storage) : cleanPrevious(this.storage, input);
        this.imports.add(task);
        try { return await task; } finally { this.imports.delete(task); this.store.permanentDeleting = false; }
      }
      case 'storageInspect':
      case 'storageSchedule':
      case 'storageCancel':
        check(this.storage, '请重新启动应用以启用本地存储设置');
        return this.storage[({ storageInspect: 'inspect', storageSchedule: 'schedule', storageCancel: 'cancel' })[method]](input);
      case 'state': return this.state();
      case 'personalList': return this.personal.list(input);
      case 'personalSave': return this.personal.save(input);
      case 'personalBatch': return this.personal.batch(input);
      case 'personalDelete': {
        const record = this.store.get(input.id), secrets = record?.type === 'loginAccount' ? this.store.list({ type: 'vaultSecret' }).filter(s => s.data.accountId === input.id) : [];
        if (!secrets.length) return this.personal.remove(input);
        this.passwordVault.requireUnlocked();
        check(secrets.every(s => !s.conflict), '请先处理密码并发版本');
        return this.store.change('回收账号与密码', '用户', () => {
          this.store.revertingIds = new Set([input.id, ...secrets.map(s => s.id)]);
          try { for (const secret of secrets) this.store.remove(secret.id, secret.heads); return this.personal.remove(input); }
          finally { this.store.revertingIds = null; }
        });
      }
      case 'personalRestore': {
        const record = this.store.get(input.id), secrets = record?.type === 'loginAccount' && record.deleted ? this.store.list({ type: 'vaultSecret', trash: true }).filter(s => s.data.accountId === input.id) : [];
        if (!secrets.length) return this.personal.restore(input);
        this.passwordVault.requireUnlocked(); check(secrets.every(s => !s.conflict), '请先处理密码并发版本');
        return this.store.change('恢复账号与密码', '用户', () => {
          const restored = this.personal.restore(input);
          for (const secret of secrets) { const version = this.store.history(secret.id).find(v => !v.deleted); check(version, '密码历史不存在'); this.store.restoreVersion(secret.id, version.id, secret.heads); }
          return restored;
        });
      }
      case 'personalSearch': return this.personal.search(input);
      case 'personalDraft': return this.personal.draft(input);
      case 'financeReport': return this.personal.report(input);
      case 'financeCsvPreview': return this.personal.csvPreview(input);
      case 'financeCsvImport': return this.personal.csvImport(input);
      case 'financeCsvExport': return this.personal.csvExport();
      case 'subscriptionPay': return this.personal.paySubscription(input);
      case 'changeList': return this.changes.list(input);
      case 'changeDetail': return this.changes.detail(input.id);
      case 'changeUndo': return this.changes.undo(input);
      case 'vaultStatus': return this.passwordVault.status();
      case 'vaultSetup': return this.passwordVault.setup(input);
      case 'vaultResolveSetup': return this.passwordVault.resolveSetup(input);
      case 'vaultSetupConfirm': return this.passwordVault.confirmSetup(input);
      case 'vaultUnlock': return this.passwordVault.unlock(input);
      case 'vaultLock': return this.passwordVault.lock();
      case 'vaultResetMaster': return this.passwordVault.resetMaster(input);
      case 'vaultRead': return this.passwordVault.read(input);
      case 'vaultSave': return this.passwordVault.save(input);
      case 'vaultHistory': return this.passwordVault.history(input);
      case 'vaultDraft': return this.passwordVault.draft(input);
      case 'vaultGenerate': return this.passwordVault.generate(input);
      case 'materialUpdate': return this.materialCenter.update(input);
      case 'materialTree': return this.materialCenter.tree();
      case 'materialProposalPreview': return this.materialCenter.proposalPreview(input.id);
      case 'materialCleanupPreview':
      case 'materialCleanup': {
        check(!this.transport.running && !this.localTask && !this.imports.size && !this.agents.uploadTasks?.size, '请等待同步、导入或目录整理完成', 'BUSY');
        this.store.materialMigrating = true;
        const task = method === 'materialCleanup' ? this.materialCenter.cleanup(input) : this.materialCenter.cleanupPreview(); this.imports.add(task);
        try { return await task; } finally { this.imports.delete(task); this.store.materialMigrating = false; }
      }
      case 'materialPropose': return this.store.change('提交资料整理方案', '用户', () => this.store.write({ type: 'proposal', data: {
        title: input.title || '资料整理方案', domain: '__materials__', content: input.content || '', items: [], materialItems: proposedMaterials(this.store, input.materialItems)
      } }));
      case 'materialMigrationPreview': return this.materialCenter.preview();
      case 'materialMigrationStatus': return this.store.local('materialMigration');
      case 'materialMigrate': {
        check(!this.transport.running && !this.localTask && !this.imports.size && !this.agents.uploadTasks?.size, '请等待同步或文件整理完成', 'BUSY');
        const task = this.materialCenter.migrate(input); this.imports.add(task);
        try { const result = await task; await this.localHierarchy.refresh({ enable: true }); return result; } finally { this.imports.delete(task); }
      }
      case 'agentStatus': return this.agents.status();
      case 'agentOperationList': return this.agentOperations.list();
      case 'agentOperationDetail': return this.agentOperations.review(input.id);
      case 'agentOperationDecide': {
        const task = this.agentOperations.decide(input); this.agentOperationTasks.add(task);
        this.agentOperationTask = Promise.allSettled([...this.agentOperationTasks]);
        try { return await task; } finally {
          this.agentOperationTasks.delete(task);
          this.agentOperationTask = this.agentOperationTasks.size ? Promise.allSettled([...this.agentOperationTasks]) : null;
        }
      }
      case 'agentOperationFinishLocal': return this.agentOperations.finishLocal(input);
      case 'agentConfigure': return this.agents.configure(input.enabled === true);
      case 'agentGrant': return this.agents.createGrant(input);
      case 'agentRevoke': return this.agents.revoke(input.id);
      case 'agentPreferencesSave': return this.agents.savePreferences(input);
      case 'agentSkill': return this.agents.skillPackage();
      case 'agentSkillExport': return this.agents.exportSkill();
      case 'skillInstallList': return this.skillInstallations.list();
      case 'skillInstallCheck': return this.skillInstallations.check();
      case 'skillInstallPreview': return this.skillInstallations.preview(input);
      case 'skillInstallConfirm': return this.skillInstallations.confirm(input);
      case 'skillInstallConfigure': return this.skillInstallations.configure(input);
      case 'skillInstallUnlink': return this.skillInstallations.unlink(input);
      case 'librarySave': return this.store.change('保存知识库', '用户', () => this.store.saveLibrary(input));
      case 'noteTree': return this.store.noteTree(input.domain).map(({ data, versions, ...node }) =>
        ({ ...node, data: { title: data.title, domain: data.domain, parentNoteId: data.parentNoteId, noteOrder: data.noteOrder } }));
      case 'noteMove': return this.store.change('移动笔记', '用户', () => this.store.moveNote(input));
      case 'folders': return this.store.folders(input.domain);
      case 'folderSave': {
        const record = this.store.change('保存旧版目录', '用户', () => this.store.saveFolder(input));
        this.store.local('hierarchyEnabled', true);
        return record;
      }
      case 'recordMove': return this.store.change('移动内容', '用户', () => this.store.moveRecord(input));
      case 'localHierarchyStatus': return this.localHierarchy.status();
      case 'receivedObjectsStatus': return { ...receivedObjectsStatus(this.store, input),
        busy: !!(this.transport.running || this.localTask || this.imports.size),
        cleanup: this.localHierarchy.status().receivedDirectory || this.store.local('receivedDirectoryCleanup') };
      case 'localHierarchyRefresh': return this.organizeLocal();
      case 'libraryDirectory': {
        const record = this.store.libraries().find(item => item.id === input.id);
        check(record, '知识库不存在');
        return { directory: this.store.directories.ensure(record) };
      }
      case 'records': {
        let records = this.store.list({ ...input, limit: undefined }).filter(record => !['model', 'provider', 'usage', 'task', 'agentPreferences', 'folder', 'changeBatch', ...SECRET_TYPES].includes(record.type));
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
      case 'record': { const record = this.store.get(input.id); check(!SECRET_TYPES.includes(record?.type), '请使用独立密码库入口'); return record; }
      case 'draftArchive': return this.store.change('草稿归档', '用户', () => archiveDraft(this.store, input));
      case 'proposalCleanup': return this.store.change('清理已确认方案', '用户', () => cleanupProposal(this.store, input));
      case 'draftWorkflow': return draftWorkflows(this.store).get(input.id) || null;
      case 'save': {
        check(['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'workspace'].includes(input.type), '该类型不允许直接修改；内置聊天与模型管理已移除');
        if (input.notePlacement) {
          check(input.type === 'note', '只有正式笔记可以排序');
          return this.store.change('保存笔记位置', '用户', () => this.store.moveNote({ ...input, parentNoteId: input.data.parentNoteId || null }));
        }
        return this.store.change('保存内容', '用户', () => this.store.write({ ...input, allowBranch: false }));
      }
      case 'saveBranch':
        check(['note', 'draft', 'source', 'annotation'].includes(input.type), 'Only user-editable content can be saved as a branch');
        return this.store.change('保存并发分支', '用户', () => this.store.write({ ...input, allowBranch: true }));
      case 'delete':
        check(![...SECRET_TYPES, 'changeBatch'].includes(this.store.get(input.id)?.type), '请使用专用入口');
        return this.store.change('移入回收站', '用户', () => this.store.remove(input.id, input.parents));
      case 'trashPreview': return previewTrash(this.store, input);
      case 'trashEmpty': {
        check(!this.transport.running && !this.localTask && !this.imports.size, '请等待同步或本地资料整理完成', 'BUSY');
        const result = emptyTrash(this.store, input);
        return { ...result, cleanup: await this.finishDeletion() };
      }
      case 'deletionStatus': return deletionStatus(this.store);
      case 'emptyDirectoriesPreview':
      case 'emptyDirectoriesClean':
        check(!this.transport.running && !this.localTask && !this.imports.size, '请等待同步或本地资料整理完成', 'BUSY');
        return method === 'emptyDirectoriesPreview' ? previewEmptyDirectories(this.store) : cleanEmptyDirectories(this.store, input);
      case 'deletionRetry':
        check(!this.transport.running && !this.localTask && !this.imports.size, '请等待同步或本地资料整理完成', 'BUSY');
        return this.finishDeletion();
      case 'history': check(!SECRET_TYPES.includes(this.store.get(input.id)?.type), '请解锁密码库查看历史'); return this.store.history(input.id);
      case 'restoreVersion': check(![...SECRET_TYPES, 'changeBatch'].includes(this.store.get(input.id)?.type), '请使用专用入口'); return this.store.change('恢复修改版本', '用户', () => this.store.restoreVersion(input.id, input.revision, input.parents));
      case 'approve': return this.store.change('确认整理方案', '用户', () => this.store.approve(input.id, input.itemIds, input.parents));
      case 'propose': {
        check(Array.isArray(input.items) && input.items.length > 0, 'No proposed items');
        return this.store.change('提交整理方案', '用户', () => this.store.write({ type: 'proposal', data: { title: input.title || '待确认整理方案', domain: input.domain || '通用',
          ...(input.folderId ? { folderId: input.folderId } : {}),
          items: input.items.map(item => ({ id: uuid(), targetId: item.targetId || uuid(), parents: item.parents || [],
            ...(item.draftRefs !== undefined ? { draftRefs: item.draftRefs } : {}),
            data: { title: item.title, content: item.content || '', domain: input.domain || '通用', tags: item.tags || [],
              ...(item.format !== undefined ? { format: item.format } : {}),
              ...(item.folderId || input.folderId ? { folderId: item.folderId || input.folderId } : {}),
              ...(item.parentNoteId !== undefined || input.parentNoteId !== undefined ? { parentNoteId: item.parentNoteId ?? input.parentNoteId ?? null } : {}),
              sourceIds: item.sourceIds || [], assetIds: item.assetIds || [], sensitive: item.sensitive === true },
            status: 'pending' })) } }));
      }
      case 'syncConfigure': return this.transport.configure(input.folder, input.key);
      case 'syncDisconnectPreview':
      case 'syncDisconnect':
        check(!this.localTask && !this.imports.size, '请等待导入或目录整理完成后解除绑定', 'BUSY');
        return method === 'syncDisconnectPreview' ? this.transport.disconnectPreview() : this.transport.disconnect(input);
      case 'pairingKey': return { key: this.store.secret('pairing') || makePairingKey() };
      case 'sync':
      case 'syncScan': return this.transport.scan();
      case 'syncStatus': return this.transport.status();
      case 'syncIntegrity': return this.store.revisionIntegrity();
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
      case 'deviceManage': return this.transport.manageDevice(input);
      case 'deviceSetPrimary': return this.transport.setPrimary(input);
      case 'deviceVerify': return this.transport.exclusive(() => this.transport.verifyPrimary());
      case 'assetHydrate': return this.transport.hydrate(input);
      case 'assetEvict': return this.transport.evict(input);
      case 'syncPause': return this.transport.pause();
      case 'deviceName': {
        check(typeof input.name === 'string' && input.name.trim().length > 0, 'Enter a device name');
        check(!this.transport.running, '请等待同步操作完成');
        const status = this.transport.devices();
        if (status.primary || status.conflict) {
          check(status.canManage, '设备名称由当前唯一主力机统一管理', 'FORBIDDEN');
          await this.transport.manageDevice({ deviceId: this.store.deviceId, action: 'rename', name: input.name.trim(),
            revision: status.revision, requestId: uuid(), confirmed: true });
          return this.state();
        }
        this.store.setMeta('deviceName', input.name.slice(0, 100)); this.transport.announce(); return this.state();
      }
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
      case 'assetUpdate': return this.store.change('修改资料', '用户', () => this.materials.update(input));
      case 'assetBatch': return this.store.change('批量修改资料', '用户', () => this.materials.batch(input));
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
      case 'assetContent': return readAssetContent(this.store, input.id);
      case 'workspaceSave': {
        const workspace = cleanWorkspace(this.store, { ...this.store.local('workspace'), ...input });
        this.store.local('workspace', workspace); return workspace;
      }
      case 'workspacePublish': {
        const oldId = this.store.local('workspacePublicationId');
        const old = oldId && this.store.get(oldId);
        const record = this.store.write({ id: old?.id || uuid(), type: 'workspace', parents: old?.heads || [],
          data: { title: `${this.store.getMeta('deviceName')} · 工作区`, domain: '通用',
            tabs: (cleanWorkspace(this.store, input).tabs || []).map(sharedTab), selectedTab: input.selectedTab, originDevice: this.store.deviceId } });
        this.store.local('workspacePublicationId', record.id); return record;
      }
      case 'workspaceAdopt': {
        const record = this.store.get(input.id);
        check(record?.type === 'workspace' && !record.conflict, 'Workspace not available');
        const current = this.store.local('workspace') || { tabs: [] };
        const known = new Set(current.tabs.map(t => t.id));
        const incoming = (cleanWorkspace(this.store, record.data).tabs || []).filter(t => !known.has(t.id)).map(sharedTab);
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
