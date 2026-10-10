export function createSyncUI({ api, esc, icon, formatTime, bytes, render, toast, confirmBox, persist }) {
  const $ = selector => document.querySelector(selector);
  let scan = null;
  function progressHtml(status) {
    const job = status.job, active = job && !['complete', 'cancelled'].includes(job.state);
    const names = { ready: '等待发布', running: '正在生成', paused: '已暂停', blocked: '等待处理', complete: '已生成', cancelled: '已取消' };
    return `<div class="definition-list"><div><span>未发布修改</span><strong>${status.pendingChanges} 条${status.pendingControl ? ' · 设备设置有更新' : ''}</strong></div>
      <div><span>当前任务</span><strong>${status.busy ? '正在处理' : job ? names[job.state] : '尚无任务'}</strong></div>
      ${job ? `<div><span>预计新增占用</span><strong>${bytes(job.estimatedAdditionalBytes)}</strong></div>
      <div><span>预估时可用空间</span><strong>${bytes(job.freeBytesAtPlan)} · 保留 ${bytes(job.reserveBytes)}</strong></div>
      <div><span>批次上限 / 预计批数</span><strong>${bytes(job.batchBytes)} / ${job.estimatedBatches ?? '空间不足'}</strong></div>
      <div><span>交接对象进度</span><strong>${job.completedObjects} / ${job.totalObjects}</strong></div>` : ''}</div>
      ${job ? `<progress aria-label="发布进度" max="${Math.max(1, job.totalObjects)}" value="${job.completedObjects}" style="width:100%"></progress><p class="muted">${esc(job.reason)}</p>` : ''}
      <div class="version-controls"><button class="primary" data-action="sync-publish" ${status.busy || !status.config.configured ? 'disabled' : ''}>${icon(active ? 'play' : 'upload')}${active ? '继续发布' : '发布当前内容'}</button>
      <button class="secondary" data-action="sync-pause" ${status.busy || active ? '' : 'disabled'}>${icon('pause')}暂停</button>
      ${active ? `<button class="secondary" data-action="sync-batch-confirm" ${status.busy || !job.completedObjects ? 'disabled' : ''}>${icon('cloud-check')}本批已上传</button>
      <button class="text-button" data-action="sync-cancel" ${status.busy ? 'disabled' : ''}>取消任务</button>` : ''}</div>
      ${status.latest ? `<p>最近发布：${formatTime(status.latest.at)} · ${status.latest.userConfirmedAt ? '用户已确认上传' : '等待客户端上传'}</p>
      ${!status.latest.userConfirmedAt ? `<button class="secondary" data-action="sync-upload-confirm" data-release="${esc(status.latest.id)}">${icon('check')}确认本次上传完成</button>` : ''}` : ''}
      ${status.receives.length ? `<h3>接收进度</h3>${status.receives.map(item => `<div class="definition-list"><div><code>${esc(item.hash.slice(0, 12))}</code><span>${bytes(item.bytes)} / ${bytes(item.size)}</span></div></div>`).join('')}` : ''}`;
  }
  async function renderPanel() {
    const status = await api('syncStatus');
    const host = document.createElement('section'); host.className = 'settings-section'; host.id = 'sync-current';
    host.innerHTML = `<h2>全部知识库与资料</h2><div class="version-controls">
      <label>每批生成上限 <select id="sync-batch-size" aria-label="每批生成上限"><option value="256">自动规划 · 上限 256 MB</option><option value="64">64 MB</option><option value="16">16 MB</option></select></label>
      <button class="secondary" data-action="sync-plan">${icon('calculator')}空间预估</button></div>
      <div id="sync-task">${progressHtml(status)}</div><h2>已下载的最新内容</h2>
      <div class="version-controls"><button class="secondary" data-action="sync-scan">${icon('search')}检查已下载更新</button>
      <button class="primary" data-action="sync-import">${icon('download')}拉取最新内容</button>
      <button class="text-button" data-action="sync-import-index">仅笔记与索引</button></div>
      ${scan ? `<p class="muted">本机检查时间：${formatTime(scan.finishedAt)}</p>${scan.entries.map(item => `<div class="workspace-option"><div><strong>${esc(item.deviceName)}${item.own ? ' · 本机' : ''}</strong><small>${formatTime(item.at)} · ${item.imported ? '已接收' : '待接收'} · ${item.missing.length ? `${item.missing.length} 个对象未下载` : '待校验'}</small></div></div>`).join('') || '<div class="section-empty">尚未发现最新内容清单</div>'}
      ${scan.errors.map(error => `<div class="notice danger">${esc(error.message)}</div>`).join('')}` : '<div class="section-empty">尚未检查</div>'}`;
    $('#main').insertBefore(host, $('#sync-content-policy'));
  }
  async function refreshProgress() {
    const target = $('#sync-task'); if (!target) return;
    const status = await api('syncStatus');
    if (target.isConnected) target.innerHTML = progressHtml(status);
  }
  async function operation(method, input = {}) {
    await persist();
    const task = api(method, input).then(value => ({ value }), error => ({ error }));
    await render();
    try {
      const result = await task;
      if (result.error) throw result.error;
      return result.value;
    } finally { await render(); }
  }
  async function renderDevices() {
    const status = await api('deviceStatus');
    $('#main').className = 'settings-view';
    $('#main').innerHTML = `<div class="page-heading"><h1>设备管理</h1><button class="secondary" data-action="device-verify">${icon('shield-check')}校验本机原件</button></div>
      <div class="notice ${status.conflict ? 'danger' : 'amber'}">${status.conflict ? '主力角色存在冲突，空间释放已暂停。' : status.primary ? '主力机保留原件，笔记冲突仍需对照处理。' : '尚未设置主力机，原件释放不可用。'}</div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>设备</th><th>角色</th><th>最近接收</th></tr></thead><tbody>${status.devices.map(item => `<tr><td>${esc(item.name)}${item.local ? ' · 本机' : ''}</td><td>${item.primary ? '主力机' : '其他设备'}</td><td>${item.lastReceivedAt ? formatTime(item.lastReceivedAt) : '暂无记录'}</td></tr>`).join('')}</tbody></table></div>
      <section class="settings-section"><h2>本机完整性</h2><div class="definition-list"><div><span>最近校验</span><strong>${status.completeness ? `${status.completeness.available} / ${status.completeness.total} 个原件 · ${formatTime(status.completeness.at)}` : '尚未校验'}</strong></div><div><span>范围</span><strong>截至本机已接收内容</strong></div></div>
      <button class="secondary" data-action="device-primary">${icon('monitor-check')}设本机为主力机 / 处理角色冲突</button></section>`;
  }
  const actions = {
    'sync-plan': async () => {
      const batchBytes = Number($('#sync-batch-size')?.value || 256) * 1024 ** 2;
      await operation('syncPlan', { batchBytes }); toast('空间预估已生成');
    },
    'sync-publish': async () => {
      const batchBytes = Number($('#sync-batch-size')?.value || 256) * 1024 ** 2;
      const result = await operation('syncPublish', { batchBytes });
      scan = await api('syncScan'); await render();
      toast(result.unchanged ? '没有需要发布的新修改' : result.job?.reason || '发布已完成');
    },
    'sync-pause': async () => { await api('syncPause'); await refreshProgress(); toast('已请求暂停，等待当前分块完成'); },
    'sync-cancel': async () => {
      if (!await confirmBox('取消发布任务', '<p>当前笔记和已生成的交接文件保留。下次发布会重新计算当前内容。</p>', '取消任务')) return;
      await api('syncCancel'); await render();
    },
    'sync-batch-confirm': async () => {
      if (!await confirmBox('确认本批上传', '<p>请确认百度客户端已上传本批生成的文件。需要释放中转空间时，请在百度客户端使用“仅释放本地”。</p>', '本批已上传')) return;
      await api('syncConfirmBatch', { confirmed: true }); await render();
    },
    'sync-upload-confirm': async target => {
      if (!await confirmBox('确认上传完成', '<p>请确认百度客户端已上传最新清单及所需原件。</p>', '已上传')) return;
      await api('syncConfirmUpload', { id: target.dataset.release, confirmed: true }); await render();
    },
    'sync-scan': async () => { scan = await api('syncScan'); await render(); toast(`发现 ${scan.entries.length} 份最新内容清单`); },
    'sync-import': async () => {
      if (!await confirmBox('拉取最新内容', '<p>将校验已下载资料，合并所有知识库及修改记录。并发修改保留双方。</p>', '校验并合并')) return;
      const result = await operation('syncImport'); scan = await api('syncScan'); await render();
      toast(result.receiptWarning || `已接收 ${result.imported} 条修改记录`);
    },
    'sync-import-index': async () => {
      if (!await confirmBox('仅接收笔记与索引', '<p>仅非主力机可用。原件保留待下载状态。</p>', '接收索引')) return;
      await operation('syncImport', { metadataOnly: true }); scan = await api('syncScan'); await render();
    },
    'device-verify': async () => {
      const result = await operation('deviceVerify'); toast(`${result.available.length} / ${result.total} 个原件校验通过`);
    },
    'device-primary': async () => {
      const status = await api('deviceStatus');
      if (!await confirmBox('设置本机为主力机', '<p>请先拉取最新内容。接管以本机已知资料为范围，系统会校验原件是否齐全。</p>', '校验并接管')) return;
      await operation('deviceSetPrimary', { deviceId: status.devices.find(item => item.local).deviceId,
        parents: status.heads.map(item => item.id), confirmed: true });
    },
    'asset-hydrate': async target => { await operation('assetHydrate', { id: target.dataset.asset }); toast('原件已校验并恢复'); },
    'asset-evict': async target => {
      if (!await confirmBox('释放本机原件', '<p>保留笔记、索引与云端文件。需已有当前主力机的校验回执，且原件未在使用或指定保留。</p>', '校验并释放')) return;
      await operation('assetEvict', { id: target.dataset.asset }); toast('本机原件已释放');
    }
  };
  return { renderPanel, renderDevices, refreshProgress, actions, scanDownloaded: async () => { scan = await api('syncScan'); return scan; } };
}
