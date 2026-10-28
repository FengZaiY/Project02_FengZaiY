export function materialTreeMarkup(tree, { esc, icon, categoryId, topicId }) {
  return `<section class="material-organization" aria-label="资料分类与主题"><div class="inline-actions"><strong>资料分类</strong><button class="icon-button" data-action="material-category-new" title="新建分类" aria-label="新建资料分类">${icon('folder-plus')}</button><button class="text-button" data-action="material-topic-select" data-topic="">全部</button><button class="text-button" data-action="material-topic-select" data-topic=":unfiled" aria-pressed="${topicId === ':unfiled'}">待整理</button></div>
    <div class="material-category-tree">${tree.categories.map(category => `<details open><summary><button class="text-button" data-action="material-category-select" data-category="${category.id}" aria-pressed="${categoryId === category.id}">${icon('folder')} ${esc(category.data.title)}</button><button class="icon-button" data-action="material-category-edit" data-id="${category.id}" title="编辑分类" aria-label="编辑分类">${icon('pencil')}</button><button class="icon-button" data-action="material-topic-new" data-category="${category.id}" title="新建主题" aria-label="新建资料主题">${icon('plus')}</button></summary>${tree.topics.filter(topic => topic.data.materialCategoryId === category.id).map(topic => `<div class="material-topic-row"><button class="text-button" data-action="material-topic-select" data-topic="${topic.id}" aria-pressed="${topicId === topic.id}">${icon('folder-open')} ${esc(topic.data.title)}</button><button class="icon-button" data-action="material-topic-edit" data-id="${topic.id}" title="编辑主题" aria-label="编辑主题">${icon('pencil')}</button></div>`).join('')}</details>`).join('') || '<p class="muted">暂无资料分类</p>'}</div>${tree.pending ? '<p class="notice amber">部分资料目录待处理，当前原件仍保留。<button class="text-button" data-action="material-migrate">检查并继续整理</button></p>' : ''}</section>`;
}

export function materialOrganizationActions({ api, esc, openModal, toast, run, refresh, openRecord, selected, filter }) {
  async function edit(type, target) {
    const tree = await api('materialTree'), records = type === 'materialCategory' ? tree.categories : tree.topics;
    const current = records.find(item => item.id === target?.dataset.id), data = current?.data;
    const dialog = openModal(type === 'materialCategory' ? '资料分类' : '资料主题', `<form class="settings-form" id="material-structure-form"><label>名称<input name="title" required maxlength="100" value="${esc(data?.title || '')}"></label>${type === 'materialTopic' ? `<label>所属分类<select name="materialCategoryId" required><option value="">选择分类</option>${tree.categories.filter(r => !r.conflict).map(r => `<option value="${r.id}" ${(data?.materialCategoryId || target?.dataset.category) === r.id ? 'selected' : ''}>${esc(r.data.title)}</option>`).join('')}</select></label>` : ''}<label>说明<textarea name="description">${esc(data?.description || '')}</textarea></label><button class="primary" type="submit">保存</button></form>`);
    const form = dialog.querySelector('form');
    form.onsubmit = event => { event.preventDefault(); run(async () => {
      const values = Object.fromEntries(new FormData(form)); form.querySelector('button').disabled = true;
      try { await api('personalSave', { type, ...(current ? { id: current.id } : {}), parents: current?.heads || [], data: { ...data, ...values } }); dialog.close(); await refresh(); }
      finally { if (form.isConnected) form.querySelector('button').disabled = false; }
    }); };
  }
  async function organize() {
    const entries = selected(); if (!entries.length) { toast('请先选择资料'); return; }
    const tree = await api('materialTree');
    const dialog = openModal('整理资料位置', `<form class="settings-form"><p>已选 ${entries.length} 项资料</p><label>资料主题<select name="materialTopicId"><option value="">待整理</option>${tree.topics.filter(r => !r.conflict).map(r => `<option value="${r.id}">${esc(tree.categories.find(c => c.id === r.data.materialCategoryId)?.data.title || '')} / ${esc(r.data.title)}</option>`).join('')}</select></label>${entries.length === 1 ? '<label>实际文件名<input name="managedFilename" placeholder="留空保留原文件名"></label>' : ''}<button class="primary" type="submit">预览整理方案</button></form>`);
    const form = dialog.querySelector('form'); form.onsubmit = event => { event.preventDefault(); run(async () => {
      const values = Object.fromEntries(new FormData(form));
      const result = await api('materialPropose', { materialItems: entries.map(entry => ({ type: 'asset', targetId: entry.id, parents: entry.parents, data: { materialTopicId: values.materialTopicId || null, ...(values.managedFilename ? { managedFilename: values.managedFilename } : {}) } })) });
      dialog.close(); await openRecord(result.id);
    }); };
  }
  return {
    'material-category-new': () => edit('materialCategory'), 'material-category-edit': target => edit('materialCategory', target),
    'material-topic-new': target => edit('materialTopic', target), 'material-topic-edit': target => edit('materialTopic', target),
    'material-topic-select': async target => { filter.topicId = target.dataset.topic; filter.categoryId = ''; filter.directory = ''; await refresh(); },
    'material-category-select': async target => { filter.categoryId = target.dataset.category; filter.topicId = ''; filter.directory = ''; await refresh(); },
    'material-organize': organize
  };
}
