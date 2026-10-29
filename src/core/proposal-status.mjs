export function proposalProgress(record) {
  const items = [...(record.data?.items || []), ...(record.data?.materialItems || [])];
  const total = items.length, accepted = items.filter(item => item.status === 'accepted').length;
  const status = record.conflict ? 'conflict' : total > 0 && accepted === total ? 'accepted' : accepted ? 'partial' : 'pending';
  return { status, accepted, total, pending: total - accepted,
    label: ({ conflict: '待处理冲突', accepted: '已确认', partial: '部分确认', pending: total ? '待确认' : '暂无方案项' })[status] };
}

export function matchesProposalStatus(record, filter) {
  if (!filter || filter === 'all') return true;
  const { status } = proposalProgress(record);
  return filter === 'active' ? status !== 'accepted' : status === filter;
}
