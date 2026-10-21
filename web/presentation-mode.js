import { mountPresentation, pageCurrent } from './presentation-view.js';

export function mountPageMode(panel, { getData, mediaUrl, openNote, editable = true }) {
  const initial = getData();
  if (!initial?.presentation) return null;
  let disposed = false, generation = 0, reading = false, started = false;
  const bar = document.createElement('div'); bar.className = 'presentation-mode';
  bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', '笔记呈现方式');
  const read = document.createElement('button'), edit = document.createElement('button'), status = document.createElement('span');
  read.type = edit.type = 'button'; read.textContent = '交互阅读'; edit.textContent = editable ? '正文编辑' : '知识正文';
  status.className = 'page-state'; status.setAttribute('role', 'status');
  bar.append(read, edit, status); panel.querySelector('.document-heading').after(bar);
  const host = document.createElement('div'); host.className = 'presentation-host'; host.hidden = true; panel.append(host);
  function mode(value) {
    reading = value; panel.classList.toggle('reading-page', value); host.hidden = !value;
    read.setAttribute('aria-pressed', String(value)); edit.setAttribute('aria-pressed', String(!value));
    host._presentation?.destroy(); host.replaceChildren();
    if (value) mountPresentation(host, getData(), { mediaUrl, openNote, onError: () => { if (!disposed) status.textContent = '交互运行失败，可切换正文'; } });
  }
  async function refresh() {
    const stamp = ++generation, current = await pageCurrent(getData()).catch(() => false);
    if (disposed || generation !== stamp) return;
    read.textContent = current ? '交互阅读' : '查看上次页面';
    status.textContent = current ? '' : '页面待更新 · 正文已有新修改';
    if (!started) { started = true; mode(current); }
    else if (!current && reading) mode(false);
  }
  read.onclick = () => mode(true); edit.onclick = () => mode(false);
  void refresh();
  return { refresh, destroy() { disposed = true; generation++; host._presentation?.destroy(); host.remove(); bar.remove(); panel.classList.remove('reading-page'); } };
}
