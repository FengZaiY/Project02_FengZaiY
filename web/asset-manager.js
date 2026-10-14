import './assets.css';
import { thumbnailMarkup, mountThumbnails, fitFilterLabels } from './asset-thumbnails.js';
import { storageTree, storageLocation } from './asset-storage.js';

export function createAssetUI({ state, api, esc, icon, button, bytes, formatTime, libraryName, domainOptions, openModal, confirmBox, toast, run, render, redrawIcons, openRecord, mediaUrl, native, persist }) {
  const $ = selector => document.querySelector(selector);
  const kinds = { image: '图片', video: '视频', audio: '音频', document: '文档', archive: '压缩包', other: '其他' };
  const types = { note: '笔记', draft: '草稿', source: '来源', proposal: '整理方案', annotation: '备注', relation: '关联', conversation: '历史资料', task: '历史任务' };
  const filters = { kind: '', availability: '', usage: '', tag: '', sort: 'updated', trash: false, offset: 0, limit: 100, directory: '' };
  let selected = new Map(), scope = '', serial = 0, rows = [];
  let directoryDomain, directoriesOpen = true, rootDirectory = '';
  let stopThumbnails, stopFilterLabels;
  const dispose = () => { stopThumbnails?.(); stopFilterLabels?.(); stopThumbnails = stopFilterLabels = null; };
  const options = (values, value) => Object.entries(values).map(([id, text]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(text)}</option>`).join('');
  const tagsHtml = tags => tags.map(tag => `<span class="material-tag">${esc(tag)}</span>`).join('');
  const filter = (key, label, name, values) => `<label class="material-filter"><span>${label}</span><select data-material-filter="${key}" aria-label="${name}">${options(values, filters[key])}</select><small class="material-filter-value" hidden></small></label>`;
  async function show() {
    const request = ++serial, domain = state.domain, query = state.query;
    if (directoryDomain !== domain) { filters.directory = ''; directoryDomain = domain; }
    const nextScope = JSON.stringify([domain, query, filters.kind, filters.availability, filters.usage, filters.tag, filters.trash, filters.sort, filters.directory]);
    if (scope !== nextScope) { selected.clear(); filters.offset = 0; scope = nextScope; }
    const result = await api('assetCatalog', { ...filters, domain: domain || undefined, query });
    if (request !== serial || state.view !== 'assets' || state.domain !== domain || state.query !== query) return;
    if (filters.offset && !result.rows.length) { filters.offset = Math.max(0, filters.offset - filters.limit); return show(); }
    rows = result.rows;
    rootDirectory = result.storage.root;
    const main = $('#main');
    dispose();
    main.className = 'settings-view material-manager';
    main.innerHTML = `<div class="page-heading"><div><h1>资料与附件</h1><small class="muted">${esc(libraryName(domain))} · ${result.total} 项 · ${bytes(result.totalBytes)}</small></div><div class="inline-actions"><button class="primary" data-action="asset-import">${icon('upload')}导入文件</button>${button('files', 'asset-import-separate', '导入为独立资料（允许相同内容）')}</div></div>
      <section class="material-storage" aria-label="本机存放位置">
        <div class="material-storage-root">${icon('hard-drive')}<div><small>工作区根目录</small><span id="material-root-path">${esc(rootDirectory)}</span></div>
        ${button('copy', 'material-copy-root', '复制工作区根目录')}${native ? button('folder-open', 'storage-open-folder', '打开工作区根目录') : ''}</div>
        <details id="material-directories" ${directoriesOpen ? 'open' : ''}><summary>本机目录 <small>当前筛选范围 · ${result.storage.directories.reduce((n, d) => n + d.count, 0)} 项</small></summary>
          <div class="material-directory-scroll">${storageTree(result.storage, filters.directory, { esc, icon })}</div></details>
        ${filters.directory ? `<div class="material-directory-selection"><span>目录范围：${esc(filters.directory === ':unbound' ? '尚未下载到本机' : filters.directory === ':external' ? '工作区外' : filters.directory)}</span>${button('x', 'material-directory-clear', '清除目录筛选')}</div>` : ''}
      </section>
      <div class="material-toolbar">
        <div class="material-scope-bar"><div class="material-tabs" role="group" aria-label="资料范围"><button data-action="material-active" aria-pressed="${!filters.trash}">全部资料</button><button data-action="material-trash-view" aria-pressed="${filters.trash}">${icon('trash-2')}资料回收站</button></div>
        ${button('filter-x', 'material-clear', '清除资料筛选')}</div>
        <div class="material-filters">
        ${filter('kind', '类型', '资料类型', { '': '全部类型', ...kinds })}
        ${filter('tag', '标签', '资料标签', { '': '全部标签', ...Object.fromEntries(result.tags.map(tag => [tag, tag])) })}
        ${filter('availability', '本机文件', '本机文件状态', { '': '全部本机状态', available: '本机可用', missing: '待下载或缺失', pinned: '长期保留' })}
        ${filter('usage', '使用情况', '资料使用情况', { '': '全部使用情况', used: '有引用', unused: '未引用', duplicates: '相同内容', conflicts: '有冲突' })}
        ${filter('sort', '排序', '资料排序', { updated: '最近修改', name: '名称排序', size: '大小排序' })}
        </div>
      </div>
      <div class="material-bulk" aria-label="批量资料管理"><span id="material-selection-count"></span>
        ${filters.trash ? `<button class="secondary" data-action="material-batch-restore">${icon('undo-2')}恢复</button>` : `<button class="secondary" data-action="material-batch-tags">${icon('tags')}标签</button><button class="secondary" data-action="material-batch-move">${icon('library')}移动到知识库</button><button class="secondary" data-action="material-batch-trash">${icon('trash-2')}移入回收站</button>`}
        <button class="text-button" data-action="material-deselect">取消选择</button>
      </div>
      <div class="table-scroll"><table class="data-table material-table"><thead><tr><th class="material-check"><input type="checkbox" id="material-all" aria-label="选择本页资料"></th><th>预览</th><th>资料名称 / 本机位置</th><th>知识库</th><th>大小 / 修改时间</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${rows.map(row => `<tr data-material-row="${row.id}"><td><input type="checkbox" data-material-check="${row.id}" aria-label="选择资料：${esc(row.data.title)}" ${selected.has(row.id) ? 'checked' : ''}></td>
        <td>${thumbnailMarkup(row, { esc, icon })}</td>
        <td><button class="material-name" data-action="material-detail" data-asset="${row.id}"><span>${esc(row.data.title)}</span></button>
        ${row.data.title !== row.data.filename ? `<small class="material-original">${esc(row.data.filename)}</small>` : ''}
        ${storageLocation(row.storage, { esc, icon })}
        <div class="material-tags">${tagsHtml(row.data.tags)}${row.data.sensitive ? '<span class="material-tag sensitive">敏感</span>' : ''}</div></td>
        <td>${esc(libraryName(row.data.domain))}</td><td>${bytes(row.data.size)}<small>${formatTime(row.updatedAt)}</small></td>
        <td><span class="pill ${row.available ? 'green' : 'amber'}">${row.available ? '本机可用' : '待下载或缺失'}</span><small>${row.conflict ? '属性有冲突 · ' : ''}${row.referencesUnknown ? '引用待核验' : row.referenceCount ? `${row.referenceCount} 处引用` : '未引用'}${row.duplicateCount > 1 ? ` · ${row.duplicateCount} 份相同内容` : ''}${row.pinned ? ' · 长期保留' : ''}</small></td>
        <td><div class="inline-actions">${!row.deleted && !row.conflict ? button('eye', 'preview-asset', '预览资料', `data-asset="${row.id}"`) + button('pencil', 'material-edit', '编辑资料属性', `data-asset="${row.id}"`) : ''}
        ${button('info', 'material-detail', '资料详情与引用', `data-asset="${row.id}"`)}
        ${!row.deleted && !row.conflict && row.duplicateCount > 1 ? button('combine', 'material-merge', '合并相同内容', `data-asset="${row.id}"`) : ''}
        ${row.deleted && !row.conflict ? button('undo-2', 'material-restore', '恢复资料', `data-asset="${row.id}"`) : ''}</div></td></tr>`).join('')}
      </tbody></table></div>
      ${!rows.length ? `<div class="section-empty">${result.scopedTotal ? '没有符合条件的资料' : filters.trash ? '资料回收站为空' : '暂无资料'}</div>` : ''}
      <div class="material-pagination"><span>${result.total ? filters.offset + 1 : 0}–${filters.offset + rows.length} / ${result.total}</span><button class="icon-button" data-action="material-prev" aria-label="上一页资料" title="上一页资料" ${filters.offset ? '' : 'disabled'}>${icon('chevron-left')}</button><button class="icon-button" data-action="material-next" aria-label="下一页资料" title="下一页资料" ${filters.offset + rows.length < result.total ? '' : 'disabled'}>${icon('chevron-right')}</button></div>`;
    $('#material-directories').ontoggle = event => { directoriesOpen = event.target.open; };
    main.querySelectorAll('.material-directory').forEach(control => control.addEventListener('click', event => event.preventDefault()));
    main.querySelectorAll('[data-material-filter]').forEach(control => control.onchange = () => run(async () => { filters[control.dataset.materialFilter] = control.value; await show(); }));
    main.querySelectorAll('[data-material-check]').forEach(control => control.onchange = () => {
      const row = rows.find(row => row.id === control.dataset.materialCheck);
      if (control.checked) selected.set(row.id, row.heads); else selected.delete(row.id);
      selection();
    });
    $('#material-all').onchange = event => {
      rows.forEach(row => { if (event.target.checked) selected.set(row.id, row.heads); else selected.delete(row.id); });
      main.querySelectorAll('[data-material-check]').forEach(control => { control.checked = selected.has(control.dataset.materialCheck); });
      selection();
    };
    selection(); redrawIcons();
    stopThumbnails = mountThumbnails(main, mediaUrl);
    stopFilterLabels = fitFilterLabels(main);
  }
  function selection() {
    $('#material-selection-count').textContent = `已选 ${selected.size} 项`;
    document.querySelectorAll('.material-bulk button').forEach(button => { button.disabled = !selected.size; });
    const count = rows.filter(row => selected.has(row.id)).length;
    $('#material-all').checked = !!rows.length && count === rows.length;
    $('#material-all').indeterminate = count > 0 && count < rows.length;
  }
  const items = () => [...selected].map(([id, parents]) => ({ id, parents }));
  const afterChange = async message => { selected.clear(); $('#modal').close(); await render(); toast(message); };
  async function batch(action, entries = items()) {
    if (!entries.length) return;
    if (action === 'trash' || action === 'restore') {
      if (!await confirmBox(action === 'trash' ? '移入资料回收站' : '恢复资料',
        `<p>将${action === 'trash' ? '回收' : '恢复'} ${entries.length} 项资料。${action === 'trash' ? '原文件和历史仍保留；仍有引用的资料不能回收。' : '资料将回到原知识库。'}</p>`, action === 'trash' ? '移入回收站' : '恢复')) return;
      await api('assetBatch', { items: entries, action });
      await afterChange(action === 'trash' ? '资料已移入回收站，原件保留' : '资料已恢复'); return;
    }
    const dialog = openModal(action === 'move' ? '移动资料归属' : '批量管理标签', `<form id="material-batch-form" class="settings-form">
      <p>已选 ${entries.length} 项</p>${action === 'move' ? `<label>目标知识库<select name="domain" required>${domainOptions('', false)}</select></label><p class="muted">已有引用的资料须先处理引用，移动不会改动笔记。</p>`
        : `<label>操作<select name="action"><option value="addTags">添加标签</option><option value="removeTags">移除标签</option></select></label><label>标签（逗号分隔）<input name="tags" required maxlength="10000"></label>`}
      <div class="form-actions"><button class="primary" type="submit">确认修改</button></div><p class="material-form-error" role="alert"></p></form>`);
    bindSubmit(dialog, async form => {
      const input = Object.fromEntries(new FormData(form));
      await api('assetBatch', { items: entries, action: action === 'move' ? action : input.action, domain: input.domain, tags: parseTags(input.tags || '') });
      dialog.close(); await afterChange('所选资料已更新');
    });
  }
  const parseTags = text => [...new Set(text.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
  async function merge(id) {
    if (state.view !== 'assets') { toast('请在“资料与附件”页面合并相同内容'); return; }
    await persist();
    const group = await api('assetDuplicates', { id });
    if (group.length < 2) { toast('当前知识库没有其他相同内容'); return; }
    const dialog = openModal('合并相同内容', `<form id="material-merge-form" class="settings-form">
      <fieldset class="material-merge-choices"><legend>选择保留的资料 · ${esc(libraryName(group[0].data.domain))}</legend>
        ${group.map(row => `<label class="check-row"><input type="radio" name="target" value="${row.id}" ${row.id === id ? 'checked' : ''}><span><strong>${esc(row.data.title)}</strong><small>${esc(row.data.filename)} · ${bytes(row.data.size)}${row.data.sensitive ? ' · 敏感' : ''}</small><small>${esc(row.data.tags.join(' · ') || '无标签')}</small></span></label>`).join('')}</fieldset>
      <div id="material-merge-preview" aria-live="polite"></div>
      <p class="muted">保留所选名称，汇总标签；任一附件为敏感资料时保留敏感标记。其他条目移入回收站，历史和原件保留，本次不释放磁盘空间。旧历史引用不改写，需要时可恢复旧附件。</p>
      <div class="form-actions"><button class="secondary" type="button" id="material-merge-cancel">取消</button><button class="secondary" type="button" id="material-merge-refresh">${icon('refresh-cw')}重新预览</button><button class="primary" type="submit" disabled>确认合并</button></div>
      <p class="material-form-error" role="alert"></p></form>`);
    dialog.classList.add('material-dialog');
    const form = dialog.querySelector('form'), submit = form.querySelector('[type=submit]'), host = $('#material-merge-preview');
    const ids = group.map(row => row.id);
    let preview, revision = 0, merging = false;
    const load = async () => {
      const request = ++revision;
      preview = null; submit.disabled = true; host.textContent = '正在核对引用…';
      form.querySelector('[role=alert]').textContent = '';
      try {
        await persist();
        const result = await api('assetMergePreview', { ids, targetId: form.elements.target.value });
        if (!host.isConnected || request !== revision) return;
        preview = result;
        host.innerHTML = `<h4>将调整 ${result.changes.length} 项内容的引用，回收 ${ids.length - 1} 项重复资料</h4>
          <div class="material-references">${result.changes.map(change => `<div><span><strong>${esc(change.title)}</strong><small>${types[change.type] || '资料'}${change.deleted ? ' · 回收站' : ''}</small></span></div>`).join('') || '<p class="muted">没有需要调整的引用</p>'}</div>
          <p>合并标签：${esc(result.tags.join('、') || '无')} · ${result.sensitive ? '敏感资料' : '非敏感资料'}</p>
          ${result.blocked.length ? `<div class="notice amber">${result.blocked.map(esc).join('<br>')}</div>` : ''}`;
        submit.disabled = !!result.blocked.length;
      } catch (error) { if (request === revision && host.isConnected) { host.textContent = ''; form.querySelector('[role=alert]').textContent = error.message; } }
    };
    form.querySelectorAll('[name=target]').forEach(control => control.onchange = () => { void load(); });
    $('#material-merge-refresh').onclick = () => { if (!merging) void load(); };
    $('#material-merge-cancel').onclick = () => dialog.close();
    form.onsubmit = async event => {
      event.preventDefault();
      if (merging || !preview || preview.blocked.length) return;
      merging = true; submit.disabled = true;
      form.querySelectorAll('input,button').forEach(control => { control.disabled = true; });
      try {
        await persist();
        await api('assetMerge', { ids, targetId: preview.targetId, token: preview.token, confirmed: true });
        await afterChange('引用已统一，重复资料已移入回收站；历史和原件保留');
      } catch (error) {
        preview = null;
        form.querySelector('[role=alert]').textContent = `${error.message}；请重新预览`;
      } finally {
        merging = false;
        form.querySelectorAll('input,button').forEach(control => { control.disabled = false; });
        submit.disabled = true;
      }
    };
    await load();
  }
  function bindSubmit(dialog, submit) {
    const form = dialog.querySelector('form');
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('[type=submit]');
      button.disabled = true; form.querySelector('[role=alert]').textContent = '';
      try { await submit(form); } catch (error) { form.querySelector('[role=alert]').textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  async function edit(id) {
    const row = await api('assetDetail', { id });
    if (row.deleted || row.conflict) { await detail(id); return; }
    const dialog = openModal('编辑资料属性', `<form id="material-edit-form" class="settings-form">
      <label>资料名称<input name="title" value="${esc(row.data.title)}" required maxlength="500"></label>
      <label>原文件名<input value="${esc(row.data.filename)}" readonly></label>
      <label>知识库<select name="domain" required ${row.references.length || row.referencesUnknown ? 'disabled' : ''}>${domainOptions(row.data.domain, false)}</select></label>
      ${row.references.length || row.referencesUnknown ? '<small class="muted">已有引用或引用待核验，暂不能跨库移动。</small>' : ''}
      <label>标签（逗号分隔）<input name="tags" value="${esc(row.data.tags.join(', '))}" maxlength="10000"></label>
      <label class="check-row"><input name="sensitive" type="checkbox" ${row.data.sensitive ? 'checked' : ''}>敏感资料（外部 Agent 需要额外授权）</label>
      <div class="form-actions"><button class="primary" type="submit">保存属性</button></div><p class="material-form-error" role="alert"></p></form>`);
    bindSubmit(dialog, async form => {
      const values = Object.fromEntries(new FormData(form));
      await api('assetUpdate', { id, parents: row.heads, changes: { title: values.title, domain: values.domain || row.data.domain,
        tags: parseTags(values.tags), sensitive: values.sensitive === 'on' } });
      dialog.close(); await afterChange('资料属性已保存，原文件名与引用保持不变');
    });
  }
  async function detail(id) {
    const row = await api('assetDetail', { id });
    const dialog = openModal('资料详情', `<div class="material-detail">
      <h3>${esc(row.data.title)}</h3>
      <dl class="material-facts"><dt>原文件名</dt><dd>${esc(row.data.filename)}</dd><dt>知识库</dt><dd>${esc(libraryName(row.data.domain))}</dd>
      <dt>类型 / 大小</dt><dd>${kinds[row.kind]} · ${bytes(row.data.size)}</dd><dt>修改时间</dt><dd>${formatTime(row.updatedAt)}</dd>
      <dt>本机状态</dt><dd>${row.available ? '本机文件可用' : '待下载或缺失'}${row.pinned ? ' · 长期保留' : ''}</dd>
      <dt>存放类别</dt><dd>${esc(row.storage.label)}${row.storage.state === 'missing' ? ' · 已记录位置，文件缺失' : row.storage.state === 'changed' ? ' · 文件异常' : ''}</dd>
      <dt>本机完整路径</dt><dd class="material-file-path">${row.storage.path ? `<span>${esc(row.storage.path)}</span>${button('copy', 'material-copy-path', '复制附件完整路径', `data-asset="${id}"`)}` : '尚未下载到本机，暂无文件路径'}</dd>
      ${row.storage.path ? `<dt>所在文件夹</dt><dd class="material-file-path"><span>${esc(row.storage.directory)}</span>${button('copy', 'material-copy-directory', '复制附件所在文件夹', `data-asset="${id}"`)}</dd>` : ''}
      <dt>同步记录</dt><dd>${({ local: '本地修改待发布', waiting: '交接文件已生成', received: '已接收修改记录' })[row.status]}；云端上传由百度客户端确认</dd>
      <dt>标签</dt><dd class="material-tags">${tagsHtml(row.data.tags) || '未设置'}${row.data.sensitive ? ' · 敏感资料' : ''}</dd></dl>
      ${row.duplicateCount > 1 ? `<p class="notice">${row.duplicateCount} 项资料内容相同，可能有各自的引用，未自动合并。</p>` : ''}
      ${state.view === 'assets' && !row.deleted && !row.conflict && row.duplicateCount > 1 ? `<button class="secondary" data-action="material-merge" data-asset="${id}">${icon('combine')}合并相同内容</button>` : ''}
      <div class="material-detail-actions">${!row.deleted && !row.conflict ? `${button('pencil', 'material-edit', '编辑资料属性', `data-asset="${id}"`)}<button class="secondary" data-action="preview-asset" data-asset="${id}">${icon('eye')}预览</button>
      ${native && row.available ? `<button class="secondary" data-action="material-open" data-asset="${id}">${icon('external-link')}本机打开</button>` : ''}
      ${row.available ? `<button class="secondary" data-action="pin-asset" data-asset="${id}" data-pinned="${row.pinned}">${icon('pin')}${row.pinned ? '取消长期保留' : '长期保留'}</button>${button('hard-drive-download', 'asset-evict', '释放本机原件（需主力机回执）', `data-asset="${id}"`)}`
        : `<button class="secondary" data-action="bind-asset" data-asset="${id}">${icon('link')}关联本机文件</button>${button('download', 'asset-hydrate', '从已下载交接文件恢复原件', `data-asset="${id}"`)}`}
      <button class="secondary" id="material-trash" ${row.references.length || row.referencesUnknown ? 'disabled' : ''}>${icon('trash-2')}移入回收站</button>` : row.deleted && !row.conflict ? '<button class="secondary" id="material-restore">恢复资料</button>' : ''}</div>
      ${row.deleted ? '<p class="notice">此资料已在回收站，原文件及历史仍保留。</p>' : ''}
      <h4>引用位置 · ${row.references.length}</h4>
      ${row.referencesUnknown ? '<p class="notice amber">部分正文引用无法核验，暂不能移动或回收资料。</p>' : ''}
      <div class="material-references">${row.references.map(ref => `<div><span><strong>${esc(ref.title)}</strong><small>${esc(libraryName(ref.domain))} · ${types[ref.type] || '资料'}${ref.pending ? ' · 未保存编辑' : ''}${ref.deleted ? ' · 回收站' : ''}${ref.conflict ? ' · 冲突分支' : ''}</small></span>
        ${['note', 'draft', 'source', 'proposal', 'annotation', 'relation'].includes(ref.type) ? `<button class="icon-button" data-material-reference="${esc(ref.id)}" aria-label="查看引用：${esc(ref.title)}" title="查看引用">${icon('arrow-up-right')}</button>` : ''}</div>`).join('') || '<p class="muted">暂无当前引用</p>'}</div>
      <details><summary>文件标识与校验信息</summary><dl class="material-facts"><dt>资料标识</dt><dd>${id}</dd><dt>SHA-256</dt><dd>${row.data.sha256}</dd></dl></details>
      <details id="material-history"><summary>${row.conflict ? '对照冲突与修改记录' : '修改记录'}</summary><div id="material-history-list"></div></details>
      </div>`);
    dialog.classList.add('material-dialog');
    const trash = $('#material-trash'), restore = $('#material-restore');
    if (trash) trash.onclick = () => run(() => batch('trash', [{ id, parents: row.heads }]));
    if (restore) restore.onclick = () => run(() => batch('restore', [{ id, parents: row.heads }]));
    dialog.querySelectorAll('[data-material-reference]').forEach(control => control.onclick = () => run(async () => {
      dialog.close(); await openRecord(control.dataset.materialReference);
    }));
    let loaded = false;
    $('#material-history').ontoggle = async event => {
      if (!event.target.open || loaded) return;
      loaded = true;
      const list = dialog.querySelector('#material-history-list');
      try {
        const history = await api('history', { id });
        if (!list.isConnected) return;
        list.innerHTML = `<p class="muted">最近 ${Math.min(50, history.length)} 条记录${row.conflict ? '，请对照后选择要保留的属性' : ''}</p>${history.slice(0, 50).map(version => `<div class="material-history-row"><span><strong>${esc(version.data.title)}</strong><small>${formatTime(version.createdAt)} · ${esc(libraryName(version.data.domain))}${version.deleted ? ' · 回收记录' : ''}${row.heads.includes(version.id) ? ' · 当前分支' : ''}</small><small>${esc(version.data.tags.join(' · '))}${version.data.sensitive ? ' · 敏感' : ''}</small></span><button class="text-button" data-material-version="${version.id}">${row.conflict && row.heads.includes(version.id) ? '保留此属性' : '恢复属性'}</button></div>`).join('')}`;
        list.querySelectorAll('[data-material-version]').forEach(control => control.onclick = () => run(async () => {
          if (!await confirmBox('恢复资料属性', '<p>以所选记录的名称、标签和归属创建新的修改记录；原文件及后续历史仍保留。回收记录恢复后资料将重新可用。</p>', '恢复')) return;
          await api('restoreVersion', { id, revision: control.dataset.materialVersion, parents: row.heads });
          await afterChange('资料属性已恢复，历史仍保留');
        }));
      } catch (error) { loaded = false; list.textContent = error.message; }
    };
  }
  const actions = {
    'material-directory': async target => {
      filters.directory = target.dataset.directory; directoriesOpen = true;
      if ($('#modal').open) $('#modal').close();
      await show();
    },
    'material-directory-clear': async () => { filters.directory = ''; await show(); },
    'material-copy-root': async () => { await navigator.clipboard.writeText(rootDirectory); toast('已复制工作区根目录'); },
    'material-copy-path': target => copyLocation(target.dataset.asset, 'path'),
    'material-copy-directory': target => copyLocation(target.dataset.asset, 'directory'),
    'material-merge': target => merge(target.dataset.asset),
    'material-detail': target => detail(target.dataset.asset),
    'material-edit': target => edit(target.dataset.asset),
    'material-open': target => api('openAsset', { id: target.dataset.asset }),
    'material-active': async () => { filters.trash = false; await show(); },
    'material-trash-view': async () => { filters.trash = true; await show(); },
    'material-clear': async () => { Object.assign(filters, { kind: '', tag: '', availability: '', usage: '', offset: 0, directory: '' }); state.query = ''; $('#search').value = ''; await show(); },
    'material-deselect': () => {
      selected.clear();
      document.querySelectorAll('[data-material-check]').forEach(control => { control.checked = false; });
      selection();
    },
    'material-prev': async () => { filters.offset = Math.max(0, filters.offset - filters.limit); await show(); },
    'material-next': async () => { filters.offset += filters.limit; await show(); },
    'material-batch-tags': () => batch('tags'),
    'material-batch-move': () => batch('move'),
    'material-batch-trash': () => batch('trash'),
    'material-batch-restore': () => batch('restore'),
    'material-restore': target => { const row = rows.find(row => row.id === target.dataset.asset); return batch('restore', [{ id: row.id, parents: row.heads }]); }
  };
  async function copyLocation(id, field) {
    const row = await api('assetDetail', { id });
    if (!row.storage[field]) throw new Error('此资料尚无本机文件位置');
    await navigator.clipboard.writeText(row.storage[field]);
    toast(field === 'path' ? '已复制附件完整路径' : '已复制附件所在文件夹');
  }
  return { show, detail, actions, dispose };
}
