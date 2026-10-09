import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store.mjs';
import { FolderTransport, makePairingKey, importAttachment } from './transport.mjs';
import { BackupManager } from './backup.mjs';
import { ModelManager } from './models.mjs';
import { uuid, check, now, atomicWrite } from './util.mjs';

export class Service {
  constructor(directory, options = {}) {
    this.store = new Store(directory, options);
    this.transport = new FolderTransport(this.store);
    this.backup = new BackupManager(this.store);
    this.models = new ModelManager(this.store, options.fetcher);
    this.timer = null;
    this.idleCheck = options.idleCheck;
    for (const task of this.store.list({ type: 'task' })) {
      if (task.data.ownerDevice === this.store.deviceId && task.data.status === 'running' && !task.conflict) {
        this.store.write({ id: task.id, type: 'task', parents: task.heads, data: { ...task.data, status: 'interrupted_cost_unknown' } });
      }
    }
  }
  startTimer() {
    this.timer = setInterval(() => {
      if (this.transport.config().enabled && !this.transport.running) this.transport.cycle().catch(error => {
        this.store.local('syncLastReport', { finishedAt: now(), errors: [{ message: error.message }], cloudUploadVerified: false });
      });
      if (this.idleCheck && this.store.local('idleBackup') && this.idleCheck() >= 120 && !this.backup.running) {
        const pending = (this.store.local('backups') || []).find(item => item.deferredLarge > 0);
        if (pending) this.backup.continue(pending.directory).catch(error => this.store.local('idleBackupError', error.message));
      }
    }, 15000);
    this.timer.unref();
  }
  close() { if (this.timer) clearInterval(this.timer); this.store.close(); }
  state() {
    const tasks = this.store.list({ type: 'task' });
    return { ...this.store.summary(), sync: this.transport.config(), providers: this.models.providers(),
      backups: this.store.local('backups') || [], usage: { ...this.store.usage(),
        unsettledTasks: tasks.filter(task => ['failed_cost_unknown', 'interrupted_cost_unknown'].includes(task.data.status)).length },
      recentTasks: tasks.slice(0, 20),
      workspace: this.store.local('workspace') || { tabs: [], selectedTab: null },
      capabilities: { memoryBytes: os.totalmem(), cpus: os.cpus().length, platform: os.platform(), gpu: '请在 Ollama 中核验实际占用' },
      idleBackup: { supported: !!this.idleCheck, enabled: !!this.store.local('idleBackup'), error: this.store.local('idleBackupError') },
      version: '0.1.0', localDataDirectory: this.store.directory };
  }
  async call(method, input = {}) {
    switch (method) {
      case 'state': return this.state();
      case 'records': {
        const records = this.store.list(input);
        return input.preview ? records.map(record => ({ ...record, versions: [],
          data: { ...record.data, content: record.data.content?.slice(0, 1500), messages: record.data.messages?.slice(-1) } })) : records;
      }
      case 'record': return this.store.get(input.id);
      case 'save': {
        check(!['usage', 'task'].includes(input.type), 'Task and cost records may only be created by a model request');
        return this.store.write({ ...input, allowBranch: false });
      }
      case 'saveBranch':
        check(['note', 'draft', 'source', 'annotation'].includes(input.type), 'Only user-editable content can be saved as a branch');
        return this.store.write({ ...input, allowBranch: true });
      case 'delete': return this.store.remove(input.id, input.parents);
      case 'history': return this.store.history(input.id);
      case 'restoreVersion': return this.store.restoreVersion(input.id, input.revision, input.parents);
      case 'approve': return this.store.approve(input.id, input.itemIds, input.parents);
      case 'propose': {
        check(Array.isArray(input.items) && input.items.length > 0, 'No proposed items');
        return this.store.write({ type: 'proposal', data: { title: input.title || '待确认整理方案', domain: input.domain || '通用',
          items: input.items.map(item => ({ id: uuid(), targetId: item.targetId || uuid(), parents: item.parents || [],
            data: { title: item.title, content: item.content || '', domain: input.domain || '通用', tags: item.tags || [], sensitive: item.sensitive === true },
            status: 'pending' })) } });
      }
      case 'syncConfigure': return this.transport.configure(input.folder, input.key);
      case 'pairingKey': return { key: this.store.secret('pairing') || makePairingKey() };
      case 'sync': return this.transport.cycle();
      case 'syncPause': this.store.local('syncEnabled', !input.paused); return this.transport.config();
      case 'deviceName':
        check(typeof input.name === 'string' && input.name.trim().length > 0, 'Enter a device name');
        this.store.setMeta('deviceName', input.name.slice(0, 100)); return this.state();
      case 'assetImport': return importAttachment(this.store, input.path, input);
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
      case 'backupCreate': return this.backup.create(input.directory, input.includeLarge === true);
      case 'backupContinue': return this.backup.continue(input.directory);
      case 'backupVerify': {
        const result = await this.backup.verify(input.directory);
        return { manifest: result.manifest, valid: true };
      }
      case 'backupRestore': return this.backup.restore(input.directory);
      case 'backupIdleEnable': this.store.local('idleBackup', input.enabled === true); return this.state().idleBackup;
      case 'providerSave': return this.models.configure(input);
      case 'providerTest': return this.models.test(input.id);
      case 'models': return this.store.list({ type: 'model' }).map(model => ({ ...model, availability: this.models.availability(model.id) }));
      case 'estimate': return this.models.estimate(input);
      case 'ask': return this.models.ask(input);
      case 'workspaceSave': this.store.local('workspace', input); return input;
      case 'workspacePublish': {
        const oldId = this.store.local('workspacePublicationId');
        const old = oldId && this.store.get(oldId);
        const record = this.store.write({ id: old?.id || uuid(), type: 'workspace', parents: old?.heads || [],
          data: { title: `${this.store.getMeta('deviceName')} · 工作区`, domain: '通用',
            tabs: input.tabs || [], selectedTab: input.selectedTab, originDevice: this.store.deviceId } });
        this.store.local('workspacePublicationId', record.id); return record;
      }
      case 'workspaceAdopt': {
        const record = this.store.get(input.id);
        check(record?.type === 'workspace' && !record.conflict, 'Workspace not available');
        const current = this.store.local('workspace') || { tabs: [] };
        const known = new Set(current.tabs.map(t => t.id));
        const incoming = (record.data.tabs || []).filter(t => !known.has(t.id));
        const result = { ...current, tabs: [...current.tabs, ...incoming] };
        this.store.local('workspace', result); return result;
      }
      case 'exportMarkdown': {
        const record = this.store.get(input.id);
        check(record && ['note', 'draft', 'source'].includes(record.type), 'Choose a text note');
        return { filename: `${record.data.title.replace(/[<>:"/\\|?*]/g, '_')}.md`,
          text: `# ${record.data.title}\n\n${record.data.content || ''}\n\n---\n领域：${record.data.domain}\n标签：${record.data.tags.join(', ')}\n` };
      }
      default: throw new Error('Unsupported operation');
    }
  }
}
