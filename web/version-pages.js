export function createVersionUI({ api, esc, icon, button, formatTime, render, toast, openModal, inputBox, confirmBox, persist, getScope }) {
  let selectedScope = null, scan = null;
  const $ = selector => document.querySelector(selector);
  const safeEditing = async () => { await persist(); };
  const scope = () => selectedScope || getScope() || '__shared__';
  async function renderVersions() {
    const status = await api('versionStatus');
    const host = document.createElement('section'); host.className = 'settings-section'; host.id = 'git-versions';
    if (!status.scopes.some(item => item.scope === scope())) selectedScope = '__shared__';
    const current = status.scopes.find(item => item.scope === scope());
    const options = status.scopes.map(item => `<option value="${esc(item.scope)}" ${item.scope === scope() ? 'selected' : ''}>${esc(item.title)}</option>`).join('');
    host.innerHTML = `<h2>知识库版本</h2>${status.error ? `<div class="notice danger">${esc(status.error)}</div>` : ''}
      <div class="version-controls"><select id="version-scope" aria-label="版本知识库">${options}</select>
      <button class="primary" data-action="version-commit">${icon('git-commit-horizontal')}保存版本</button>
      <button class="secondary" data-action="version-history">${icon('history')}版本历史</button>
      <button class="secondary" data-action="version-publish" ${!current?.commit ? 'disabled' : ''}>${icon('upload')}发布已提交版本</button></div>
      <div class="definition-list"><div><span>本地修改</span><strong>${current?.error ? esc(current.error) : current?.dirty ? '有未提交修改' : '已保存版本'}</strong></div>
      <div><span>当前提交</span><code>${esc(current?.commit?.slice(0, 12) || '尚未提交')}</code></div>
      <div><span>工作区待处理</span><strong>${status.uncommitted} 个范围未提交 · ${status.unpublished} 个范围未发布 · ${status.unconfirmed} 次上传待用户确认</strong></div></div>
      <h2>本机发布记录</h2>${status.publications.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>版本</th><th>时间</th><th>传输状态</th><th></th></tr></thead><tbody>${status.publications.slice().reverse().map(item => `<tr><td><code>${esc(item.commit.slice(0, 12))}</code><small>${esc(status.scopes.find(s => s.scope === item.scope)?.title || item.scope)}</small></td><td>${formatTime(item.at)}</td><td>${item.userConfirmedAt ? '用户已确认上传 · 云端未自动核验' : '已生成交接文件 · 等待客户端传输'}</td><td>${!item.userConfirmedAt ? button('check', 'version-upload-confirm', '确认已在客户端上传完成', `data-release="${esc(item.id)}"`) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="section-empty">尚无已发布版本</div>'}
      <h2>已下载的更新</h2><button class="secondary" data-action="version-scan">${icon('search')}检查本机已下载内容</button>
      ${scan ? `<small>检查时间：${formatTime(scan.finishedAt)} · 不是云端更新查询</small>${scan.entries.filter(item => !item.own).map(item => `<div class="workspace-option version-release"><div><strong>${esc(item.deviceName || item.deviceId)} · ${esc(item.commit.slice(0, 12))}</strong><small>${formatTime(item.at)} · ${item.imported ? item.metadataOnly ? '索引已导入，原件按需获取' : '已导入' : item.missing.length ? `${item.missing.length} 个交接文件缺失或未下载` : '文件已出现，尚未校验完整性'}</small></div><div class="inline-actions">${!item.imported ? `<button class="secondary" data-action="version-import" data-release="${esc(item.id)}">拉取合并</button><button class="text-button" data-action="version-import-index" data-release="${esc(item.id)}">仅索引</button>` : ''}</div>${item.missing.length ? `<details><summary>待下载文件</summary><pre>${item.missing.slice(0, 100).map(esc).join('\n')}</pre></details>` : ''}</div>`).join('') || '<div class="section-empty">尚未发现其他设备的发布</div>'}${scan.errors.map(error => `<div class="notice danger">${esc(error.file)}：${esc(error.message)}</div>`).join('')}` : '<div class="section-empty">请先在百度客户端检查并下载更新</div>'}`;
    $('#main').insertBefore(host, $('#sync-content-policy'));
    $('#version-scope').onchange = async event => { selectedScope = event.target.value; await render(); };
  }
  async function renderDevices() {
    const status = await api('deviceStatus');
    $('#main').className = 'settings-view';
    $('#main').innerHTML = `<div class="page-heading"><h1>设备管理</h1><button class="secondary" data-action="device-verify">${icon('shield-check')}校验本机原件</button></div>
      <div class="notice ${status.conflict ? 'danger' : 'amber'}">${status.conflict ? '主力角色存在冲突，空间释放已暂停。' : status.primary ? '主力角色不具有覆盖其他设备修改的权限。' : '尚未设置主力机，空间释放不可用。'}</div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>设备</th><th>角色</th><th>最近接收其版本</th><th>标识</th></tr></thead><tbody>${status.devices.map(item => `<tr><td>${esc(item.name)}${item.local ? ' · 本机' : ''}</td><td>${item.primary ? '主力机' : '其他设备'}</td><td>${item.lastReceivedAt ? formatTime(item.lastReceivedAt) : '暂无记录'}</td><td><code>${esc(item.deviceId.slice(0, 12))}</code></td></tr>`).join('')}</tbody></table></div><p class="muted">接收记录不代表设备实时在线。</p>
      <section class="settings-section"><h2>本机完整性</h2><div class="definition-list"><div><span>最近校验</span><strong>${status.completeness ? `${status.completeness.available} / ${status.completeness.total} 个原件 · ${formatTime(status.completeness.at)}` : '尚未校验'}</strong></div><div><span>范围</span><strong>截至本机已接收版本，不代表远端实时最新</strong></div></div>
      <button class="secondary" data-action="device-primary">${icon('monitor-check')}设本机为主力机 / 处理角色冲突</button>
      <p class="muted">角色变更后，请保存并发布“共享偏好与设备”版本。</p></section>`;
  }
  const actions = {
    'version-commit': async () => {
      await safeEditing(); const message = await inputBox('保存知识库版本', '版本说明（可留空）'); if (message === null) return;
      const result = await api('versionCommit', { scope: scope(), message }); await render(); toast(result.unchanged ? '没有新的修改' : `版本已保存 ${result.commit.slice(0, 12)}`);
    },
    'version-publish': async () => { const result = await api('syncPublish', { scope: scope() }); await render(); toast(result.unchanged ? '此版本已有交接记录' : '交接文件已生成，请在百度客户端核验上传'); },
    'version-scan': async () => { scan = await api('syncScan'); await render(); toast(`发现 ${scan.entries.length} 个本地发布清单，云端状态未核验`); },
    'version-import': async target => {
      await safeEditing();
      if (!await confirmBox('拉取并合并版本', '<p>将校验已下载内容，保留并发修改。未提交的本地修改会阻止合并。</p>', '校验并合并')) return;
      const result = await api('syncImport', { id: target.dataset.release }); scan = await api('syncScan'); await render(); toast(result.receiptWarning ? `版本已导入，回执暂未生成：${result.receiptWarning}` : '版本已导入；存在冲突时请对照处理');
    },
    'version-import-index': async target => {
      await safeEditing();
      if (!await confirmBox('仅导入索引', '<p>仅非主力机可用。笔记可读，但原文件保持待下载，不算资料完整。</p>', '导入索引')) return;
      await api('syncImport', { id: target.dataset.release, metadataOnly: true }); scan = await api('syncScan'); await render();
    },
    'version-upload-confirm': async target => {
      if (!await confirmBox('确认客户端上传', '<p>请先在百度客户端检查这次发布的所有文件均已上传。这是你的确认，不是系统自动核验。</p>', '我已检查上传完成')) return;
      await api('syncConfirmUpload', { id: target.dataset.release, confirmed: true }); await render();
    },
    'version-history': async () => {
      const currentScope = scope(), history = await api('versionHistory', { scope: currentScope });
      const dialog = openModal('Git 版本历史', history.map(item => `<section class="workspace-option"><div><strong>${esc(item.message)}</strong><small>${formatTime(item.at)} · ${esc(item.commit.slice(0, 12))}</small></div>${currentScope !== '__shared__' ? `<button class="secondary" data-restore-commit="${item.commit}">恢复</button>` : ''}</section>`).join('') || '<p>尚未保存版本</p>');
      dialog.querySelectorAll('[data-restore-commit]').forEach(element => element.onclick = async () => {
        const commit = element.dataset.restoreCommit; dialog.close();
        if (!await confirmBox('恢复知识库版本', '<p>恢复整个知识库到所选版本，并创建新提交。原历史保留；所需历史原件必须先下载。</p>', '恢复并保存版本')) return;
        try { await safeEditing(); await api('versionRestore', { scope: currentScope, commit, confirmed: true }); await render(); } catch (error) { toast(error.message, true); }
      });
    },
    'device-verify': async () => { const result = await api('deviceVerify'); await render(); toast(`${result.available.length} / ${result.total} 个原件校验通过${result.receipt ? '，主力机回执已生成' : ''}`); },
    'device-primary': async () => {
      const status = await api('deviceStatus');
      if (!await confirmBox('设置本机为主力机', '<p>请先在客户端检查并拉取最新版本。系统只能核验已知当前资料，无法证明云端没有新版本。更换主力机或原主力机丢失时，此操作属于明确接管。</p>', '已检查，校验并接管')) return;
      await api('deviceSetPrimary', { deviceId: status.devices.find(item => item.local).deviceId, parents: status.heads.map(item => item.id), confirmed: true, recovery: true }); await render();
    },
    'asset-hydrate': async target => { await api('assetHydrate', { id: target.dataset.asset }); await render(); toast('原件已校验并恢复到本机'); },
    'asset-evict': async target => {
      await safeEditing();
      if (!await confirmBox('释放本机原件', '<p>仅释放系统管理的本地原件，保留笔记和索引，不删除网盘文件。未收到主力机校验回执或被指定保留的原件会被拒绝。</p>', '校验并释放')) return;
      await api('assetEvict', { id: target.dataset.asset, confirmed: true }); await render();
    }
  };
  return { renderVersions, renderDevices, actions, scanDownloaded: async () => { scan = await api('syncScan'); return scan; } };
}
