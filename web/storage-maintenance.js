import { mountReceivedObjects } from './received-objects.js';
import './storage-maintenance.css';

export function deletionNeedsRetry(status = {}) {
  return !!(status.pending || status.database && status.database.state !== 'done'
    || status.transport && !['done', 'unconfigured'].includes(status.transport.state)
    || status.transport?.errors?.length || status.retiredAI?.pending);
}

export async function mountStorageMaintenance(host, { api, esc, icon, bytes, refreshIcons, autoScan = false, onScan = () => {} }) {
  const action = (name, text, glyph = 'search') => `<button class="secondary" data-action="${name}">${icon(glyph)}${text}</button>`;
  const issues = values => values.length ? `<ul class="storage-issues">${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : '';
  host.innerHTML = `<section class="settings-section"><div class="maintenance-heading"><h2>存储检查与清理</h2><button class="secondary" data-storage-scan>${icon('scan-search')}开始扫描</button></div>
    <div data-storage-results aria-live="polite"><p class="muted">尚未扫描</p></div></section>
    <details class="storage-advanced"><summary>高级维护 <span data-maintenance-status class="muted">检查中</span></summary><div data-maintenance-tools></div></details>`;
  const advanced = host.querySelector('[data-maintenance-tools]'), badge = host.querySelector('[data-maintenance-status]');
  let detecting = false, scanning = false;
  const detect = async () => {
    if (detecting || scanning) return;
    detecting = true;
    host.querySelector('[data-storage-scan]').disabled = true;
    const rows = [], errors = []; let needed = 0;
    try {
      const internal = await api('storageInternalPreview');
      if (!host.isConnected) return;
      if (internal.state === 'complete') rows.push('<p>系统内部目录已更新</p>');
      else if (internal.restartRequired) { needed++; rows.push('<p>系统内部目录迁移已安排，待正常退出并重新启动后生效。</p>'); }
      else { needed++; rows.push(`<div class="maintenance-row"><span>系统内部目录待升级</span>${action('storage-internal', '预览内部目录迁移', 'folder-cog')}</div>`); }
    } catch (error) { errors.push(`内部目录：${error.message}`); }
    if (!host.isConnected) return;
    try {
      const migration = await api('materialMigrationPreview');
      if (!host.isConnected) return;
      const pending = migration.rows.length || ['pending', 'running'].includes(migration.progress?.state);
      if (pending) { needed++; rows.push(`<div class="maintenance-row"><span>资料目录待整理 · ${migration.rows.length} 项</span>${action('material-migrate', '预览资料目录整理', 'folder-input')}</div>`); }
      else rows.push('<p>资料目录已更新</p>');
    } catch (error) { errors.push(`资料目录：${error.message}`); }
    if (!host.isConnected) return;
    badge.textContent = errors.length ? '检查未完成' : needed ? `${needed} 项待处理` : '无需处理';
    badge.className = needed || errors.length ? 'maintenance-attention' : 'muted';
    advanced.innerHTML = rows.join('') + issues(errors) + (errors.length ? '<button class="secondary" data-maintenance-recheck>重新检查</button>' : '');
    advanced.querySelector('[data-maintenance-recheck]')?.addEventListener('click', () => { void detect(); });
    detecting = false;
    host.querySelector('[data-storage-scan]').disabled = false;
    refreshIcons();
  };
  const scan = host.querySelector('[data-storage-scan]'), results = host.querySelector('[data-storage-results]');
  scan.onclick = async () => {
    if (scan.disabled || detecting || scanning) return;
    scanning = true;
    onScan();
    scan.disabled = true; results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<p role="status">正在扫描本机存储…</p>';
    const found = {}, failures = [];
    // These previews share backend maintenance locks, so run them in order.
    const read = async (key, method, label) => {
      if (!host.isConnected) return;
      try { found[key] = await api(method); } catch (error) { failures.push(`${label}：${error.message}`); }
    };
    try {
      await read('storage', 'storageStatus', '工作区');
      await read('copies', 'materialCleanupPreview', '资料旧副本');
      await read('directories', 'emptyDirectoriesPreview', '废弃空目录');
      await read('deletion', 'deletionStatus', '永久删除收尾');
      await read('hierarchy', 'localHierarchyStatus', '本地文件');
      await read('received', 'receivedObjectsStatus', '同步接收目录');
      if (found.storage?.lastChange?.mode === 'migrate' && !found.storage.lastChange.cleaned) await read('previous', 'storagePreviousPreview', '旧工作区副本');
      if (!host.isConnected) return;
      const { storage, copies, directories, deletion, hierarchy, previous, received } = found;
      if (received?.error) failures.push(`同步接收目录：${received.error}`);
      const exceptions = [...failures, ...(copies?.rows || []).filter(row => row.issue).map(row => `${row.relative}：${row.issue}`),
        ...(hierarchy?.errors || []).map(row => row.message), ...(deletion?.files || []).filter(row => row.state !== 'done').map(row => `${row.relative}：${row.reason || '待处理'}`),
        ...(deletion?.transport?.errors || []).map(row => row.message), ...(storage?.error ? [storage.error] : []),
        ...(deletion?.database?.reason ? [deletion.database.reason] : []),
        ...(received?.counts?.review ? [`接收目录有 ${received.counts.review} 项需核对，已保留`] : [])];
      results.innerHTML = `<p class="storage-path">${esc(storage?.directory || directories?.directory || '工作区路径未取得')}</p>
        <p role="status">${failures.length ? '部分扫描未完成' : '扫描完成'} · ${new Date().toLocaleTimeString('zh-CN')}</p>
        <section class="maintenance-result"><h3>可释放空间</h3><p>${copies ? `已校验资料旧副本 ${bytes(copies.bytes)}` : '资料旧副本空间未核验'}${previous ? `；旧工作区托管副本 ${bytes(previous.bytes)}（单独确认）` : ''}</p><small class="muted">不计入受保护文件、接收续传文件及尚未核验的内容。</small></section>
        <section class="maintenance-result"><h3>旧副本</h3>
          ${copies ? `<p>${copies.rows.length} 项资料旧副本${copies.rows.some(row => row.issue) ? '，部分受保护' : ''}</p>${copies.rows.some(row => !row.issue) ? action('material-cleanup', '预览清理资料旧副本', 'trash-2') : ''}` : '<p>资料旧副本检查未完成</p>'}
          ${previous ? `<p class="storage-path">旧工作区：${esc(previous.directory)}</p>${action('storage-previous-clean', '预览清理旧工作区', 'folder-search')}` : ''}
          ${deletion?.legacyCleared?.count ? `<p>旧版逻辑清空残留 ${deletion.legacyCleared.count} 项</p>${action('legacy-clear', '检查旧版残留', 'search')}` : ''}
          ${deletion?.legacyArchives?.length || deletion?.legacyBackups ? '<p>另有退役版本目录或旧备份登记，本次不自动清理。</p>' : ''}</section>
        <section class="maintenance-result"><h3>废弃空目录</h3>${directories ? `<p>可清理 ${directories.eligible.length} 项 · 保留 ${directories.blocked.length} 项</p>${action('empty-directories', '检查废弃空目录', 'folder-search')}` : '<p>检查未完成</p>'}</section>
        <section class="maintenance-result"><h3>异常与待处理</h3>${exceptions.length ? issues(exceptions) : '<p>已完成的检查中未发现异常</p>'}
          ${hierarchy?.pending || hierarchy?.errors?.length ? action('storage-retry', '重试本地文件维护', 'refresh-cw') : ''}
          ${hierarchy?.missing ? `<p>${hierarchy.missing} 个原件待接收</p>` : ''}
          ${deletion ? `<p>永久删除收尾：${deletionNeedsRetry(deletion) ? '待处理' : '无需处理'} · 已释放 ${bytes(deletion.releasedBytes)}</p>${deletionNeedsRetry(deletion) ? action('deletion-retry', '重试永久删除清理', 'refresh-cw') : ''}${deletion.transport?.state === 'done' ? '<p class="muted">传输副本本机清理已完成，百度客户端传输及云端历史状态仍需在客户端确认。</p>' : ''}` : ''}</section>
        <details class="maintenance-received"><summary>同步接收目录</summary><div class="received-objects" id="received-objects"></div></details>`;
      refreshIcons();
      const receivedHost = results.querySelector('#received-objects');
      if (received) await mountReceivedObjects(receivedHost, { api, esc, bytes, icon, refreshIcons, initialStatus: received });
      else receivedHost.textContent = '接收目录检查未完成，请重新扫描。';
    } catch (error) {
      if (host.isConnected) results.innerHTML = `<p role="alert">扫描未完成：${esc(error.message)}</p>`;
    } finally {
      scanning = false;
      if (host.isConnected) { results.removeAttribute('aria-busy'); scan.disabled = false; scan.innerHTML = `${icon('scan-search')}重新扫描`; refreshIcons(); }
    }
  };
  refreshIcons();
  await detect();
  if (autoScan && host.isConnected) await scan.onclick();
}
