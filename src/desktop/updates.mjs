import { updateSource, sourceLabel } from './update-source.mjs';
import { CancellationToken } from 'builder-util-runtime';
import { updateFailure } from './update-errors.mjs';

const requireState = (condition, message) => { if (!condition) throw new Error(message); };
const releaseText = notes => (Array.isArray(notes) ? notes.map(note => `${note.version || ''}\n${note.note || ''}`).join('\n\n') : String(notes || '')).slice(0, 20000);

// No Electron imports: failure, concurrency and installation gates can be tested without running an installer.
export class UpdateManager {
  constructor({ version, packaged, platform = process.platform, source, createUpdater, notify = () => {}, autoCheck = true, saveAutoCheck = () => {} }) {
    this.notify = notify;
    this.saveAutoCheck = saveAutoCheck;
    this.state = { currentVersion: version, phase: 'idle', latestVersion: '', releaseNotes: '', releaseDate: null,
      checkedAt: null, progress: null, error: '', errorCode: '', autoCheck, source: '', supported: packaged && platform === 'win32' };
    try { this.source = updateSource(source); this.state.source = sourceLabel(this.source); }
    catch (error) { this.state.error = error.message; this.state.phase = 'configuration-error'; return; }
    if (!this.state.supported) { this.state.phase = 'development'; return; }
    if (!this.source) { this.state.phase = 'unconfigured'; return; }
    try { this.updater = createUpdater(this.source); }
    catch { this.state.phase = 'configuration-error'; this.state.error = '更新组件初始化失败，请检查发布配置。知识库仍可正常使用。'; return; }
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.updater.disableWebInstaller = true;
    this.bindAvailability();
    this.updater.on('error', error => { if (!this.operation && this.state.phase === 'installing') this.fail(error); });
    this.updater.on('download-progress', progress => {
      if (this.state.phase !== 'downloading' || !this.downloadAttempt || this.downloadAttempt.token.cancelled) return;
      this.set({ progress: { percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)),
        transferred: progress.transferred || 0, total: progress.total || 0, bytesPerSecond: progress.bytesPerSecond || 0 } });
    });
    this.updater.on('update-downloaded', info => {
      if (this.state.phase === 'downloading' && this.downloadAttempt && !this.downloadAttempt.token.cancelled
        && info.version === this.state.latestVersion) this.downloadAttempt.verified = true;
    });
  }
  status() { return structuredClone(this.state); }
  set(change) { Object.assign(this.state, change, change.error === '' ? { errorCode: '' } : {}); this.notify(this.status()); return this.status(); }
  fail(error, failedOperation = '') {
    // Do not leak cache paths, request headers or raw remote responses into the renderer.
    const failure = updateFailure(error);
    return this.set({ phase: 'error', failedOperation, errorCode: failure.code, error: failure.message,
      progress: failedOperation === 'download' ? this.state.progress : null });
  }
  configure({ autoCheck }) {
    requireState(typeof autoCheck === 'boolean', '自动检查设置无效');
    this.saveAutoCheck(autoCheck);
    return this.set({ autoCheck });
  }
  async check() {
    requireState(this.updater, this.state.supported ? '尚未配置有效的在线更新来源' : '请在已安装的 Windows 桌面版中检查更新');
    requireState(!this.operation && !['downloading', 'pausing', 'restarting', 'downloaded', 'installing'].includes(this.state.phase), '更新正在处理或已下载，请先完成当前操作');
    this.operation = true;
    this.available = false;
    this.set({ phase: 'checking', error: '', failedOperation: '', latestVersion: '', releaseNotes: '', releaseDate: null, progress: null });
    try {
      const result = await this.updater.checkForUpdates();
      requireState(result?.updateInfo, '没有收到版本信息');
      const info = result.updateInfo;
      // The provider can return an older version; updater's own availability event is authoritative.
      return this.set({ phase: this.available ? 'available' : 'current', latestVersion: info.version,
        releaseNotes: releaseText(info.releaseNotes), releaseDate: info.releaseDate || null,
        checkedAt: new Date().toISOString(), error: '' });
    } catch (error) { return this.fail(error); }
    finally { this.operation = false; }
  }
  bindAvailability() {
    this.updater?.on('checking-for-update', () => { this.available = false; });
    this.updater?.on('update-available', () => { this.available = true; });
    this.updater?.on('update-not-available', () => { this.available = false; });
    return this;
  }
  async download() {
    requireState(this.updater && !this.operation && (['available', 'paused'].includes(this.state.phase)
      || this.state.phase === 'error' && this.state.failedOperation === 'download'), '请先检查并确认有新版本');
    this.operation = true;
    const attempt = { token: new CancellationToken(), verified: false };
    this.downloadAttempt = attempt;
    this.set({ phase: 'downloading', error: '', failedOperation: '',
      progress: this.state.progress || { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
    this.downloadTask = (async () => {
      try {
        await this.updater.downloadUpdate(attempt.token);
        if (attempt.token.cancelled) return this.status();
        requireState(attempt.verified, '下载尚未通过校验');
        return this.set({ phase: 'downloaded', progress: null, error: '' });
      } catch (error) { return attempt.token.cancelled ? this.status() : this.fail(error, 'download'); }
      finally {
        attempt.token.dispose(); this.downloadAttempt = null; this.operation = false;
        if (this.state.phase === 'pausing') this.set({ phase: 'paused', progress: this.state.progress && { ...this.state.progress, bytesPerSecond: 0 } });
      }
    })();
    await this.downloadTask;
    return this.status();
  }
  async pause() {
    if (this.state.phase === 'paused') return this.status();
    requireState(this.downloadAttempt && ['downloading', 'pausing'].includes(this.state.phase), '当前没有可暂停的下载');
    this.set({ phase: 'pausing', error: '' });
    this.downloadAttempt.token.cancel();
    await this.downloadTask;
    return this.status();
  }
  async restartDownload() {
    requireState(this.updater?.resetDownload && (['downloading', 'paused'].includes(this.state.phase)
      || this.state.phase === 'error' && this.state.failedOperation === 'download'), '当前没有可重新下载的更新');
    this.set({ phase: 'restarting', error: '' });
    this.downloadAttempt?.token.cancel();
    await this.downloadTask;
    this.operation = true;
    try { await this.updater.resetDownload(); }
    catch (error) { return this.fail(error, 'download'); }
    finally { this.operation = false; }
    this.set({ phase: 'available', progress: null });
    return this.download();
  }
  requireDownloaded() { requireState(this.updater && !this.operation && this.state.phase === 'downloaded', '更新尚未下载并校验完成'); }
  install() {
    this.requireDownloaded();
    this.set({ phase: 'installing', error: '' });
    try { this.updater.quitAndInstall(false, true); }
    catch (error) { this.fail(error); }
    return this.status();
  }
}

export function assertUpdateIdle(service, storage, activeCalls = 1, customStartup = false) {
  requireState(!customStartup, '当前使用自定义启动目录，请关闭后手动安装并沿用原启动入口，避免重启到其他工作区');
  requireState(!storage.status().restartRequired, '请先应用或取消待生效的存储位置变更');
  requireState(!service.transport.running && !service.localTask && !service.imports.size && !service.agentOperationTask && !service.agents.starting && activeCalls <= 1,
    '同步、导入或其他操作仍在进行，请稍后更新');
  requireState(![...(service.store.activeAssetReads?.values() || [])].some(count => count > 0), '原文件仍在读取，请关闭预览后更新');
  requireState(!(service.store.local('workspace')?.tabs || []).some(tab => tab.dirty), '请先保存或关闭未保存的笔记标签');
  requireState(!Object.values(service.store.local('personalDrafts') || {}).some(Boolean), '请先保存或放弃未提交的业务表单');
}
