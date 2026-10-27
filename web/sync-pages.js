import './device-manager.css';
import { createSyncPanel } from './sync-panel.js';

export function createSyncUI({ api, esc, icon, formatTime, bytes, render, toast, confirmBox, inputBox, persist, refreshIcons }) {
  const $ = selector => document.querySelector(selector);
  const panel = createSyncPanel({ api, esc, icon, formatTime, bytes, toast, confirmBox, persist, refreshIcons, refreshPage: render });
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
    'device-rename': target => manage(target, 'rename'),
    'device-suspend': target => manage(target, 'suspend'),
    'device-resume': target => manage(target, 'resume'),
    'device-transfer': target => manage(target, 'transfer'),
    'device-transfer-cancel': () => manage(null, 'cancel-transfer'),
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
  return { ...panel, renderDevices, actions: { ...actions, ...panel.actions } };
}
