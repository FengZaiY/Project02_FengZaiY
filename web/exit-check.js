export function installExitCheck({ bridge, api, snapshot, save, persist, openModal, esc, showSync, toast }) {
  if (!bridge?.onExitRequest) return;
  let current = null;
  bridge.onExitRequest(async ({ id, intent }) => {
    const restarting = intent === 'storage-restart', action = restarting ? '重启' : '退出';
    if (current?.id === id) return;
    if (document.querySelector('dialog[open]')) {
      await api('exitCancel', { id }).catch(() => {});
      toast('请先完成或取消当前编辑窗口，再退出', true); return;
    }
    const request = { id, saving: false, error: '', backend: null };
    current = request;
    const dialog = openModal(restarting ? '重启并应用存储变更' : '退出 FengZai·Y', `<div id="exit-check-status" aria-live="polite">正在检查保存状态…</div><p id="exit-check-error" class="notice danger" role="alert" hidden></p>`,
      '<button class="secondary" id="exit-continue">继续使用</button><button class="secondary" id="exit-sync">查看同步</button><button class="primary" id="exit-confirm" disabled>正在检查…</button>');
    const find = selector => dialog.querySelector(selector);
    const refresh = () => {
      if (current !== request || !dialog.open) return;
      try {
        const status = snapshot(), pending = status.notes.filter(note => note.state !== 'saved');
        const blockers = [status.preferenceDirty && '整理偏好尚未保存，请返回系统设置处理',
          status.importing && '资料仍在导入，请稍后重试', status.composing && '输入法仍在编辑，请完成输入后重试',
          pending.some(note => note.state === 'conflict') && '存在版本冲突，请返回对应笔记处理', request.backend?.busy].filter(Boolean);
        const sync = request.backend?.sync;
        const markup = `<h3>本地保存</h3><p>${pending.length ? `${pending.length} 项内容尚未完成保存` : status.notes.length ? `${status.notes.length} 项内容均已保存` : '没有待保存的内容'}</p>
          ${pending.length ? `<ul>${pending.map(note => `<li class="storage-path">${esc(note.title)}：${({ queued: '待保存', saving: '保存中', error: '保存失败', conflict: '待处理冲突' })[note.state] || '待保存'}</li>`).join('')}</ul>` : ''}
          ${blockers.map(reason => `<p class="notice amber">${esc(reason)}</p>`).join('')}
          <h3>多电脑同步</h3><p>${!request.backend ? '正在检查…' : sync ? `${sync.pendingChanges} 条已保存修改未发布 · ${sync.unconfirmed} 次发布尚未人工确认上传${sync.unfinished ? ' · 发布批次尚未完成，进度已保留' : ''}` : '同步状态暂时无法读取'}</p>
          <p class="muted">${restarting ? '重启后应用已确认的目录变更，迁移时保留原目录。' : '退出只保留本地内容。'}不会自动发布，百度上传完成状态仍需在百度客户端查看。</p>`;
        if (request.markup !== markup) { find('#exit-check-status').innerHTML = markup; request.markup = markup; }
        const confirm = find('#exit-confirm');
        confirm.disabled = request.saving || !request.backend || blockers.length > 0;
        confirm.textContent = request.saving ? '正在保存并检查…' : pending.some(note => note.state === 'error') ? `重试保存后${action}` : pending.length ? `保存后${action}` : action;
        find('#exit-check-error').textContent = request.error;
        find('#exit-check-error').hidden = !request.error;
      } catch (error) { find('#exit-check-error').textContent = error.message; find('#exit-check-error').hidden = false; find('#exit-confirm').disabled = true; }
    };
    const timer = setInterval(refresh, 400);
    const poll = setInterval(() => {
      if (current !== request || request.saving || request.polling) return;
      request.polling = api('exitStatus', { id }).then(value => { request.backend = value; })
        .catch(error => { request.error = error.message; request.backend = null; })
        .finally(() => { request.polling = null; refresh(); });
    }, 1200);
    dialog.addEventListener('close', () => {
      clearInterval(timer); clearInterval(poll);
      if (current === request) current = null;
      void api('exitCancel', { id }).catch(() => {});
    }, { once: true });
    find('#exit-continue').onclick = () => dialog.close();
    find('#exit-sync').onclick = async () => { dialog.close(); try { await showSync(); } catch (error) { toast(error.message, true); } };
    find('#exit-confirm').onclick = async () => {
      request.saving = true; request.error = ''; refresh();
      try {
        await request.polling;
        if (current !== request) return;
        await save();
        if (current !== request) return;
        await persist();
        if (current !== request) return;
        const latest = snapshot();
        if (latest.notes.some(note => note.state !== 'saved') || latest.preferenceDirty || latest.importing || latest.composing) throw new Error('仍有未完成的编辑，请返回处理');
        request.backend = await api('exitStatus', { id });
        if (current !== request) return;
        await api('exitFinish', { id, rendererReady: true });
      } catch (error) { request.error = error.message; }
      finally { request.saving = false; refresh(); }
    };
    try { request.backend = await api('exitStatus', { id }); }
    catch (error) { request.error = error.message; }
    refresh();
  });
}
