import './sync-panel.css';
import { syncSendState, syncReceiveState } from './sync-model.js';

export function createSyncPanel({ api, esc, icon, formatTime, bytes, toast, confirmBox, persist, refreshIcons = () => {}, refreshPage }) {
  const $ = selector => document.querySelector(selector);
  let scan = null, integrity = null, result = null, failure = null, action = '', batch = '256', mode = 'full', channel = null, sequence = 0;
  let deviceState = {}, latestStatus = null, conflicts = 0;
  const openDetails = new Set();
  const disabled = value => value ? 'disabled' : '';
  const time = value => value ? formatTime(value) : '尚无记录';
  function sendHtml(status) {
    const state = syncSendState(status, deviceState, action), job = status.job;
    return `<div class="sync-state ${state.tone}"><span class="sync-dot"></span><strong>${state.title}</strong></div>
      <p class="sync-pending">未发布修改 <b>${status.pendingChanges} 条</b>${status.pendingControl ? ' · 设备或删除状态有更新' : ''}</p>
      ${failure && failure.text !== job?.reason && !['sync-import', 'sync-scan', 'sync-integrity'].includes(failure.action) ? `<div class="sync-result danger" role="alert">${esc(failure.text)}</div>` : ''}
      ${state.restricted ? '<p class="sync-message">本地资料保留；接收最新设备管理状态后可恢复。</p>' : ''}
      ${state.active ? `<p class="sync-meta">本次内容固定于 ${time(job.at)} · 此后的修改留待下次发布</p>` : ''}
      ${state.active ? `<progress aria-label="发布进度" max="${Math.max(1, job.totalObjects + 1)}" value="${job.completedObjects}"></progress>` : ''}
      ${job?.reason && job.state !== 'cancelled' && (state.active || !state.pending) ? `<p class="sync-message ${job.state === 'blocked' ? 'danger' : ''}">${esc(job.reason)}</p>` : ''}
      <div class="sync-actions"><button class="${state.pending || state.active ? 'primary' : 'secondary'}" data-action="sync-publish" ${disabled(!state.canPublish)}>${icon(state.active ? 'play' : 'upload')}${state.label}</button>
        ${state.canPause ? `<button class="secondary" data-action="sync-pause">${icon('pause')}暂停</button>` : ''}
        ${state.canConfirmBatch ? `<button class="secondary" data-action="sync-batch-confirm">${icon('cloud-check')}确认本批已上传</button>` : ''}
        ${state.active ? `<button class="text-button" data-action="sync-cancel" ${disabled(state.busy)}>取消本次任务</button>` : ''}</div>
      <div class="sync-upload-line"><span>${icon('cloud-upload')}百度上传</span><strong>${status.latest ? status.latest.userConfirmedAt ? '用户已确认上传' : '等待用户确认' : '待生成文件'}</strong></div>
      ${state.canConfirmUpload ? `<button class="secondary sync-confirm" data-action="sync-upload-confirm" data-release="${esc(status.latest.id)}">${icon('check')}确认本次上传完成</button>` : ''}
      <p class="sync-meta">最近生成 ${time(status.latest?.at)}${status.latest?.userConfirmedAt ? ` · 确认 ${time(status.latest.userConfirmedAt)}` : ''}</p>
      ${job ? `<details class="sync-inline-details" data-sync-detail="task"><summary>任务与空间详情</summary><dl class="sync-facts">
        <div><dt>预计新增占用</dt><dd>${bytes(job.estimatedAdditionalBytes)}</dd></div>
        <div><dt>预估时可用空间</dt><dd>${bytes(job.freeBytesAtPlan)}</dd></div>
        <div><dt>保留空间</dt><dd>${bytes(job.reserveBytes)}</dd></div>
        <div><dt>每批上限 / 预计批数</dt><dd>${bytes(job.batchBytes)} / ${job.estimatedBatches ?? '空间不足'}</dd></div>
        <div><dt>已处理交接文件</dt><dd>${job.completedObjects} / ${job.totalObjects}</dd></div></dl></details>` : ''}`;
  }
  function receiveHtml(status) {
    const state = syncReceiveState(scan), send = syncSendState(status, deviceState, action);
    const row = item => `<li class="sync-device-row"><div><strong>${esc(item.deviceName)}${item.own ? ' · 本机' : ''}</strong><small>发布于 ${time(item.at)}</small></div>
      <div class="sync-device-state"><span class="${item.imported ? 'success' : 'working'}">${item.imported ? '记录已合并' : item.own ? '本机发布' : '待接收'}</span>
        <small>${item.invalid?.length ? `${item.invalid.length} 个历史文件校验失败` : item.missing.length ? `传输目录缺 ${item.missing.length} 个文件` : item.imported ? '原件状态见下方完整性' : '传输文件齐备，接收时校验'}</small></div></li>`;
    return `<div class="sync-state ${state.issues ? 'warning' : state.pending ? 'working' : 'neutral'}"><span class="sync-dot"></span><strong>${action === 'sync-import' ? '正在校验并合并' : action === 'sync-scan' ? '正在检查同步目录' : state.title}</strong></div>
      <p class="sync-meta">${scan ? `本机检查 ${time(scan.finishedAt)}` : '只检查本机同步目录，云端下载由百度客户端完成'}</p>
      ${failure && ['sync-import', 'sync-scan'].includes(failure.action) ? `<div class="sync-result danger" role="alert">${esc(failure.text)}</div>` : result ? `<div class="sync-result" role="status">${esc(result.text)}</div>` : ''}
      ${conflicts ? `<div class="sync-conflict warning">${icon('git-merge')}<span>${conflicts} 项版本冲突，双方内容已保留</span><button class="text-button" data-action="sync-conflicts">查看冲突</button></div>` : ''}
      <ul class="sync-device-list">${state.remote.map(row).join('')}</ul>
      ${scan && !state.remote.length ? '<p class="sync-empty">其他电脑发布的清单下载到此目录后，会显示在这里。</p>' : ''}
      ${scan?.entries.some(item => item.own) ? `<details class="sync-inline-details" data-sync-detail="own"><summary>本机发布记录</summary><ul class="sync-device-list">${scan.entries.filter(item => item.own).map(row).join('')}</ul></details>` : ''}
      ${scan?.errors.length ? `<details class="sync-inline-details sync-errors" data-sync-detail="errors" open><summary>${scan.errors.length} 项文件检查异常</summary>${scan.errors.map(error => `<p>${esc(error.message)}${error.file ? `<small>${esc(error.file)}</small>` : ''}</p>`).join('')}</details>` : ''}
      ${status.receives.length ? `<div class="sync-resuming"><strong>原件接收进度</strong>${status.receives.map(item => `<div><span>${esc(item.hash.slice(0, 12))}</span><span>${bytes(item.bytes)} / ${bytes(item.size)}</span></div>`).join('')}</div>` : ''}`;
  }
  function integrityHtml() {
    if (!integrity) return '';
    return `<div class="sync-result ${integrity.invalid ? 'danger' : ''}" id="sync-integrity-result"><strong>${integrity.invalid ? `${integrity.invalid} 条记录需要检查` : '本机修改记录校验通过'}</strong>
      <p>共 ${integrity.total} 条 · 正常 ${integrity.exact} 条 · 旧版兼容通过 ${integrity.compatible} 条 · 异常 ${integrity.invalid} 条</p>
      ${integrity.compatible ? '<p>旧版空字段记录已核对原校验值，历史内容和标识保持不变。其他电脑也需要使用兼容版本。</p>' : ''}
      <small>检查时间：${time(integrity.at)}</small>${integrity.issues.filter(item => item.kind === 'invalid').map(item => `<p>${esc(item.message)}${item.id ? `<br>版本：${esc(item.id)}` : ''}</p>`).join('')}
      ${integrity.invalid && integrity.issues.length >= 100 ? '<p>详细列表最多显示 100 项。</p>' : ''}</div>`;
  }
  function replace(target, html) {
    if (target.dataset.markup === html) return;
    const focused = target.contains(document.activeElement) ? document.activeElement?.dataset.action : null;
    const expanded = new Map([...target.querySelectorAll('details[data-sync-detail]')].map(item => [item.dataset.syncDetail, item.open]));
    target.innerHTML = html; target.dataset.markup = html;
    target.querySelectorAll('details[data-sync-detail]').forEach(item => {
      if (expanded.has(item.dataset.syncDetail)) item.open = expanded.get(item.dataset.syncDetail);
      else if (openDetails.has(item.dataset.syncDetail)) item.open = true;
    });
    if (focused) target.querySelector(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
  }
  function update(status) {
    latestStatus = status;
    const state = syncSendState(status, deviceState, action);
    const host = $('#sync-current'); if (!host) return;
    replace($('#sync-task'), sendHtml(status));
    replace($('#sync-receive'), receiveHtml(status));
    replace($('#sync-integrity-slot'), integrityHtml());
    $('#sync-batch-size').disabled = state.active || state.busy || !status.config.configured;
    $('#sync-batch-size').value = state.active ? String(status.job.batchBytes / 1024 ** 2) : batch;
    $('#sync-receive-mode').disabled = state.busy || !status.config.configured;
    $('#sync-receive-mode option[value=index]').disabled = !state.canIndex;
    if (!state.canIndex) mode = 'full';
    $('#sync-receive-mode').value = mode;
    for (const name of ['sync-plan', 'sync-scan', 'sync-import', 'sync-integrity']) {
      const button = $(`[data-action="${name}"]`); if (!button) continue;
      button.disabled = state.busy || (name !== 'sync-integrity' && !status.config.configured)
        || name === 'sync-plan' && (state.active || state.restricted)
        || name === 'sync-import' && !!scan && !scan.entries.length;
    }
    const form = $('#sync-form');
    if (form) for (const field of form.querySelectorAll('input,button')) field.disabled = state.busy || state.active;
    const disconnect = $('[data-action="sync-disconnect"]');
    if (disconnect) disconnect.disabled = state.busy;
    $('#sync-config-lock').hidden = !state.active && !state.busy;
    $('#sync-mode-reason').textContent = !state.canIndex ? '当前设备角色只允许完整接收。' : mode === 'index' ? '原件保持待下载，可随后完整接收。' : '校验原件后合并；并发修改保留双方。';
    $('#sync-config-state').textContent = status.config.configured ? '已配对' : '未配置';
    const completeness = deviceState.completeness;
    $('#sync-file-completeness').textContent = completeness ? `${completeness.available} / ${completeness.total} 已就绪${completeness.missing ? ` · ${completeness.missing} 个缺失或待接收` : ''} · 截至 ${time(completeness.at)}` : '尚未检查';
    refreshIcons();
  }
  async function renderPanel(devices, conflictCount = 0) {
    const marker = $('#sync-settings'), status = await api('syncStatus');
    if (!marker?.isConnected) return;
    deviceState = devices; conflicts = conflictCount;
    const identity = `${status.config.folder}:${status.config.channel}`;
    if (channel !== null && channel !== identity) { scan = null; result = null; failure = null; integrity = null; }
    channel = identity;
    const host = document.createElement('div'); host.id = 'sync-current'; host.className = 'sync-workflows';
    host.innerHTML = `<section class="sync-direction" aria-labelledby="sync-send-title"><div class="sync-section-heading"><span class="sync-direction-icon">${icon('upload')}</span><div><h2 id="sync-send-title">发送本机更新</h2><p>本机 → 同步目录 → 其他电脑</p></div></div>
      <div id="sync-task"></div><details class="sync-inline-details" data-sync-detail="options"><summary>发布选项</summary>
      <div class="sync-options"><label for="sync-batch-size">每批生成上限</label><select id="sync-batch-size"><option value="256">自动规划 · 上限 256 MB</option><option value="64">64 MB</option><option value="16">16 MB</option></select>
      <button class="secondary" data-action="sync-plan">${icon('calculator')}预估并准备发布</button></div></details></section>
      <section class="sync-direction" aria-labelledby="sync-receive-title"><div class="sync-section-heading"><span class="sync-direction-icon receive">${icon('download')}</span><div><h2 id="sync-receive-title">接收其他电脑更新</h2><p>同步目录 → 校验与合并 → 本机</p></div></div>
      <div class="sync-receive-controls"><label for="sync-receive-mode">接收内容</label><select id="sync-receive-mode"><option value="full">完整内容与原件</option><option value="index">仅笔记与索引（非主力机）</option></select>
      <button class="primary" data-action="sync-import">${icon('download')}接收最新内容</button></div><p id="sync-mode-reason" class="sync-meta"></p><div id="sync-receive"></div></section>`;
    marker.before(host);
    $('#sync-batch-size').onchange = event => { batch = event.target.value; };
    $('#sync-receive-mode').onchange = event => { mode = event.target.value; update(latestStatus); };
    host.addEventListener('toggle', event => {
      const key = event.target.dataset.syncDetail;
      if (key) { if (event.target.open) openDetails.add(key); else openDetails.delete(key); }
    }, { capture: true });
    host.querySelectorAll('details[data-sync-detail]').forEach(item => { item.open = openDetails.has(item.dataset.syncDetail); });
    update(status);
  }
  async function refreshProgress() {
    const host = $('#sync-current'), request = ++sequence; if (!host) return;
    const status = await api('syncStatus');
    if (host.isConnected && request === sequence) update(status);
  }
  async function operation(method, input = {}) {
    await persist();
    return api(method, input);
  }
  async function scanDownloaded() { scan = await api('syncScan'); return scan; }
  const handlers = {
    'sync-disconnect': async () => {
      const host = $('#sync-current'), preview = await api('syncDisconnectPreview');
      if (!host?.isConnected) return;
      const detail = `<p>解除后，本机停止通过当前目录发送和接收更新，配对密钥及目录配置会从本机移除。</p>
        <p>本机笔记、修改历史、已下载原件和共享目录中的文件保留。尚未下载的原件需重新配对后才能接收。</p>
        <p>其他电脑不会被停用，已有设备角色记录保留。百度客户端的目录同步不会随之停止，请在百度客户端单独处理。</p>
        ${preview.pendingChanges || preview.pendingControl ? `<p>本机仍有待发送的更新${preview.pendingChanges ? `（${preview.pendingChanges} 条修改记录）` : ''}，解除后会继续保留在本机。</p>` : ''}
        ${preview.unconfirmed ? '<p>最近发布尚未确认上传；解除绑定不会确认或撤回已生成的文件。</p>' : ''}
        ${preview.cancelTask ? '<p>当前未完成的发布任务将一并取消；已生成的文件和原件接收断点保留。</p>' : ''}
        ${preview.primary ? '<p class="warning">本机仍被记录为主力机。其他电脑继续使用时，建议先完成主力机转移；本次解除不会自动转移角色。</p>' : ''}
        ${preview.roleConflict || preview.transferPending ? '<p class="warning">设备角色存在冲突或待完成的转移；解除绑定不会解决或撤销这些状态。</p>' : ''}`;
      if (!await confirmBox('解除本机同步绑定', detail, '解除绑定')) return;
      await api('syncDisconnect', { confirmed: true, token: preview.token });
      scan = null; integrity = null; result = null; failure = null; channel = null; sequence++;
      if (host.isConnected) await refreshPage();
      toast('本机同步绑定已解除，笔记和原件保留');
    },
    'sync-plan': async () => {
      const value = await operation('syncPlan', { batchBytes: Number(batch) * 1024 ** 2 });
      if (value.job && $('#sync-current')) openDetails.add('task');
      toast(value.unchanged ? '当前内容已生成，无需新建任务' : '空间预估已生成，本次待发布内容已固定');
    },
    'sync-publish': async () => {
      const value = await operation('syncPublish', { batchBytes: Number(batch) * 1024 ** 2 });
      toast(value.unchanged ? '当前内容已生成，无需重复发布' : value.job?.reason || '发布已完成');
    },
    'sync-cancel': async () => {
      if (await confirmBox('取消发布任务', '<p>当前笔记和已生成的交接文件保留。下次发布会重新计算当前内容。</p>', '取消任务')) await api('syncCancel');
    },
    'sync-batch-confirm': async () => {
      if (await confirmBox('确认本批上传', '<p>请确认百度客户端已上传本批生成的文件。需要释放中转空间时，请在百度客户端使用“仅释放本地”。此操作只记录你的确认。</p>', '本批已上传')) await api('syncConfirmBatch', { confirmed: true });
    },
    'sync-upload-confirm': async target => {
      const id = target.dataset.release;
      if (await confirmBox('确认上传完成', '<p>请确认百度客户端已上传本次最新清单及所需原件。系统记录你的确认，无法直接核验云端上传。</p>', '已上传')) await api('syncConfirmUpload', { id, confirmed: true });
    },
    'sync-scan': async () => {
      const value = await scanDownloaded();
      deviceState = await api('deviceStatus');
      toast(`发现 ${value.entries.filter(item => !item.own).length} 份其他电脑的最新内容清单`);
    },
    'sync-import': async () => {
      const metadataOnly = mode === 'index';
      if (!await confirmBox(metadataOnly ? '仅接收笔记与索引' : '接收最新内容', metadataOnly
        ? '<p>仅非主力机可用。合并笔记与修改记录，原件保持待下载。</p>'
        : '<p>将校验本机同步目录中已下载的原件，合并所有知识库及修改记录。并发修改保留双方。</p>', '校验并合并')) return;
      const value = await operation('syncImport', { metadataOnly });
      const text = value.managementOnly ? value.receiptWarning : `${value.imported ? `已合并 ${value.imported} 条修改记录` : '修改记录没有新增'}${metadataOnly ? ' · 原件保持待下载' : ' · 本次原件校验完成'}${value.receiptWarning ? `；${value.receiptWarning}` : ''}`;
      result = { text, error: false };
      try {
        deviceState = await api('deviceStatus');
        conflicts = (await api('state')).conflicts;
        await scanDownloaded(); toast(text);
      } catch (error) {
        failure = { text: `内容已接收；后续状态检查未完成：${error.message}`, action: 'sync-scan' };
        toast(failure.text, true);
      }
    },
    'sync-integrity': async () => { integrity = await api('syncIntegrity'); }
  };
  const actions = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async target => {
    if (action) return;
    action = name; failure = null;
    if (latestStatus) update(latestStatus);
    void refreshProgress().catch(() => {});
    try { await handler(target); }
    catch (error) { failure = { text: error.message, action: name }; throw error; }
    finally { action = ''; await refreshProgress(); }
  }]));
  actions['sync-pause'] = async () => { await api('syncPause'); await refreshProgress(); toast('已请求暂停，等待当前分块完成'); };
  return { renderPanel, refreshProgress, actions, scanDownloaded };
}
