import { check, uuid } from '../core/util.mjs';

export function exitActivity(service, activeCalls = 0) {
  if (service.agents.uploadTasks?.size) return 'Agent 文件正在接收或校验，请等待当前操作完成';
  if (service.agentOperationTask) return 'Agent 请求正在执行，请等待完成';
  if (service.transport.running) return '同步正在进行，请暂停或等待当前任务完成';
  if (service.localTask) return '本地目录正在整理，请稍后重试';
  if (service.imports.size || service.store.permanentDeleting) return '资料导入或清理正在进行，请稍后重试';
  if ([...(service.store.activeAssetReads?.values() || [])].some(count => count > 0)) return '原件正在读取，请关闭预览或等待读取完成';
  if (service.agents.starting || activeCalls > 1) return '仍有操作正在完成，请稍后重试';
  return '';
}

export class ExitCheck {
  constructor({ send, unavailable, inspect, finish, timeout = 15000 }) {
    Object.assign(this, { send, unavailable, inspect, finish, timeout });
    this.request = null;
  }
  begin(intent = 'quit') {
    check(['quit', 'storage-restart'].includes(intent), '无效的退出操作');
    if (this.request) return;
    const id = uuid();
    this.request = { id, intent, acknowledged: false };
    this.timer = setTimeout(() => {
      if (this.request?.id !== id) return;
      this.cancel(id); this.unavailable();
    }, this.timeout);
    this.timer.unref?.();
    try { this.send({ id, intent }); }
    catch { this.cancel(id); this.unavailable(); }
  }
  status(id) {
    check(this.request?.id === id, '退出请求已失效，请重新点击关闭', 'CONFLICT');
    clearTimeout(this.timer); this.request.acknowledged = true;
    return this.inspect();
  }
  cancel(id) {
    if (this.request?.id !== id) return false;
    clearTimeout(this.timer); this.request = null; return true;
  }
  accept({ id, rendererReady }) {
    check(this.request?.id === id && this.request.acknowledged && rendererReady === true, '请先完成当前退出检查', 'CONFLICT');
    check(!this.request.finishing, '正在完成退出，请稍候', 'BUSY');
    const status = this.inspect();
    check(!status.busy, status.busy, 'BUSY');
    check(!status.dirty, '仍有未保存的工作标签，请返回处理', 'UNSAVED');
    const request = this.request;
    request.finishing = true;
    try {
      const result = this.finish(request.intent);
      if (result?.then) return result.then(() => { this.cancel(id); return true; }, error => { request.finishing = false; throw error; });
      this.cancel(id); return true;
    } catch (error) { request.finishing = false; throw error; }
  }
  dispose() { if (this.request) this.cancel(this.request.id); }
}
