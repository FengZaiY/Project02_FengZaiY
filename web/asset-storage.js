export function storageTree(storage, selected, { esc, icon }) {
  const root = { name: '工作区根目录', path: storage.root, count: 0, available: 0, children: new Map() };
  const external = { name: '工作区外', path: ':external', count: 0, available: 0, children: new Map() };
  let unbound;
  for (const group of storage.directories) {
    if (!group.path) { unbound = { ...group, name: '尚未下载到本机', path: ':unbound' }; continue; }
    let node = group.withinRoot ? root : external;
    node.count += group.count; node.available += group.available;
    const segments = group.withinRoot ? group.segments : [{ name: group.path, path: group.path }];
    for (const segment of segments) {
      if (!node.children.has(segment.path)) node.children.set(segment.path, { ...segment, count: 0, available: 0, children: new Map() });
      node = node.children.get(segment.path);
      node.count += group.count; node.available += group.available;
    }
  }
  const render = node => {
    const children = [...(node.children?.values() || [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const control = `<button type="button" class="material-directory${selected === node.path ? ' selected' : ''}" data-action="material-directory" data-directory="${esc(node.path)}" aria-pressed="${selected === node.path}" title="${esc(node.path.startsWith(':') ? node.name : node.path)}">${icon(node.path === ':unbound' ? 'cloud-download' : 'folder')}<span>${esc(node.name)}</span><small>${node.count} 项${node.available < node.count && node.path !== ':unbound' ? ` · ${node.count - node.available} 项不可用` : ''}</small></button>`;
    return children.length ? `<li><details open><summary>${icon('chevron-right')}${control}</summary><ul>${children.map(render).join('')}</ul></details></li>` : `<li>${control}</li>`;
  };
  return `<ul class="material-directory-tree">${[root, ...(external.count ? [external] : []), ...(unbound ? [unbound] : [])].map(render).join('')}</ul>`;
}

export function storageLocation(storage, { esc, icon }) {
  if (!storage.path) return '<small class="material-location muted">尚未下载到本机</small>';
  const status = storage.state === 'missing' ? ' · 文件缺失' : storage.state === 'changed' ? ' · 文件异常' : '';
  const directory = storage.withinRoot ? storage.relativeDirectory || '工作区根目录' : storage.directory;
  return `<button class="material-location" data-action="material-directory" data-directory="${esc(storage.directory)}" title="${esc(storage.path)}">${icon('folder')}<span>${esc(directory)}<small>${esc(storage.label)}${status}</small></span></button>`;
}
