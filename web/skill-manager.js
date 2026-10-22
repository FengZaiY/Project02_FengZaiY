import { downloadSkill } from './skill-export.js';
import { createSkillInstallations } from './skill-installations.js';
import './skill-manager.css';

export function createSkillManager({ api, esc, icon, safeHtml, formatTime, toast, confirmBox, redrawIcons, run, pickDirectory }) {
  let host, bundle, pending = null, selectedTab = 'preferences', selectedFile = 'SKILL.md';
  const $ = selector => host?.querySelector(selector);
  const dirty = () => !!pending && pending.content !== pending.saved;
  const installs = createSkillInstallations({ api, esc, icon, formatTime, toast, confirmBox, redrawIcons, run, pickDirectory, dirty });
  function stash() {
    const input = $('#agent-preferences-form textarea');
    if (input?.isConnected && pending) pending.content = input.value;
  }
  function selectTab(name) {
    selectedTab = name;
    for (const button of host.querySelectorAll('[data-skill-tab]')) button.setAttribute('aria-selected', String(button.dataset.skillTab === name));
    for (const panel of host.querySelectorAll('[data-skill-panel]')) panel.hidden = panel.dataset.skillPanel !== name;
  }
  function showFile(name) {
    if (!Object.hasOwn(bundle.files, name)) return;
    selectedFile = name;
    $('#skill-file-name').textContent = name;
    $('#skill-file-body').textContent = bundle.files[name];
    for (const button of host.querySelectorAll('[data-skill-file]')) button.setAttribute('aria-current', button.dataset.skillFile === name ? 'true' : 'false');
  }
  function editStatus() {
    $('#skill-edit-status').textContent = dirty() ? '尚未保存' : '已保存';
    $('#skill-discard').hidden = !dirty();
  }
  async function mount(element, next) {
    stash(); host = element; bundle = next;
    const prefs = bundle.preferences;
    if (!dirty()) pending = { content: prefs.content, saved: prefs.content, heads: [...prefs.heads] };
    host.innerHTML = `<div class="skill-heading"><div><h2>SKILL 管理</h2><strong>studyself-organize</strong><span class="pill">系统内置</span></div><button class="secondary" data-action="agent-export" ${prefs.conflict ? 'disabled' : ''}>${icon('download')}导出 Skill</button></div>
      <div class="skill-summary"><span>知识整理与方案提交</span><span>${Object.keys(bundle.files).length} 个文件</span><span>协议 1</span><span id="skill-install-attention" role="status"></span></div>
      <dl class="skill-versions"><div><dt>内置版本</dt><dd title="${esc(bundle.skillVersion)}">${esc(bundle.skillVersion.slice(0, 12))}</dd></div><div><dt>偏好版本</dt><dd title="${esc(prefs.version)}">${esc(prefs.version.slice(0, 12))}</dd></div><div><dt>最近生成导出</dt><dd>${bundle.lastGenerated ? `${formatTime(bundle.lastGenerated.at)} · ${bundle.lastGenerated.version === bundle.exportVersion ? '与当前一致' : '内容已更新，需重新导出'}` : '尚未导出'}</dd></div></dl>
      <p class="skill-export-note">导出包是文件快照。已关联安装可自动检查及更新；未关联副本需自行替换。</p>
      <div class="skill-tabs" role="tablist" aria-label="Skill 管理视图">${[['preferences', '整理偏好'], ['installs', '安装更新'], ['files', 'Skill 文件'], ['history', '偏好历史']].map(([id, title]) => `<button role="tab" id="skill-tab-${id}" aria-controls="skill-panel-${id}" data-skill-tab="${id}">${title}</button>`).join('')}</div>
      <div id="skill-panel-installs" role="tabpanel" aria-labelledby="skill-tab-installs" data-skill-panel="installs" hidden></div>
      <div id="skill-panel-preferences" role="tabpanel" aria-labelledby="skill-tab-preferences" data-skill-panel="preferences">
        <details><summary>需求基线</summary><div class="prose">${safeHtml(prefs.baseline)}</div></details>
        ${prefs.conflict ? `<div class="notice amber">存在并发偏好，请对照后保存合并版本。Agent 写入已暂停。</div>${prefs.versions.map(version => `<details><summary>${formatTime(version.createdAt)} · ${esc(version.id.slice(0, 8))}</summary><pre class="preference-version">${esc(version.data.content)}</pre></details>`).join('')}` : ''}
        <form id="agent-preferences-form" class="settings-form"><label>我的补充与调整<textarea name="content" rows="8" maxlength="30000"></textarea></label><div class="skill-form-actions"><button type="submit" class="primary">${icon('save')}保存偏好版本</button><button type="button" id="skill-discard" class="secondary">撤销未保存修改</button><span id="skill-edit-status" role="status"></span></div><p id="skill-form-error" role="alert"></p><button type="button" id="skill-rebase" class="secondary" hidden>对照最新偏好</button></form>
      </div>
      <div id="skill-panel-files" role="tabpanel" aria-labelledby="skill-tab-files" data-skill-panel="files" hidden><div class="skill-file-layout"><nav aria-label="Skill 文件">${Object.keys(bundle.files).map(name => `<button data-skill-file="${esc(name)}">${icon(name.startsWith('scripts/') ? 'file-code' : 'file-text')}<span>${esc(name)}</span></button>`).join('')}</nav><section><div class="skill-file-toolbar"><strong id="skill-file-name"></strong><button id="skill-file-copy" class="icon-button" title="复制文件内容" aria-label="复制文件内容">${icon('copy')}</button></div><pre id="skill-file-body" tabindex="0" aria-label="Skill 文件正文"></pre></section></div><p class="muted">内置文件随系统更新维护；个人要求在“整理偏好”中保存。</p></div>
      <div id="skill-panel-history" role="tabpanel" aria-labelledby="skill-tab-history" data-skill-panel="history" hidden><div id="skill-history-list" role="status">正在读取历史…</div></div>`;
    const input = $('#agent-preferences-form textarea'); input.value = pending.content; input.dataset.savedValue = pending.saved;
    input.oninput = () => { pending.content = input.value; editStatus(); };
    $('#skill-rebase').onclick = () => run(async () => {
      stash();
      const latest = (await api('agentSkill')).preferences;
      const content = pending.content;
      const accepted = await confirmBox('对照最新偏好', `<h3>当前编辑</h3><pre class="preference-version">${esc(content)}</pre><h3>最新已保存内容</h3>${latest.versions.map(version => `<pre class="preference-version">${esc(version.data.content)}</pre>`).join('') || '<p>（空偏好）</p>'}<p>确认后使用当前编辑创建新版本，原有历史保留。</p>`, '以当前编辑保存');
      if (!accepted) return;
      if (pending.content !== content) throw new Error('编辑内容已变化，请重新对照');
      const saved = await api('agentPreferencesSave', { content, parents: latest.heads });
      pending.saved = saved.content; pending.heads = [...saved.heads];
      if (host?.isConnected) await mount(host, await api('agentSkill'));
      toast('已保存合并后的偏好版本');
    });
    $('#skill-discard').onclick = () => run(async () => {
      if (!await confirmBox('撤销未保存修改', '<p>恢复为本次编辑前的整理偏好。</p>', '撤销修改')) return;
      pending = null; await mount(host, await api('agentSkill'));
    });
    $('#agent-preferences-form').onsubmit = async event => {
      event.preventDefault(); stash();
      const form = event.target, submission = { content: pending.content, parents: [...pending.heads] }, submittedPending = pending;
      const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try {
        const saved = await api('agentPreferencesSave', submission);
        if (pending === submittedPending) {
          pending.heads = [...saved.heads]; pending.saved = saved.content;
          if (input.isConnected) input.dataset.savedValue = saved.content;
        }
        if (form.isConnected) await mount(host, await api('agentSkill'));
        toast('偏好版本已保存；Agent 下次写入前须读取新版本');
      } catch (error) {
        if (form.isConnected) { $('#skill-form-error').textContent = `${error.message}；编辑内容已保留。`; $('#skill-rebase').hidden = error.code !== 'CONFLICT'; }
        else toast(error.message, true);
      }
      finally { submit.disabled = false; }
    };
    host.querySelectorAll('[data-skill-tab]').forEach(button => { button.onclick = () => {
      selectTab(button.dataset.skillTab);
      if (selectedTab === 'installs') void installs.mount($('#skill-panel-installs')).catch(error => toast(error.message, true));
      if (selectedTab === 'history') void history().catch(error => { if (host?.isConnected) $('#skill-history-list').textContent = error.message; });
    }; });
    host.querySelectorAll('[data-skill-file]').forEach(button => { button.onclick = () => showFile(button.dataset.skillFile); });
    $('#skill-file-copy').onclick = () => run(async () => { await navigator.clipboard.writeText(bundle.files[selectedFile]); toast('已复制文件内容'); });
    showFile(selectedFile); selectTab(selectedTab); editStatus(); redrawIcons();
    const mountHost = host;
    void api('skillInstallList').then(items => {
      if (host !== mountHost || !mountHost.isConnected) return;
      const count = items.filter(item => item.status !== 'current').length;
      $('#skill-install-attention').textContent = count ? `${count} 个安装有更新或需要处理` : '';
    }).catch(error => toast(error.message, true));
    if (selectedTab === 'history') void history().catch(error => { if (host?.isConnected) $('#skill-history-list').textContent = error.message; });
    if (selectedTab === 'installs') await installs.mount($('#skill-panel-installs'));
  }
  async function history() {
    const target = $('#skill-history-list');
    const versions = await api('history', { id: bundle.preferences.id });
    if (!target?.isConnected) return;
    target.innerHTML = versions.length ? versions.map(version => `<details class="skill-history"><summary>${formatTime(version.createdAt)} · ${esc(version.id.slice(0, 8))}${bundle.preferences.heads.includes(version.id) ? ' · 当前分支' : ''}</summary><pre class="preference-version">${esc(version.data.content || '（空偏好）')}</pre><button class="secondary" data-skill-restore="${version.id}">${icon('rotate-ccw')}取回到编辑区</button></details>`).join('') : '<p class="muted">尚无已保存的偏好历史。</p>';
    for (const button of target.querySelectorAll('[data-skill-restore]')) button.onclick = () => run(async () => {
      if (dirty() && !await confirmBox('取回历史偏好', '<p>将替换编辑区中尚未保存的偏好。</p>', '取回')) return;
      const version = versions.find(item => item.id === button.dataset.skillRestore);
      pending.content = version.data.content || '';
      $('#agent-preferences-form textarea').value = pending.content;
      selectTab('preferences'); editStatus();
      toast('已取回历史内容；保存后创建新偏好版本');
    });
    redrawIcons();
  }
  return { mount, stash, dirty, refreshInstallations: async () => {
    if (host?.isConnected && selectedTab === 'installs' && !document.querySelector('dialog[open]') && !host.querySelector('[data-install-mode]:focus')) await installs.refresh();
  },
    export: async () => {
      stash(); if (dirty()) throw new Error('请先保存或撤销未保存的整理偏好，再导出 Skill');
      const next = await api('agentSkillExport'); downloadSkill(next);
      if (host?.isConnected) await mount(host, next);
      toast('已生成 Skill 导出文件，请在外部 Agent 中更新安装副本');
    }
  };
}
