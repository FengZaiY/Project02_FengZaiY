import fs from 'node:fs';
import path from 'node:path';
import { canonical, check, noSymlink, now, outside, sha } from './util.mjs';

const markerName = '.studyself-library.json';

export function previewEmptyDirectories(store) {
  const events = store.allEvents(), mappings = store.local('libraryDirectories') || {};
  const bindings = store.db.prepare('SELECT path FROM assets').all().map(row => row.path);
  const links = Object.values(store.local('localFileLinks') || {});
  const pending = [...store.db.prepare('SELECT json FROM pending').all(), ...store.db.prepare('SELECT json FROM rejected').all()];
  const tracked = ['hierarchyFiles', 'hierarchyOriginals'].flatMap(key => Object.keys(store.local(key) || {}));
  tracked.push(...(store.local('hierarchyCleanup') || []).map(item => item.relative),
    ...(store.local('permanentDeletionFiles') || []).filter(item => item.state !== 'done').map(item => item.relative));
  const items = Object.entries(mappings).map(([id, name]) => {
    const item = { id, name, reason: '', missing: false };
    try {
      const directory = store.directories.location(name);
      const exists = fs.existsSync(directory);
      item.missing = !exists;
      let domain = id;
      if (exists) {
        check(store.directories.owns(directory, id), '目录标识缺失或归属不明');
        const marker = fs.readFileSync(path.join(directory, markerName));
        domain = JSON.parse(marker).domain;
        item.markerHash = sha(marker);
        const stat = fs.statSync(directory);
        item.identity = [stat.dev, stat.ino, stat.birthtimeMs];
      }
      check(typeof domain === 'string' && domain.length > 0, '目录范围无法核验');
      check(!store.get(id)?.versions.some(event => event.type === 'library' && !event.deleted), '知识库仍在使用，空库目录正常保留');
      check(!events.some(event => event.entityId === id || event.data.domain === domain
        || JSON.stringify(event.data).includes(JSON.stringify(id))), '知识库或相关修改历史仍存在，请先处理回收内容');
      check(!pending.some(row => row.json.includes(JSON.stringify(id)) || row.json.includes(JSON.stringify(domain))), '仍有待处理同步记录');
      check(!(store.local('workspace')?.tabs || []).some(tab => tab.domain === domain || tab.draft?.domain === domain), '仍有相关工作标签，请先关闭');
      check(![...bindings, ...links, ...tracked.map(relative => path.resolve(store.directory, relative))]
        .some(file => !outside(directory, file)), '仍有资料绑定或待处理文件');
      check(!exists || fs.readdirSync(directory).every(name => name === markerName), '目录中仍有文件或子目录，保留不动');
    } catch (error) { item.reason = error.message; }
    return item;
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { eligible: items.filter(item => !item.reason), blocked: items.filter(item => item.reason), token: sha(canonical(items)) };
}

export function cleanEmptyDirectories(store, { confirmed, token } = {}) {
  check(confirmed === true, '清理空目录需要明确确认');
  const preview = previewEmptyDirectories(store);
  check(token === preview.token, '目录或引用已变化，请重新检查后确认', 'CONFLICT');
  const results = [];
  for (const item of preview.eligible) {
    let marker, markerPath;
    try {
      const current = previewEmptyDirectories(store).eligible.find(entry => entry.id === item.id);
      check(current && canonical(current) === canonical(item), '目录或引用已变化，保留等待重新检查');
      const directory = store.directories.location(item.name);
      if (!item.missing) {
        markerPath = path.join(directory, markerName); noSymlink(markerPath);
        marker = fs.readFileSync(markerPath);
        check(sha(marker) === item.markerHash, '目录标识已变化');
        fs.unlinkSync(markerPath);
        // Never recursively remove contents, including files created after the preview.
        fs.rmdirSync(directory);
      }
      const mappings = store.local('libraryDirectories') || {};
      delete mappings[item.id]; store.local('libraryDirectories', mappings);
      results.push({ name: item.name, state: 'done' });
    } catch (error) {
      if (marker && markerPath && fs.existsSync(path.dirname(markerPath))) {
        try { noSymlink(markerPath); fs.writeFileSync(markerPath, marker, { flag: 'wx' }); } catch { /* Preserve any replacement marker. */ }
      }
      results.push({ name: item.name, state: 'blocked', reason: error.message });
    }
    store.local('emptyDirectoryCleanup', { at: now(), results });
  }
  return { results, removed: results.filter(item => item.state === 'done').length, pending: results.filter(item => item.state !== 'done').length };
}
