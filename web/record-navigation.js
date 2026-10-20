// Notes and drafts share presentation without turning draft collection into a formal hierarchy.
export function recordRows({ rows, selectedId, domain, summary, esc, icon, libraryName, formatTime, excerpt, processingLabels, deliveryLabels }) {
  return rows.map(row => {
    const status = row.processing && processingLabels[row.processing.status];
    const scope = libraryName(row.data.domain);
    return `<button class="record-row ${summary ? 'with-summary' : 'compact-record'} ${selectedId === row.id ? 'selected' : ''}" data-record="${row.id}" aria-current="${selectedId === row.id ? 'page' : 'false'}" title="${esc(`${scope} / ${row.data.title}`)}">
      <strong>${icon(row.conflict ? 'git-merge' : 'file-text')}<span>${esc(row.data.title)}</span></strong>
      ${summary ? `<p>${esc(excerpt(row))}</p>` : ''}
      <div class="record-details">${!domain ? `<span class="record-scope" title="${esc(scope)}">${esc(scope)}</span>` : ''}${status ? `<span class="processing-status">${status}</span>` : ''}<time title="${esc(formatTime(row.updatedAt))}">${formatTime(row.updatedAt)}</time></div>
      ${summary ? `<div class="row-tags">${(row.data.tags || []).slice(0, 2).map(tag => `<span>${esc(tag)}</span>`).join('')}<small class="delivery ${row.status}">${deliveryLabels[row.status] || ''}</small></div>` : ''}
    </button>`;
  }).join('');
}
