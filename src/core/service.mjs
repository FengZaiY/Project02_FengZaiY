import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.mjs';
import { makePairingKey, importAttachment } from './transport.mjs';
import { CurrentSync } from './current-sync.mjs';
import { AgentAccess } from './agent-access.mjs';
import { uuid, check, now, atomicWrite } from './util.mjs';
import { workspaceLock } from './workspace-lock.mjs';

const sharedTab = tab => Object.fromEntries(['id', 'recordId', 'title', 'domain', 'scroll']
  .filter(key => Object.hasOwn(tab, key)).map(key => [key, tab[key]]));

export class Service {
  constructor(directory, options = {}) {
    this.releaseLock = workspaceLock(directory);
    this.storage = options.storage;
    try {
      this.store = new Store(directory, options);
      this.transport = new CurrentSync(this.store);
      this.agents = new AgentAccess(this.store);
      this.timer = null;
      this.idleCheck = options.idleCheck;
      for (const task of this.store.list({ type: 'task' })) {
        if (task.data.ownerDevice === this.store.deviceId && task.data.status === 'running' && !task.conflict) {
          this.store.write({ id: task.id, type: 'task', parents: task.heads, data: { ...task.data, status: 'interrupted_cost_unknown' } });
        }
      }
    } catch (error) { this.store?.close(); this.releaseLock(); throw error; }
  }
  startTimer() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.agents.close(); this.store.close(); this.releaseLock();
  }
  state() {
    return { ...this.store.summary(), libraries: this.store.directories.describe(this.store.libraries()), sync: this.transport.config(),
      workspace: this.store.local('workspace') || { tabs: [], selectedTab: null },
      version: '0.1.1', localDataDirectory: this.store.directory };
  }
  async call(method, input = {}) {
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
      case 'agentSkill': return { files: this.agents.skillFiles(), preferences: this.agents.preferences() };
      case 'librarySave': return this.store.saveLibrary(input);
      case 'libraryDirectory': {
        const record = this.store.libraries().find(item => item.id === input.id);
        check(record, '知识库不存在');
        return { directory: this.store.directories.ensure(record) };
      }
      case 'records': {
        const records = this.store.list(input).filter(record => !['model', 'provider', 'usage', 'task', 'agentPreferences'].includes(record.type));
        return input.preview ? records.map(record => ({ ...record, versions: [],
          data: { ...record.data, content: record.data.content?.slice(0, 1500), messages: record.data.messages?.slice(-1) } })) : records;
      }
      case 'record': return this.store.get(input.id);
      case 'save': {
        check(['note', 'draft', 'source', 'annotation', 'relation', 'proposal', 'workspace'].includes(input.type), '该类型不允许直接修改；内置聊天与模型管理已移除');
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
            data: { title: item.title, content: item.content || '', domain: input.domain || '通用', tags: item.tags || [],
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
      case 'syncImport': return this.transport.importLatest(input);
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
