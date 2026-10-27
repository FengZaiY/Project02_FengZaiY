import { libraryMarkerPath, legacyNames } from './legacy-names.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, check, hashFile, inside, noSymlink, outside, sha } from './util.mjs';
import { workspaceLock } from './workspace-lock.mjs';

function previousRoot(storage) {
  check(storage.config.lastChange?.mode === 'migrate', '没有可清理的迁移旧目录');
  const root = path.resolve(storage.config.lastChange.previous);
  check(outside(root, storage.current) && outside(storage.current, root) && outside(root, storage.configPath), '旧目录与当前工作区或启动配置重叠');
  noSymlink(root);
  const sync = storage.service.store.local('syncFolder');
  check(!sync || outside(sync, root) && outside(root, sync), '旧目录与同步目录重叠，不能清理');
  return root;
}

async function inventory(storage, root) {
  if (storage.config.previousCleanup) {
    check(storage.config.previousCleanup.directory === root, '旧目录清理记录与当前迁移不匹配');
    return storage.config.previousCleanup;
  }
  const database = inside(root, 'knowledge.sqlite'); noSymlink(database);
  const db = new DatabaseSync(database, { readOnly: true });
  const candidates = new Map(), protectedFiles = [];
  const local = key => JSON.parse(db.prepare('SELECT value FROM local_config WHERE key=?').get(key)?.value || 'null');
  const add = (relative, hash, database = false) => candidates.set(relative, { relative, hash, database });
  try {
    check(db.prepare("SELECT value FROM meta WHERE key='deviceId'").get()?.value === storage.service.store.deviceId, '旧工作区身份已变化');
    check(!(local('workspace')?.tabs || []).some(tab => tab.dirty), '旧目录存在未保存编辑，请先处理后再清理');
    const erased = new Map(storage.service.store.erasures().flatMap(receipt => receipt.versions.map(version => [version.id, version.hash])));
    for (const row of db.prepare('SELECT json FROM events').all()) {
      const event = JSON.parse(row.json), current = storage.service.store.event(event.id);
      check(current?.hash === event.hash || erased.get(event.id) === event.hash, '旧目录存在当前工作区没有的修改，禁止清理');
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='erasures'").get()) {
      const current = new Set(storage.service.store.erasures().map(receipt => receipt.hash));
      check(db.prepare('SELECT json FROM erasures').all().every(row => current.has(JSON.parse(row.json).hash)), '旧目录存在尚未同步的永久删除，禁止清理');
    }
    for (const table of ['pending', 'rejected']) for (const row of db.prepare(`SELECT id,json FROM ${table}`).all()) {
      const event = JSON.parse(row.json), current = storage.service.store.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(row.id);
      check(current?.json === row.json || storage.service.store.event(row.id)?.hash === event.hash || erased.get(row.id) === event.hash,
        '旧目录存在当前工作区没有的待处理修改，禁止清理');
    }
    for (const [relative, hash] of Object.entries(local('hierarchyFiles') || {})) add(relative, hash);
    for (const [relative, hash] of Object.entries(local('hierarchyOriginals') || {})) add(relative, hash);
    for (const row of db.prepare('SELECT id,path FROM assets').all()) {
      if (outside(root, row.path)) continue;
      const event = db.prepare("SELECT json FROM events WHERE entity_id=? AND type='asset' LIMIT 1").get(row.id);
      if (event) {
        const hash = JSON.parse(event.json).data.sha256, relative = path.relative(root, row.path);
        const managed = (local('hierarchyOriginals') || {})[relative] === hash
          || ['objects', 'received-objects'].some(folder => relative === path.join(folder, hash))
          || Object.values(local('libraryDirectories') || {}).some(folder => relative === path.join(folder, 'attachments', hash));
        if (managed) add(relative, hash);
      }
    }
    for (const [id, name] of Object.entries(local('libraryDirectories') || {})) {
      check(typeof name === 'string' && path.basename(name) === name, '旧知识库目录映射无效');
      const marker = libraryMarkerPath(inside(root, name)); noSymlink(marker);
      if (fs.existsSync(marker)) {
        const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
        check(value.format === 1 && value.libraryId === id, '旧目录归属已变化');
        add(path.relative(root, marker));
      }
    }
  } finally { db.close(); }
  for (const relative of ['device-vault.key', 'knowledge.sqlite', 'knowledge.sqlite-wal', 'knowledge.sqlite-shm']) {
    if (fs.existsSync(inside(root, relative))) add(relative, undefined, true);
  }
  const files = [];
  for (const item of candidates.values()) {
    const file = inside(root, item.relative); noSymlink(file);
    if (!fs.existsSync(file)) continue;
    check(fs.statSync(file).isFile(), '旧目录中存在非普通文件');
    const hash = await hashFile(file);
    if (item.hash && item.hash !== hash) { protectedFiles.push({ relative: item.relative, reason: '内容已被外部修改' }); continue; }
    files.push({ ...item, hash, bytes: fs.statSync(file).size });
  }
  // Database destruction is allowed only when no managed file has changed outside the app.
  check(!protectedFiles.length, `旧目录有 ${protectedFiles.length} 个被修改文件，请先保留修改副本，暂不清理`);
  return { directory: root, files: files.sort((a, b) => Number(a.database) - Number(b.database) || a.relative.localeCompare(b.relative)), protectedFiles };
}

export async function previewPrevious(storage) {
  const root = previousRoot(storage), release = workspaceLock(root);
  try {
    const plan = await inventory(storage, root);
    return { ...plan, bytes: plan.files.reduce((sum, file) => sum + file.bytes, 0), token: sha(canonical(plan)) };
  } finally { release(); }
}

export async function cleanPrevious(storage, { token, confirmed } = {}) {
  check(confirmed === true, '清理旧目录需要单独明确确认');
  check(!storage.config.pending, '请先处理待生效的根目录变更');
  const root = previousRoot(storage), release = workspaceLock(root);
  try {
    const plan = await inventory(storage, root);
    check(token === sha(canonical(plan)), '旧目录已变化，请重新预览', 'CONFLICT');
    // Persist the allowlist before deletion; interrupted operations never broaden their scope.
    storage.write({ ...storage.config, previousCleanup: plan });
    for (const item of plan.files) {
      const file = inside(root, item.relative); noSymlink(file);
      if (!fs.existsSync(file)) continue;
      const before = fs.statSync(file);
      check(await hashFile(file) === item.hash, '旧目录文件已变化，已停止清理');
      noSymlink(file);
      const after = fs.statSync(file);
      check(after.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs && before.ino === after.ino, '旧目录文件在校验期间变化，已停止清理');
      fs.unlinkSync(file);
      let parent = path.dirname(file);
      while (parent !== root && !outside(root, parent)) {
        noSymlink(parent);
        if (fs.readdirSync(parent).length) break;
        fs.rmdirSync(parent); parent = path.dirname(parent);
      }
    }
    storage.write({ ...storage.config, previousCleanup: null, lastChange: { ...storage.config.lastChange, cleaned: true } });
    return { cleaned: true, extraFilesRetained: fs.readdirSync(root).filter(name => !['.fengzaiy-lock.json', legacyNames.workspaceLock].includes(name)).length > 0 };
  } finally { release(); }
}
