import './startup.css';

export async function startApplication(init) {
  const root = document.querySelector('#app');
  root.classList.add('starting');
  root.innerHTML = '<section class="startup-panel" role="status"><small>FengZaiY · 个人管理系统</small><h1>正在打开本地工作区</h1><p>正在检查本机服务并读取已保存内容…</p></section>';
  try {
    await init();
    root.classList.remove('starting');
  } catch (error) {
    const mismatch = error.code === 'UI_VERSION_MISMATCH';
    root.classList.add('starting');
    root.innerHTML = `<section class="startup-panel" role="alert"><small>FengZaiY · 个人管理系统</small><h1>${mismatch ? '需要重新启动应用' : '工作区暂时无法打开'}</h1><p>${mismatch ? '当前页面和本机服务不是同一版。浏览器预览请重新启动本机预览服务；桌面版请完全退出后重新打开。' : '请确认本机服务仍在运行，再重新加载。如持续失败，可根据下方错误检查启动日志。'}</p><p>已保存资料和本机草稿会保留。</p><details open><summary>错误详情</summary><pre id="startup-error-detail"></pre></details><button class="primary" id="startup-reload" type="button">重新加载</button></section>`;
    document.querySelector('#startup-error-detail').textContent = error.message || '无法连接本机服务';
    document.querySelector('#startup-reload').onclick = () => window.location.reload();
  }
}
