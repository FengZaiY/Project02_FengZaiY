import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Service } from './service.mjs';
import { CONTENT_TYPES } from './catalog.mjs';
import { atomicWrite, check, hashFile, noSymlink, outside, uuid } from './util.mjs';
import { lockFile, workspaceLock } from './workspace-lock.mjs';

const databaseName = 'knowledge.sqlite';
const incompleteName = '.studyself-incomplete.json';
const separate = (a, b) => outside(a, b) && outside(b, a);
const localValue = (db, key) => JSON.parse(db.prepare('SELECT value FROM local_config WHERE key=?').get(key)?.value || 'null');

function directoryPath(value) {
  check(typeof value === 'string' && value.trim() && path.isAbsolute(value), '请选择本机绝对目录路径');
  check(!value.startsWith('\\\\') && !value.startsWith('//'), '工作区必须保存在本机磁盘，不能使用网络共享路径');
  const directory = path.resolve(value);
  check(directory !== path.parse(directory).root, '请选择磁盘中的专用文件夹，不能使用磁盘根目录');
  noSymlink(directory);
  if (fs.existsSync(directory)) check(fs.statSync(directory).isDirectory(), '请选择文件夹');
  return directory;
}

function checkBoundaries(db, target) {
  const sync = localValue(db, 'syncFolder');
  if (sync) check(separate(sync, target), '本地存储目录与同步目录不能互相包含');
  for (const item of localValue(db, 'backups') || []) {
    check(separate(item.directory, target), '本地存储目录与已有备份目录不能互相包含');
  }
}

function inspectDatabase(directory, environment) {
  directoryPath(directory);
  check(!fs.existsSync(path.join(directory, incompleteName)), '该目录包含未完成迁移，不能作为工作区打开');
  const file = path.join(directory, databaseName);
  check(fs.existsSync(file), '该目录没有 StudySelf 工作区，请选择包含 knowledge.sqlite 的文件夹');
  noSymlink(file);
  noSymlink(path.join(directory, 'device-vault.key'));
  check((fs.existsSync(path.join(directory, 'device-vault.key')) ? 'preview' : 'desktop') === environment,
    '此工作区的凭据加密环境不同，请在原来的桌面版或预览环境中打开');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    check(Object.values(db.prepare('PRAGMA quick_check').get())[0] === 'ok', '工作区数据库校验失败');
    for (const table of ['meta', 'events', 'heads', 'pending', 'rejected', 'packets', 'receipts', 'assets', 'local_config']) {
      check(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), '不是完整的 StudySelf 工作区');
    }
    const deviceId = db.prepare("SELECT value FROM meta WHERE key='deviceId'").get()?.value;
    check(deviceId, '工作区缺少设备标识');
    checkBoundaries(db, directory);
    const counts = db.prepare("SELECT type, COUNT(DISTINCT entity_id) AS count FROM events WHERE id IN (SELECT event_id FROM heads) AND json_extract(json, '$.deleted')=0 GROUP BY type").all();
    const libraryCount = db.prepare(`SELECT COUNT(DISTINCT json_extract(e.json, '$.data.domain')) AS count
      FROM events e JOIN heads h ON h.event_id=e.id WHERE json_extract(e.json, '$.data.domain')<>'__all_libraries__'
      AND (e.type IN (${CONTENT_TYPES.map(() => '?').join(',')}) OR (e.type='library' AND json_extract(e.json, '$.deleted')=0))`).get(...CONTENT_TYPES).count;
    return { directory, deviceId, counts: { ...Object.fromEntries(counts.map(row => [row.type, row.count])), library: libraryCount } };
  } finally { db.close(); }
}

async function copyTree(source, target, root = true) {
  const excluded = new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`, `${databaseName}-journal`,
    '.studyself-lock.json', incompleteName, 'electron-profile', 'incoming', 'opened-files']);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (root && excluded.has(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    noSymlink(from); noSymlink(to);
    if (entry.isDirectory()) { fs.mkdirSync(to); await copyTree(from, to, false); }
    else {
      check(entry.isFile(), '工作区含不支持的特殊文件');
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(to, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      check(await hashFile(from) === await hashFile(to), '文件复制校验失败，原目录保持不变');
    }
  }
}

async function migrate(source, target) {
  const releaseSource = workspaceLock(source);
  let releaseTarget, writer, reader;
  try {
    check(!fs.existsSync(target) || fs.readdirSync(target).length === 0, '迁移目标必须是空文件夹，不会覆盖已有内容');
    releaseTarget = workspaceLock(target);
    atomicWrite(path.join(target, incompleteName), JSON.stringify({ source, id: uuid() }));
    writer = new DatabaseSync(path.join(source, databaseName));
    writer.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    // Keep writers out while SQLite produces a WAL-aware snapshot and owned files are verified.
    reader = new DatabaseSync(path.join(source, databaseName), { readOnly: true });
    await backup(reader, path.join(target, databaseName));
    await copyTree(source, target);
    const copied = new DatabaseSync(path.join(target, databaseName));
    try {
      copied.exec('BEGIN IMMEDIATE');
      const remap = file => outside(source, file) ? file : path.join(target, path.relative(source, file));
      for (const row of copied.prepare('SELECT id,path FROM assets').all()) {
        const location = remap(row.path);
        if (fs.existsSync(row.path)) {
          const event = copied.prepare("SELECT json FROM events WHERE entity_id=? AND type='asset' LIMIT 1").get(row.id);
          const data = event && JSON.parse(event.json).data;
          check(data && fs.statSync(location).size === data.size && await hashFile(location) === data.sha256, '附件完整性校验失败');
        }
        copied.prepare('UPDATE assets SET path=? WHERE id=?').run(location, row.id);
      }
      const links = localValue(copied, 'localFileLinks');
      if (links) copied.prepare('UPDATE local_config SET value=? WHERE key=?').run(JSON.stringify(Object.fromEntries(
        Object.entries(links).map(([id, file]) => [id, remap(file)]))), 'localFileLinks');
      check(Object.values(copied.prepare('PRAGMA integrity_check').get())[0] === 'ok', '迁移后数据库校验失败');
      copied.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { copied.close(); }
    // An incomplete copy is never offered as an existing workspace.
  } finally {
    reader?.close();
    if (writer) { if (writer.isTransaction) writer.exec('ROLLBACK'); writer.close(); }
    releaseTarget?.(); releaseSource();
  }
}

export class StorageLocation {
  constructor(anchor, { environment = 'preview', configPath } = {}) {
    this.anchor = directoryPath(anchor);
    this.environment = environment;
    this.configPath = configPath || `${this.anchor}.storage.json`;
    noSymlink(this.configPath);
    this.config = fs.existsSync(this.configPath) ? JSON.parse(fs.readFileSync(this.configPath, 'utf8')) : { format: 1, directory: this.anchor };
    check(this.config.format === 1, '不支持的本地存储配置');
    this.config.directory = directoryPath(this.config.directory);
    this.current = this.config.directory;
  }
  status() {
    return { directory: this.current, pending: this.config.pending || null, error: this.config.error || null,
      lastChange: this.config.lastChange || null, restartRequired: !!this.config.pending };
  }
  write(config) { atomicWrite(this.configPath, JSON.stringify(config, null, 2)); this.config = config; }
  inspect(input) {
    const target = directoryPath(input.directory);
    check(['select', 'migrate', 'open'].includes(input.mode), '请选择根目录、迁移或打开已有工作区');
    const mode = input.mode === 'select' ? (fs.existsSync(path.join(target, databaseName)) ? 'open' : 'migrate') : input.mode;
    check(separate(this.current, target), '请选择与当前工作区互不包含的其他目录');
    check(outside(target, this.configPath), '目标目录不能包含本机启动配置');
    checkBoundaries(this.service.store.db, target);
    if (mode === 'migrate') {
      check(!fs.existsSync(target) || fs.readdirSync(target).length === 0, '迁移目标必须是空文件夹，不会覆盖已有内容');
      const snapshot = this.service.state();
      return { mode, directory: target, counts: { ...snapshot.counts,
        library: snapshot.libraries.filter(item => !item.deleted || item.contentCount > 0).length } };
    }
    check(fs.existsSync(path.join(target, databaseName)), '该目录没有 StudySelf 工作区，请选择包含 knowledge.sqlite 的文件夹');
    const release = workspaceLock(target);
    try { return { mode, ...inspectDatabase(target, this.environment) }; }
    finally { release(); }
  }
  schedule(input) {
    check(!(this.service.store.local('workspace')?.tabs || []).some(tab => tab.dirty), '请先保存或关闭未保存的笔记标签');
    const result = this.inspect(input);
    this.write({ ...this.config, error: null, pending: { ...result, source: this.current, sourceDeviceId: this.service.store.deviceId } });
    return this.status();
  }
  cancel() { this.write({ ...this.config, pending: null, error: null }); return this.status(); }
  async open(options = {}) {
    this.releaseConfig = lockFile(`${this.configPath}.lock`);
    let candidate;
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        check(this.config.format === 1, '不支持的本地存储配置');
        this.current = directoryPath(this.config.directory);
        inspectDatabase(this.current, this.environment);
      } else if (fs.existsSync(path.join(this.current, databaseName)) || fs.existsSync(path.join(this.current, incompleteName))) {
        inspectDatabase(this.current, this.environment);
      } else if (fs.existsSync(this.current)) {
        check(fs.readdirSync(this.current).every(name => name === 'electron-profile'), '目录非空且没有工作区数据库，不会在此创建空库');
      }
      const pending = this.config.pending;
      if (pending) {
        try {
          check(pending.source === this.current, '待生效变更与当前工作区不一致');
          check(inspectDatabase(this.current, this.environment).deviceId === pending.sourceDeviceId, '原工作区已被替换，已取消变更');
          // Revalidate the request against current files, not the earlier UI preview.
          const db = new DatabaseSync(path.join(this.current, databaseName), { readOnly: true });
          try { checkBoundaries(db, directoryPath(pending.directory)); } finally { db.close(); }
          check(separate(this.current, pending.directory) && outside(pending.directory, this.configPath), '目标目录与当前工作区或启动配置重叠');
          if (pending.mode === 'migrate') await migrate(this.current, pending.directory);
          else {
            check(pending.mode === 'open', '无效的存储操作');
            check(inspectDatabase(pending.directory, this.environment).deviceId === pending.deviceId, '目标工作区已被替换，请重新选择');
          }
          candidate = new Service(pending.directory, { ...options, storage: this });
          await candidate.ready;
          // Rename/write failure keeps the old startup pointer and the source intact.
          if (pending.mode === 'migrate') fs.unlinkSync(path.join(pending.directory, incompleteName));
          this.write({ format: 1, directory: pending.directory, pending: null,
            lastChange: { mode: pending.mode, previous: this.current, at: new Date().toISOString() } });
          this.current = pending.directory;
          this.service = candidate;
          return candidate;
        } catch (error) {
          candidate?.close(); candidate = null;
          const fallback = { ...this.config, directory: this.current, pending: null, error: `存储位置未更改：${error.message}` };
          try { this.write(fallback); }
          catch (settingsError) {
            // A failed failure-report write must not prevent opening the intact source.
            this.config = { ...fallback, error: `${fallback.error}；无法保存启动配置：${settingsError.message}` };
          }
        }
      }
      this.service = new Service(this.current, { ...options, storage: this });
      await this.service.ready;
      return this.service;
    } catch (error) { this.releaseConfig(); this.releaseConfig = null; throw error; }
  }
  close() { this.releaseConfig?.(); this.releaseConfig = null; }
}
