export function syncSendState(status, devices = {}, action = '') {
  const job = status.job;
  const active = !!job && !['complete', 'cancelled'].includes(job.state);
  const local = devices.devices?.find(item => item.local);
  const restricted = !!(local?.suspended || local?.statusConflict);
  const busy = !!(status.busy || action);
  const pending = !!(status.pendingChanges || status.pendingControl);
  let title = '本机内容已生成', tone = 'neutral', label = '重新检查并发布';
  if (!status.config.configured) title = '先完成目录与配对设置';
  else if (restricted) { title = '本机暂停参与同步'; tone = 'warning'; }
  else if (busy) { title = action === 'sync-import' ? '正在接收更新' : action === 'sync-scan' ? '正在检查同步目录' : status.job?.phase === 'manifest' ? '正在更新最新清单' : action === 'sync-plan' ? '正在预估空间' : '正在处理'; tone = 'working'; }
  else if (active) {
    title = { ready: '已准备，等待生成', running: '正在生成交接文件', paused: '发送已暂停', blocked: '发送需要处理' }[job.state] || '等待继续';
    label = job.state === 'ready' ? '开始生成' : '继续发送';
    tone = job.state === 'blocked' ? 'danger' : 'warning';
  } else if (pending || !status.latest) { title = '有本机更新待发送'; label = '发布当前内容'; }
  else if (!status.latest.userConfirmedAt) { title = '等待确认百度上传'; tone = 'warning'; }
  else { title = '本次上传已确认'; tone = 'success'; }
  return { active, busy, pending, restricted, title, tone, label,
    canPublish: status.config.configured && !busy && !restricted,
    canPause: !!status.busy && (!action || ['sync-plan', 'sync-publish', 'sync-import'].includes(action)),
    canConfirmBatch: active && !busy && job.completedObjects > (job.confirmedThrough || 0),
    canConfirmUpload: !!status.latest && !status.latest.userConfirmedAt && !busy,
    canIndex: !devices.conflict && !local?.primary && !restricted };
}

export function syncReceiveState(scan) {
  if (!scan) return { title: '尚未检查其他电脑的更新', remote: [], pending: 0, issues: 0 };
  const remote = scan.entries.filter(item => !item.own);
  const pending = remote.filter(item => !item.imported).length;
  const issues = scan.errors.length + remote.filter(item => item.missing.length || item.invalid?.length).length;
  return { remote, pending, issues, title: issues ? '下载文件需要检查' : pending ? `${pending} 台电脑有待接收更新`
    : remote.length ? '已发现的修改记录已合并' : '尚未发现其他电脑的更新' };
}
