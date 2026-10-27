export function createSkillInstallations({ api, esc, icon, formatTime, toast, confirmBox, redrawIcons, run, pickDirectory, dirty }) {
  let host;
  const labels = { current: '与当前一致', outdated: '有更新', incomplete: '安装文件缺失', modified: '检测到手工修改', conflict: '偏好存在冲突', error: '需要处理', 'rename-required': '需更换安装名称' };
  const clean = () => { if (dirty()) throw new Error('请先保存或撤销未保存的整理偏好'); };
  async function refresh(check = false) {
    const target = host;
    const installs = await api(check ? 'skillInstallCheck' : 'skillInstallList');
    if (!target?.isConnected || target !== host) return;
    const notice = target.closest('#skill-management')?.querySelector('#skill-install-attention');
    const count = installs.filter(item => item.status !== 'current').length;
    if (notice) notice.textContent = count ? `${count} 个安装有更新或需要处理` : '';
    target.innerHTML = `<div class="skill-install-heading"><h3>已关联安装</h3><div><button class="secondary" data-install-add>${icon('folder-open')}关联安装目录</button><button class="icon-button" data-install-check title="检查 Skill 更新" aria-label="检查 Skill 更新">${icon('refresh-cw')}</button></div></div>
      ${installs.length ? installs.map(item => `<section class="skill-install-row" data-install-id="${esc(item.id)}">
        <div class="skill-install-path"><strong>FengZaiY</strong><span class="pill">${labels[item.status] || '待检查'}</span><p>${esc(item.directory)}</p>
        <small>${item.updatedAt ? `最近写入 ${formatTime(item.updatedAt)}` : '尚未更新安装文件'}${item.checkedAt ? ` · 最近检查 ${formatTime(item.checkedAt)}` : ''}</small>
        ${item.version ? `<small title="${esc(item.version)}">文件版本 ${esc(item.version.slice(0, 12))}</small>` : ''}
        ${item.missingFiles?.length ? `<p class="skill-install-warning">缺少文件：${item.missingFiles.map(esc).join('、')}</p>` : ''}
        ${item.changedFiles.filter(name => !item.missingFiles?.includes(name)).length ? `<p class="skill-install-warning">修改的文件：${item.changedFiles.filter(name => !item.missingFiles?.includes(name)).map(esc).join('、')}</p>` : ''}
        ${item.error ? `<p class="skill-install-warning" role="status">${esc(item.error)}</p>` : ''}</div>
        <div class="skill-install-controls"><label>更新方式<select data-install-mode aria-label="更新方式：${esc(item.directory)}"><option value="manual" ${item.mode === 'manual' ? 'selected' : ''}>提醒后确认</option><option value="auto" ${item.mode === 'auto' ? 'selected' : ''}>自动更新</option></select></label>
        <div><button class="secondary" data-install-update ${item.status === 'current' ? 'disabled' : ''}>${icon('download')}${item.status === 'incomplete' ? '补全并更新' : '更新'}</button><button class="icon-button" data-install-restore title="恢复上次更新前的文件" aria-label="恢复上次更新前的文件" ${item.canRestore ? '' : 'disabled'}>${icon('rotate-ccw')}</button><button class="icon-button" data-install-unlink title="解除安装关联" aria-label="解除安装关联">${icon('unlink')}</button></div></div></section>`).join('') : '<p class="muted">尚未关联外部 Agent 的 Skill 安装目录。</p>'}
      <p class="skill-export-note">仅检查本机已关联位置。文件更新后，外部 Agent 可能需要重新加载 Skill 或开启新会话。</p>`;
    target.querySelector('[data-install-check]').onclick = () => run(() => refresh(true));
    target.querySelector('[data-install-add]').onclick = () => run(async () => {
      clean(); const directory = await pickDirectory(); if (!directory) return;
      await apply({ directory, action: 'link' });
    });
    for (const row of target.querySelectorAll('[data-install-id]')) {
      const item = installs.find(value => value.id === row.dataset.installId);
      row.querySelector('[data-install-update]').onclick = () => run(() => apply({ id: item.id, action: item.status === 'incomplete' ? 'repair' : 'update' }));
      row.querySelector('[data-install-restore]').onclick = () => run(() => apply({ id: item.id, action: 'restore' }));
      row.querySelector('[data-install-mode]').onchange = event => run(async () => {
        const mode = event.target.value; event.target.value = item.mode; clean();
        if (!await confirmBox('更改 Skill 更新方式', `<p>${esc(item.directory)}</p><p>${mode === 'auto' ? '允许 FengZaiY 在运行期间自动将内置 Skill 和已保存偏好写入此位置。检测到手工修改或偏好冲突时暂停；更新前保留一份可恢复副本。' : '系统继续自动检查，发现更新后由你确认写入。'}</p>`, mode === 'auto' ? '开启自动更新' : '改为提醒后确认')) return;
        await api('skillInstallConfigure', { id: item.id, mode, confirmed: true }); await refresh();
        toast(mode === 'auto' ? '已开启此安装位置的自动更新' : '已改为提醒后确认');
      });
      row.querySelector('[data-install-unlink]').onclick = () => run(async () => {
        if (!await confirmBox('解除安装关联', `<p>${esc(item.directory)}</p><p>停止检查和更新，保留已安装文件；本系统保存的上次更新恢复副本将移除。</p>`, '解除关联')) return;
        await api('skillInstallUnlink', { id: item.id, confirmed: true }); await refresh();
      });
    }
    redrawIcons();
  }
  async function apply(input) {
    clean();
    const preview = await api('skillInstallPreview', input);
    const title = { link: '关联已有 Skill 安装', update: '更新已安装 Skill', repair: '补全并更新 Skill', restore: '恢复更新前文件' }[input.action];
    const detail = input.action === 'link' ? '仅关联这个已有安装目录，默认自动检查、提醒后确认更新。下面列出与当前内置版本不同的文件；其他文件保持不变。'
      : input.action === 'restore' ? '恢复上一份文件副本并切换为提醒后确认。外部 Agent 需要重新加载。'
      : input.action === 'repair' ? '补齐缺失文件，并将固定 Skill 文件更新为当前内置版本和已保存偏好。保留操作前副本，其他文件保持不变。操作期间请暂停使用此 Skill，完成后重新加载或开启新会话。'
      : '写入当前内置 Skill 和已保存偏好，保留更新前副本。更新期间请暂停使用此 Skill，完成后重新加载或开启新会话。';
    const modified = preview.modified.filter(name => !preview.missing?.includes(name));
    const restoreWarning = input.action === 'restore' && preview.targetMissing?.length
      ? `<p class="skill-install-warning">恢复副本缺少以下文件，恢复后安装将不完整：${preview.targetMissing.map(esc).join('、')}</p>` : '';
    if (!await confirmBox(title, `<p class="skill-install-path">${esc(preview.directory)}</p><p>${detail}</p>${input.action === 'repair' ? `<p class="skill-install-warning">将补齐：${preview.missing.map(esc).join('、')}</p>` : ''}${restoreWarning}${modified.length ? `<p class="skill-install-warning">以下手工修改将被覆盖并保留在恢复副本中：${modified.map(esc).join('、')}</p>` : ''}<ul>${preview.files.map(name => `<li>${esc(name)}</li>`).join('') || '<li>文件内容与目标一致</li>'}</ul>`, input.action === 'link' ? '关联此目录' : input.action === 'restore' ? '恢复文件' : input.action === 'repair' ? '确认补全并更新' : '确认更新')) return;
    clean(); await api('skillInstallConfirm', { token: preview.token, confirmed: true }); await refresh();
    toast(input.action === 'link' ? '已关联，将自动检查更新' : '安装文件已写入，请重新加载外部 Agent 的 Skill');
  }
  return { mount: async element => { host = element; await refresh(true); }, refresh };
}
