import './received-objects.css';

const labels = { resume: '等待续传', reading: '正在读取', linked: '链接引用中', organize: '等待整理',
  cleanup: '等待校验清理', deletion: '等待永久删除', review: '保留待核对' };

export async function mountReceivedObjects(host, { api, esc, bytes, icon, refreshIcons, initialStatus }) {
  let offset = 0, running = false;
  const load = async () => {
    const status = initialStatus ?? await api('receivedObjectsStatus', { offset });
    initialStatus = null;
    if (!host.isConnected) return;
    if (offset && offset >= status.total) { offset = 0; return load(); }
    const needsOrganize = !!(status.error || status.counts.organize || status.counts.cleanup
      || status.cleanup?.state === 'blocked' || status.exists && !status.total && !status.pendingReceives && status.cleanup?.state !== 'protected');
    host.innerHTML = `<div class="received-heading"><h3>同步接收目录</h3><div class="heading-actions">
      <button class="secondary" data-received-refresh>${icon('refresh-cw')}检查状态</button>
      ${needsOrganize ? `<button class="secondary" data-received-organize ${status.busy ? 'disabled' : ''}>${icon('folder-check')}重试整理</button>` : ''}</div></div>
      <p class="storage-path">${esc(status.directory)}</p>
      <div class="storage-summary"><span>${status.error ? '检查未完成' : !status.exists ? '无需保留接收目录' : status.total ? `${status.total} 项 · ${bytes(status.bytes)}` : '空目录，整理时将检查并清理'}</span>
      ${status.busy ? '<span>同步或文件维护进行中</span>' : ''}
      ${Object.entries(status.counts).map(([key, count]) => `<span>${labels[key]} ${count}</span>`).join('')}</div>
      ${status.error ? `<p class="notice danger">${esc(status.error)}</p>` : ''}
      ${status.cleanup?.reason ? `<p class="muted">最近整理：${esc(status.cleanup.reason)}</p>` : ''}
      ${status.pendingReceives && !status.total ? '<p class="muted">仍有续传登记。下次拉取会检查并重新接收缺失的分块。</p>' : ''}
      <div class="received-result" role="status"></div>
      ${status.items.length ? `<ul class="received-list">${status.items.map(item => `<li><div class="received-file"><span title="${esc(item.name)}">${esc(item.name)}</span><small>${bytes(item.size)}</small></div>
        <div><strong>${labels[item.state]}</strong><p>${esc(item.reason)}</p>${item.state === 'resume' ? `<small>上次登记进度 ${bytes(item.completedBytes || 0)} / ${bytes(item.totalBytes || 0)}</small>` : ''}</div></li>`).join('')}</ul>` : ''}
      ${status.total > status.limit ? `<div class="heading-actions"><button class="icon-button" title="上一页" aria-label="上一页" data-received-prev ${offset ? '' : 'disabled'}>${icon('chevron-left')}</button>
        <span>${offset + 1}–${Math.min(offset + status.limit, status.total)} / ${status.total}</span>
        <button class="icon-button" title="下一页" aria-label="下一页" data-received-next ${offset + status.limit < status.total ? '' : 'disabled'}>${icon('chevron-right')}</button></div>` : ''}`;
    refreshIcons();
    const perform = async action => {
      if (running) return;
      running = true;
      host.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const result = await action();
        await load();
        if (host.isConnected && result?.errors?.length) host.querySelector('.received-result').textContent = result.errors.map(item => item.message).join('；');
      } catch (error) {
        if (host.isConnected) {
          host.querySelector('.received-result').textContent = error.message;
          host.querySelector('[data-received-refresh]').disabled = false;
          const organize = host.querySelector('[data-received-organize]');
          if (organize) organize.disabled = !!status.busy;
        }
      } finally { running = false; }
    };
    host.querySelector('[data-received-refresh]').onclick = () => perform(async () => {});
    const organize = host.querySelector('[data-received-organize]');
    if (organize) organize.onclick = () => perform(() => api('localHierarchyRefresh'));
    const previous = host.querySelector('[data-received-prev]'), next = host.querySelector('[data-received-next]');
    if (previous) previous.onclick = () => perform(async () => { offset = Math.max(0, offset - status.limit); });
    if (next) next.onclick = () => perform(async () => { offset += status.limit; });
  };
  try { await load(); }
  catch (error) { if (host.isConnected) host.textContent = `接收目录检查失败：${error.message}`; }
}
