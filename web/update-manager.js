import './update-manager.css';
import { fengzaiyUpdateSource } from '../package.json';
import { sourceLabel } from '../src/desktop/update-source.mjs';

const phases = { preview: '浏览器开发预览', development: '桌面开发模式', unconfigured: '尚未配置更新来源',
  'configuration-error': '更新来源配置有误', idle: '尚未检查', checking: '正在检查更新', available: '发现新版本',
  current: '本次检查未发现更新', downloading: '正在下载更新', pausing: '正在暂停下载', paused: '下载已暂停', restarting: '正在重新下载',
  downloaded: '更新已下载', installing: '正在启动安装程序', error: '更新未完成' };

export function createUpdateUI({ api, native, esc, icon, bytes, formatTime, redrawIcons, toast, prepareInstall }) {
  let host, status, notified, saving = false, pending = new Set();
  const disabled = () => !native || !status?.supported || !status.source || status.phase === 'configuration-error';
  function refreshNotice() {
    if (!status) return;
    const nav = document.querySelector('[data-nav=settings]');
    if (nav) { nav.classList.toggle('has-update', ['available', 'downloaded'].includes(status.phase)); nav.title = ['available', 'downloaded'].includes(status.phase) ? `FengZaiY ${status.latestVersion} 可更新` : '系统设置'; }
  }
  function receive(next) {
    status = next;
    refreshNotice();
    if (native && ['available', 'downloaded'].includes(next.phase) && notified !== `${next.phase}:${next.latestVersion}`) {
      notified = `${next.phase}:${next.latestVersion}`;
      toast(`${next.phase === 'downloaded' ? '更新已下载' : '发现新版本'} ${next.latestVersion}，可在系统设置中操作`);
    }
    draw();
  }
  function draw() {
    if (!host?.isConnected || !status) return;
    const busy = ['checking', 'downloading', 'pausing', 'restarting', 'installing'].includes(status.phase);
    const retry = status.phase === 'error' && status.failedOperation === 'download';
    const progressVisible = ['downloading', 'pausing', 'paused', 'restarting'].includes(status.phase) || retry;
    host.innerHTML = `<div class="update-heading"><h2>升级更新</h2><span class="pill">v${esc(status.currentVersion)}</span></div>
      <div class="update-state" role="status"><strong>${esc(phases[status.phase] || '状态未知')}</strong>${status.latestVersion && status.phase !== 'current' ? `<span>v${esc(status.latestVersion)}</span>` : ''}</div>
      <dl class="update-details"><div><dt>更新来源</dt><dd>${esc(status.source || '尚未配置')}</dd></div><div><dt>最近成功检查</dt><dd>${formatTime(status.checkedAt)}</dd></div></dl>
      ${['preview', 'development'].includes(status.phase) ? '<p class="update-note">当前为开发环境。在线下载安装仅在已安装的 Windows 桌面版中可用。</p>' : ''}
      ${status.phase === 'unconfigured' ? '<p class="update-note">此安装包尚未配置在线发布地址。</p>' : ''}
      ${status.error ? `<p class="notice danger" role="alert">${esc(status.error)}</p>` : ''}
      ${progressVisible ? `<div class="update-progress"><progress aria-label="更新下载进度" max="100" value="${status.progress?.percent || 0}"></progress><span>${Math.round(status.progress?.percent || 0)}% · ${bytes(status.progress?.transferred || 0)} / ${status.progress?.total ? bytes(status.progress.total) : '大小待确认'}</span></div>` : ''}
      <div class="update-actions"><button class="secondary" data-update="check" ${disabled() || busy || status.phase === 'downloaded' ? 'disabled' : ''}>${icon('refresh-cw')}${status.phase === 'error' ? '重新检查' : '检查更新'}</button>
        ${status.phase === 'available' ? `<button class="primary" data-update="download">${icon('download')}下载更新</button>` : ''}
        ${status.phase === 'downloading' ? `<button class="secondary" data-update="pause">${icon('pause')}暂停下载</button>` : ''}
        ${status.phase === 'paused' || retry ? `<button class="primary" data-update="resume">${icon('play')}继续下载</button>` : ''}
        ${['downloading', 'paused'].includes(status.phase) || retry ? `<button class="secondary" data-update="restart">${icon('rotate-ccw')}重新下载</button>` : ''}
        ${status.phase === 'downloaded' ? `<button class="primary" data-update="install">${icon('rotate-cw')}重启并更新</button><button class="secondary" data-update="later">稍后更新</button>` : ''}</div>
      <label class="check-row"><input id="update-auto-check" type="checkbox" ${status.autoCheck ? 'checked' : ''} ${disabled() || saving || busy ? 'disabled' : ''}>启动后检查更新</label>
      ${status.releaseNotes ? `<details class="update-notes" open><summary>更新说明${status.releaseDate ? ` · ${formatTime(status.releaseDate)}` : ''}</summary><pre>${esc(status.releaseNotes)}</pre></details>` : ''}`;
    host.querySelectorAll('[data-update]').forEach(button => {
      if (pending.has(button.dataset.update)) button.disabled = true;
      button.onclick = () => void action(button.dataset.update);
    });
    host.querySelector('#update-auto-check').onchange = async event => {
      saving = true;
      const autoCheck = event.target.checked;
      draw();
      try { receive(await api('updateConfigure', { autoCheck })); } catch (error) { toast(error.message, true); }
      finally { saving = false; draw(); }
    };
    redrawIcons();
  }
  async function action(name) {
    if (name === 'later') { toast('已保留下载，普通退出不会自动安装'); return; }
    if (pending.has(name)) return;
    pending.add(name); draw();
    let release;
    try {
      if (name === 'install') release = await prepareInstall();
      const result = await api(({ check: 'updateCheck', download: 'updateDownload', pause: 'updatePause', resume: 'updateResume',
        restart: 'updateRestartDownload', install: 'updateInstall' })[name], name === 'install' ? { rendererReady: true } : {});
      // Download RPC can settle after a newer pause/restart notification.
      if (['download', 'pause', 'resume', 'restart'].includes(name)) receive(await api('updateStatus'));
      else receive(result);
    } catch (error) { toast(error.message, true); }
    finally { pending.delete(name); release?.(); draw(); }
  }
  return {
    refreshNotice,
    async start() {
      if (!native) return;
      window.desktop.onUpdateStatus?.(receive);
      try { receive(await api('updateStatus')); } catch (error) { toast(`读取更新状态失败：${error.message}`, true); }
    },
    async mount(element, version) {
      host = element;
      if (!native) receive({ phase: 'preview', currentVersion: version, supported: false, autoCheck: false, source: sourceLabel(fengzaiyUpdateSource) });
      else {
        try { receive(await api('updateStatus')); }
        catch (error) { host.textContent = `读取更新状态失败：${error.message}`; }
      }
    }
  };
}
