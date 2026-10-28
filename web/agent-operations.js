import './agent-operations.css';

const labels = { pending: '待确认', executing: '执行中', completed: '已完成', rejected: '已拒绝', expired: '已过期',
  failed: '未完成', interrupted: '执行中断', local_action_required: '待本机流程完成' };

export function createAgentOperationsUI({ api, esc, icon, formatTime, openModal, redrawIcons, toast, beforeApprove, localAction }) {
  let host, loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    const target = host;
    try {
      const rows = await api('agentOperationList');
      const pending = rows.filter(row => row.state === 'pending').length;
      const nav = document.querySelector('[data-nav="agents"]');
      if (nav) {
        let badge = nav.querySelector('[data-agent-count]');
        if (!badge) { badge = document.createElement('b'); badge.dataset.agentCount = ''; nav.append(badge); }
        badge.textContent = String(pending); badge.hidden = !pending; badge.title = 'Agent 请求待本机确认';
      }
      if (!target?.isConnected || target !== host) return;
      const sorted = [...rows].sort((a, b) => (a.state === 'pending' ? -1 : 0) - (b.state === 'pending' ? -1 : 0) || b.at.localeCompare(a.at));
      target.innerHTML = `<div class="agent-request-heading"><h2>操作请求${pending ? ` · ${pending} 待确认` : ''}</h2><button class="icon-button" data-refresh-requests title="刷新操作请求" aria-label="刷新操作请求">${icon('refresh-cw')}</button></div>
        <div class="agent-requests">${sorted.slice(0, 100).map(row => `<div class="agent-request" data-request="${esc(row.id)}"><div><strong>${esc(row.label)}</strong><small>${esc(row.agent)} · ${formatTime(row.at)}</small></div><span class="agent-request-state">${esc(labels[row.state] || row.state)}</span><button class="secondary" data-review-request="${esc(row.id)}">${icon(row.state === 'pending' ? 'clipboard-check' : 'eye')}${row.state === 'pending' ? '查看并处理' : '详情'}</button></div>`).join('') || '<p class="muted">暂无操作请求</p>'}</div>`;
      target.querySelector('[data-refresh-requests]').onclick = () => refresh().catch(error => toast(error.message, true));
      target.querySelectorAll('[data-review-request]').forEach(button => { button.onclick = () => review(button.dataset.reviewRequest).catch(error => toast(error.message, true)); });
      redrawIcons();
    } finally { loading = false; }
  }
  async function review(id) {
    const detail = await api('agentOperationDetail', { id });
    const pending = detail.state === 'pending';
    const dialog = openModal(detail.label, `<div class="agent-review"><dl><dt>请求来源</dt><dd>${esc(detail.agent)}</dd><dt>状态</dt><dd>${esc(labels[detail.state])}</dd>${detail.target ? `<dt>目标</dt><dd>${esc(detail.target)}</dd>` : ''}<dt>有效期至</dt><dd>${formatTime(detail.expiresAt)}</dd></dl>
      ${detail.stale ? '<p class="notice amber">资料或配置已变化，请让 Agent 读取最新状态后重新发起。</p>' : ''}
      ${detail.blocked || detail.message ? `<p role="alert">${esc(detail.blocked || detail.message)}</p>` : ''}
      ${detail.mode === 'local' ? '<p>此项需要接续本机操作；进入页面不代表已经完成。</p>' : ''}
      ${pending ? `<details open><summary>请求参数</summary><pre>${esc(JSON.stringify(detail.input, null, 2))}</pre></details>` : ''}
      ${detail.preview ? `<details open><summary>影响预览</summary><pre>${esc(JSON.stringify(detail.preview, null, 2))}</pre></details>` : ''}<p class="agent-request-error" role="alert"></p></div>`,
    pending ? `<button class="secondary" id="agent-request-reject">${icon('x')}拒绝请求</button><button class="primary" id="agent-request-approve" ${detail.stale || detail.blocked ? 'disabled' : ''}>${icon('check')}${detail.mode === 'local' ? '继续本机操作' : '确认执行'}</button>` : '');
    if (!pending) return;
    for (const approved of [true, false]) {
      const control = dialog.querySelector(approved ? '#agent-request-approve' : '#agent-request-reject');
      control.onclick = async () => {
        const controls = [...dialog.querySelectorAll('.modal-footer button')];
        controls.forEach(button => { button.disabled = true; });
        try {
          if (approved) await beforeApprove();
          const result = await api('agentOperationDecide', { id, token: detail.token, approved });
          dialog.close(); await refresh();
          if (result.localAction) await localAction(id, result.localAction);
          else toast(approved ? 'Agent 请求已执行' : '已拒绝请求');
        } catch (error) {
          if (dialog.open) dialog.querySelector('.agent-request-error').textContent = error.message;
          else toast(error.message, true);
        } finally {
          controls.forEach(button => { button.disabled = false; });
          if (detail.stale || detail.blocked) dialog.querySelector('#agent-request-approve').disabled = true;
        }
      };
    }
  }
  return { refresh, async mount(element) { host = element; await refresh(); } };
}
