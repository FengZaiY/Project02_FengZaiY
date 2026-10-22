import './device-manager.css';

export function createSyncUI({ api, esc, icon, formatTime, bytes, render, toast, confirmBox, inputBox, persist }) {
  const $ = selector => document.querySelector(selector);
  let scan = null, integrity = null;
  function integrityHtml() {
    if (!integrity) return '';
    return `<div class="notice ${integrity.invalid ? 'danger' : ''}" id="sync-integrity-result"><div>
      <strong>${integrity.invalid ? `${integrity.invalid} 条记录需要检查` : '本机修改记录校验通过'}</strong>
      <p>共 ${integrity.total} 条 · 正常 ${integrity.exact} 条 · 旧版兼容通过 ${integrity.compatible} 条 · 异常 ${integrity.invalid} 条</p>
      ${integrity.compatible ? '<p>旧版空字段记录已核对原校验值，历史内容和标识保持不变。其他电脑也需要更新到包含此修复的版本。</p>' : ''}
      <small>检查时间：${formatTime(integrity.at)}</small>
      ${integrity.issues.filter(item => item.kind === 'invalid').map(item => `<p class="storage-path">${esc(item.message)}${item.id ? `<br>版本：${esc(item.id)}` : ''}</p>`).join('')}
      ${integrity.invalid && integrity.issues.length >= 100 ? '<p>详细列表最多显示 100 项。</p>' : ''}</div></div>`;
  }
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
      <div id="sync-task">${progressHtml(status)}</div>
      <div class="version-controls"><button class="secondary" data-action="sync-integrity">${icon('shield-check')}检查本机修改记录</button></div>${integrityHtml()}
      <h2>已下载的最新内容</h2>
      <div class="version-controls"><button class="secondary" data-action="sync-scan">${icon('search')}检查已下载更新</button>
      <button class="primary" data-action="sync-import">${icon('download')}拉取最新内容</button>
      <button class="text-button" data-action="sync-import-index">仅笔记与索引</button></div>
      ${scan ? `<p class="muted">本机检查时间：${formatTime(scan.finishedAt)}</p>${scan.entries.map(item => `<div class="workspace-option"><div><strong>${esc(item.deviceName)}${item.own ? ' · 本机' : ''}</strong><small>${formatTime(item.at)} · ${item.imported ? '已接收' : '待接收'} · ${item.invalid?.length ? `${item.invalid.length} 个历史对象校验失败 · ` : ''}${item.missing.length ? `${item.missing.length} 个对象未下载` : item.invalid?.length ? '请查看错误详情' : '待校验'}</small></div></div>`).join('') || '<div class="section-empty">尚未发现最新内容清单</div>'}
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
    const local = status.devices.find(item => item.local), primary = status.devices.find(item => item.primary);
    const canAccept = !local?.suspended && !local?.statusConflict && (!status.primary && (!status.conflict || status.recoveryDevices?.includes(local?.deviceId))
      || !status.transferConflict && status.transfer?.deviceId === local?.deviceId);
    const managementButtons = item => !status.canManage ? '' : `<button class="icon-button" data-action="device-rename" data-device="${esc(item.deviceId)}" title="修改设备名称" aria-label="修改设备名称：${esc(item.name)}">${icon('pencil')}</button>
      ${!item.primary || item.suspended || item.statusConflict ? `<button class="icon-button" data-action="${item.suspended || item.statusConflict ? 'device-resume' : 'device-suspend'}" data-device="${esc(item.deviceId)}" title="${item.suspended || item.statusConflict ? '恢复设备' : '停用设备'}" aria-label="${item.suspended || item.statusConflict ? '恢复设备' : '停用设备'}：${esc(item.name)}">${icon(item.suspended || item.statusConflict ? 'play' : 'pause')}</button>` : ''}
      ${!item.primary && !item.suspended && !item.statusConflict ? `<button class="icon-button" data-action="device-transfer" data-device="${esc(item.deviceId)}" title="转移主力机" aria-label="转移主力机：${esc(item.name)}">${icon('monitor-up')}</button>` : ''}`;
    $('#main').className = 'settings-view';
    $('#main').innerHTML = `<div class="page-heading"><h1>设备管理</h1><button class="secondary" data-action="device-verify">${icon('shield-check')}校验本机原件</button></div>
      <div class="notice ${status.conflict || local?.suspended ? 'danger' : 'amber'}">${status.conflict ? '主力角色存在冲突，设备管理及空间释放已暂停。' : local?.suspended ? '本机已停用，仅接收管理状态；本地笔记和原件保留。' : status.primary ? `主力机：${esc(primary?.name || status.primary)}${status.canManage ? ' · 本机可管理设备' : ' · 由主力机管理设备'}` : '尚未设置主力机，原件释放不可用。'}</div>
      ${status.transfer || status.transferConflict ? `<div class="notice amber">${status.transferConflict ? '主力机转移请求存在冲突，等待当前主力机重新指定或取消。' : `待接管：${esc(status.devices.find(item => item.deviceId === status.transfer.deviceId)?.name || status.transfer.deviceId)} · 等待目标电脑拉取内容并校验确认`}
        ${status.canManage ? '<button class="text-button" data-action="device-transfer-cancel">取消转移</button>' : ''}</div>` : ''}
      <div class="table-scroll"><table class="data-table device-table"><thead><tr><th>设备</th><th>角色</th><th>状态</th><th>最近接收</th>${status.canManage ? '<th>操作</th>' : ''}</tr></thead><tbody>${status.devices.map(item => `<tr data-device-row="${esc(item.deviceId)}"><td><span title="${esc(item.name)}">${esc(item.name)}${item.local ? ' · 本机' : ''}</span><br><small title="${esc(item.deviceId)}">${esc(item.deviceId.slice(0, 8))}</small>${item.nameConflict ? `<div class="muted">名称冲突：${item.names.map(esc).join(' / ')}</div>` : ''}</td><td>${item.primary ? '主力机' : '其他设备'}</td><td>${item.statusConflict ? '状态冲突 · 已暂停' : item.suspended ? '已停用' : '已启用'}</td><td>${item.lastReceivedAt ? formatTime(item.lastReceivedAt) : '暂无记录'}</td>${status.canManage ? `<td><div class="device-actions">${managementButtons(item)}</div></td>` : ''}</tr>`).join('')}</tbody></table></div>
      <section class="settings-section"><h2>本机完整性</h2><div class="definition-list"><div><span>最近校验</span><strong>${status.completeness ? `${status.completeness.available} / ${status.completeness.total} 个原件 · ${formatTime(status.completeness.at)}` : '尚未校验'}</strong></div><div><span>范围</span><strong>截至本机已接收内容</strong></div></div>
      ${canAccept ? `<button class="secondary" data-action="device-primary">${icon('monitor-check')}${status.transfer ? '校验并接受主力机转移' : status.conflict ? '校验本机并处理角色冲突' : '设本机为主力机'}</button>` : ''}</section>`;
  }
  async function manage(target, action) {
    const status = await api('deviceStatus'), device = status.devices.find(item => item.deviceId === target?.dataset.device);
    if (!status.canManage) throw new Error('仅当前唯一主力机可以管理设备');
    if (!device && action !== 'cancel-transfer') throw new Error('设备已变化，请刷新');
    let name;
    if (action === 'rename') {
      name = await inputBox('修改设备名称', `设备 ${device.deviceId.slice(0, 8)}`, device.name);
      if (name === null || name === undefined) return;
      name = name.trim(); if (!name) throw new Error('设备名称不能为空');
    } else {
      const title = { suspend: '停用设备', resume: '恢复设备', transfer: '转移主力机', 'cancel-transfer': '取消主力机转移' }[action];
      const detail = { suspend: '其他电脑接收管理状态后，将停止接收此设备的发布。此设备接收停用状态后暂停同步；已有笔记和文件保留。共享密钥不会撤销，离线电脑不会立即受控。',
        resume: '设备接收恢复状态后可继续同步，离线期间的修改仍按版本规则合并。',
        transfer: '当前主力机先保持原角色。请发布管理状态，再由目标电脑拉取最新内容并校验原件，确认后接管。',
        'cancel-transfer': '取消当前尚未完成的转移请求。其他电脑接收最新管理状态后生效。' }[action];
      if (!await confirmBox(title, `<p>${device ? esc(device.name) + ' · ' + esc(device.deviceId.slice(0, 8)) : ''}</p><p>${detail}</p>`, title)) return;
    }
    await operation('deviceManage', { deviceId: device?.deviceId || status.devices.find(item => item.local).deviceId,
      action, ...(action === 'rename' ? { name } : {}), revision: status.revision, requestId: crypto.randomUUID(), confirmed: true });
    toast('设备设置已保存，发布后由其他电脑拉取生效');
  }
  const actions = {
    'sync-integrity': async () => { integrity = await api('syncIntegrity'); await render(); },
    'device-rename': target => manage(target, 'rename'),
    'device-suspend': target => manage(target, 'suspend'),
    'device-resume': target => manage(target, 'resume'),
    'device-transfer': target => manage(target, 'transfer'),
    'device-transfer-cancel': () => manage(null, 'cancel-transfer'),
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
        parents: status.heads.map(item => item.id), revision: status.revision, transferId: status.transfer?.id, confirmed: true });
    },
    'asset-hydrate': async target => { await operation('assetHydrate', { id: target.dataset.asset }); toast('原件已校验并恢复'); },
    'asset-evict': async target => {
      if (!await confirmBox('释放本机原件', '<p>保留笔记、索引与云端文件。需已有当前主力机的校验回执，且原件未在使用或指定保留。</p>', '校验并释放')) return;
      await operation('assetEvict', { id: target.dataset.asset }); toast('本机原件已释放');
    }
  };
  return { renderPanel, renderDevices, refreshProgress, actions, scanDownloaded: async () => { scan = await api('syncScan'); return scan; } };
}
