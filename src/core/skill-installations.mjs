import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, uuid, now, sha, canonical, atomicWrite, outside } from './util.mjs';
import { lockFile } from './workspace-lock.mjs';

const names = ['SKILL.md', 'references/preferences.md', 'references/api.md', 'scripts/client.mjs', 'manifest.json'];
const marker = '.studyself-install.json';
const key = 'skillInstallations';
const source = fileURLToPath(new URL('../../skills/studyself-organize', import.meta.url));
const digest = files => sha(canonical(files));
const revision = record => digest({ id: record.id, directory: record.directory, marker: record.marker, mode: record.mode,
  hashes: record.hashes, backup: record.backup || null, journal: record.journal || null, updatedAt: record.updatedAt || null });
const hashes = files => Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value === null ? null : sha(Buffer.from(value, 'base64'))]));

// Only fixed package files are read or written; extra files in the chosen installation stay untouched.
function safePath(file) {
  let current = path.resolve(file);
  while (true) {
    try { check(!fs.lstatSync(current).isSymbolicLink(), '安装路径包含链接，请选择实际目录'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function readFile(file) {
  safePath(file);
  let stat;
  try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  check(stat.isFile() && stat.size <= 1024 * 1024 && stat.nlink === 1, 'Skill 文件类型、大小或硬链接不受支持');
  return fs.readFileSync(file).toString('base64');
}
function snapshot(directory) {
  const files = Object.fromEntries(names.map(name => [name, readFile(path.join(directory, name))]));
  check(Object.values(files).reduce((size, value) => size + (value?.length || 0), 0) <= 3 * 1024 * 1024, '安装文件过大，无法安全更新');
  return files;
}
function writeFile(directory, name, value) {
  check(names.includes(name), '不支持的 Skill 文件');
  const file = path.join(directory, name); safePath(file);
  if (value === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
  else atomicWrite(file, Buffer.from(value, 'base64'));
}
function packageFiles(bundle) {
  check(!bundle.preferences.conflict, '整理偏好存在冲突，请先合并', 'CONFLICT');
  const files = { ...bundle.files,
    'references/preferences.md': `${bundle.preferences.baseline}\n\n## 用户补充（导出快照）\n\n${bundle.preferences.content || '暂无补充'}\n\n偏好版本：${bundle.preferences.version}\n`,
    'manifest.json': JSON.stringify({ name: 'studyself-organize', protocolVersion: 1, skillVersion: bundle.skillVersion,
      preferencesVersion: bundle.preferences.version, exportVersion: bundle.exportVersion }, null, 2) };
  check(Object.keys(files).length === names.length && names.every(name => typeof files[name] === 'string'), '内置 Skill 文件契约已变化，请升级安装更新器');
  return Object.fromEntries(names.map(name => [name, Buffer.from(files[name]).toString('base64')]));
}

export class SkillInstallations {
  constructor(store, agents) { this.store = store; this.agents = agents; this.previews = new Map(); this.nextCheck = 0; }
  records() { return this.store.local(key) || []; }
  save(record) { this.store.local(key, this.records().map(item => item.id === record.id ? record : item)); }
  target(directory) {
    check(typeof directory === 'string' && path.isAbsolute(directory), '请选择已安装 Skill 的完整目录');
    check(!directory.startsWith('\\\\') && !directory.startsWith('//'), '请选择本机目录，不支持网络共享路径');
    directory = path.resolve(directory); safePath(directory);
    check(fs.statSync(directory).isDirectory() && path.basename(directory).toLowerCase() === 'studyself-organize', '请选择已有的 studyself-organize 文件夹');
    for (const protectedRoot of [source, this.store.directory, this.store.local('syncFolder')].filter(Boolean)) {
      check(outside(protectedRoot, directory) && outside(directory, protectedRoot), '不能关联系统内置 Skill、工作区或同步目录');
    }
    return directory;
  }
  owned(record) {
    this.target(record.directory);
    const value = readFile(path.join(record.directory, marker));
    check(value && Buffer.from(value, 'base64').toString() === record.marker, '安装归属已变化，请重新核对关联', 'CONFLICT');
  }
  identity(files) {
    check(files['SKILL.md'] !== null, '安装目录缺少 SKILL.md 入口文件，请先重新安装或补全 Skill');
    const content = Buffer.from(files['SKILL.md'] || '', 'base64').toString();
    const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    check(front && /^name: studyself-organize\r?$/m.test(front), 'SKILL.md 的名称或头部不匹配，不是 StudySelf Skill 安装');
  }
  public(record) {
    return { id: record.id, directory: record.directory, mode: record.mode, status: record.status,
      version: record.version || null, checkedAt: record.checkedAt, updatedAt: record.updatedAt,
      error: record.error || null, changedFiles: record.changedFiles || [], missingFiles: record.missingFiles || [],
      canRestore: !!record.backup || !!record.journal };
  }
  summary() {
    const records = this.records();
    return { total: records.length, attention: records.filter(item => item.status !== 'current').length };
  }
  list() { return this.records().map(item => this.public(item)); }
  recover(record) {
    if (!record.journal) return;
    this.owned(record);
    const { before, after } = record.journal, current = snapshot(record.directory);
    check(names.every(name => current[name] === before[name] || current[name] === after[name]), '更新中断后文件又被修改，已暂停恢复，请保留现场并处理', 'CONFLICT');
    for (const name of [...names].reverse()) {
      this.owned(record);
      check(readFile(path.join(record.directory, name)) === current[name], '恢复期间文件发生变化，请重新检查', 'CONFLICT');
      if (current[name] !== before[name]) writeFile(record.directory, name, before[name]);
    }
    record.journal = record.journal.previous || null; record.mode = 'manual'; record.error = '上次更新中断，已恢复本次写入前文件；自动更新已暂停';
    record.status = 'error'; this.save(record);
  }
  inspect(record, bundle) {
    this.owned(record);
    const files = snapshot(record.directory);
    // A matching ownership marker allows an existing installation to be diagnosed without its entry file.
    if (files['SKILL.md'] !== null) this.identity(files);
    const currentHashes = hashes(files);
    record.missingFiles = names.filter(name => files[name] === null);
    record.changedFiles = names.filter(name => currentHashes[name] !== record.hashes[name]);
    if (record.missingFiles.length) record.status = 'incomplete';
    else if (record.changedFiles.length) record.status = 'modified';
    else if (bundle.preferences.conflict) record.status = 'conflict';
    else record.status = digest(files) === digest(packageFiles(bundle)) ? 'current' : 'outdated';
    record.checkedAt = now(); record.error = null; this.save(record);
    return files;
  }
  check({ automatic = false } = {}) {
    const bundle = this.agents.skillPackage();
    for (const record of this.records()) {
      let release;
      try {
        this.owned(record); release = lockFile(path.join(record.directory, '.studyself-update.lock'));
        if (record.journal) { this.recover(record); continue; }
        const files = this.inspect(record, bundle);
        if (automatic && record.mode === 'auto' && record.status === 'outdated') this.write(record, files, packageFiles(bundle), bundle.exportVersion);
      } catch (error) { record.status = 'error'; record.missingFiles = []; record.error = error.message; record.checkedAt = now(); this.save(record); }
      finally { release?.(); }
    }
    return this.list();
  }
  tick() {
    if (Date.now() < this.nextCheck) return;
    this.nextCheck = Date.now() + 60000;
    this.check({ automatic: true });
  }
  preview({ directory, id, action = 'link' }) {
    check(['link', 'update', 'repair', 'restore'].includes(action), '不支持的安装操作');
    const record = id ? this.records().find(item => item.id === id) : null;
    check(action === 'link' ? !id : !!record, '安装关联不存在');
    const target = this.target(record?.directory || directory);
    if (action === 'link') {
      check(this.records().length < 20, '最多关联 20 个安装位置');
      check(!this.records().some(item => item.directory.toLowerCase() === target.toLowerCase()), '该位置已经关联');
      check(!readFile(path.join(target, marker)), '此安装由另一个工作区管理，请先在原工作区解除关联');
    } else { this.owned(record); check(action === 'restore' || !record.journal, '上次更新尚未恢复，请先检查更新或恢复文件'); }
    const before = snapshot(target);
    const missing = names.filter(name => before[name] === null);
    if (action === 'repair') check(missing.length, '安装文件已补全，请重新检查更新', 'CONFLICT');
    if (action !== 'restore' && !(action === 'repair' && before['SKILL.md'] === null)) this.identity(before);
    const bundle = this.agents.skillPackage();
    const after = action === 'restore' ? record.journal?.before || record.backup?.files : packageFiles(bundle);
    check(after, '尚无可恢复的副本');
    const value = { action, id, directory: target, before, after, version: bundle.exportVersion,
      recordDigest: record ? revision(record) : null, createdAt: Date.now() };
    const token = uuid();
    for (const [old, item] of this.previews) if (Date.now() - item.createdAt > 300000) this.previews.delete(old);
    check(this.previews.size < 100, '待确认操作过多，请稍后再试'); this.previews.set(token, value);
    return { token, directory: target, action, missing, targetMissing: names.filter(name => after[name] === null),
      files: names.filter(name => before[name] !== after[name]),
      modified: record ? names.filter(name => hashes(before)[name] !== record.hashes[name]) : [], version: value.version };
  }
  confirm({ token, confirmed }) {
    check(confirmed === true, '请先确认安装操作');
    const preview = this.previews.get(token);
    check(preview && Date.now() - preview.createdAt <= 300000, '预览已失效，请重新检查', 'CONFLICT');
    this.previews.delete(token);
    const { action, directory, before, after } = preview;
    this.target(directory);
    const release = lockFile(path.join(directory, '.studyself-update.lock'));
    try {
      check(digest(snapshot(directory)) === digest(before), '安装文件已变化，请重新预览', 'CONFLICT');
      check(this.agents.skillPackage().exportVersion === preview.version, '系统 Skill 或偏好已变化，请重新预览', 'CONFLICT');
      if (action === 'link') {
        check(this.records().length < 20, '最多关联 20 个安装位置');
        check(!readFile(path.join(directory, marker)) && !this.records().some(item => item.directory.toLowerCase() === directory.toLowerCase()), '安装已被关联，请重新检查', 'CONFLICT');
        const id = uuid(), record = { id, directory, mode: 'manual', hashes: hashes(before), status: 'outdated', marker: JSON.stringify({ v: 1, id }) };
        atomicWrite(path.join(directory, marker), record.marker);
        try { this.store.local(key, [...this.records(), record]); }
        catch (error) { fs.unlinkSync(path.join(directory, marker)); throw error; }
        this.inspect(record, this.agents.skillPackage()); return this.public(record);
      }
      const record = this.records().find(item => item.id === preview.id);
      check(record && revision(record) === preview.recordDigest, '关联设置已变化，请重新预览', 'CONFLICT');
      this.owned(record);
      if (action === 'restore') record.mode = 'manual';
      this.write(record, before, after, action === 'restore' ? record.journal ? record.version : record.backup.version : preview.version);
      return this.public(record);
    } finally { release(); }
  }
  write(record, before, after, version) {
    record.journal = { before, after, ...(record.journal ? { previous: record.journal } : {}) }; this.save(record);
    try {
      for (const name of names) {
        this.owned(record);
        check(readFile(path.join(record.directory, name)) === before[name], '更新期间安装文件发生变化', 'CONFLICT');
        if (before[name] !== after[name]) writeFile(record.directory, name, after[name]);
      }
      check(digest(snapshot(record.directory)) === digest(after), '更新后校验失败', 'CONFLICT');
      const oldVersion = record.version;
      record.hashes = hashes(after); record.version = version; record.updatedAt = now(); record.checkedAt = now();
      record.backup = { files: before, version: oldVersion || null }; record.journal = null; record.error = null; record.changedFiles = [];
      record.missingFiles = names.filter(name => after[name] === null);
      const bundle = this.agents.skillPackage();
      record.status = record.missingFiles.length ? 'incomplete' : bundle.preferences.conflict ? 'conflict' : digest(after) === digest(packageFiles(bundle)) ? 'current' : 'outdated';
      this.save(record);
    } catch (error) {
      // The persisted journal remains authoritative even if the final database write failed.
      const persisted = this.records().find(item => item.id === record.id);
      try { this.recover(persisted); } catch (recovery) { persisted.error = `${error.message}；${recovery.message}`; }
      persisted.status = 'error'; persisted.error ||= error.message; persisted.mode = 'manual'; this.save(persisted);
      Object.assign(record, persisted); throw error;
    }
  }
  configure({ id, mode, confirmed }) {
    check(confirmed === true && ['manual', 'auto'].includes(mode), '请确认更新模式');
    const record = this.records().find(item => item.id === id); check(record, '安装关联不存在');
    this.owned(record); check(!record.journal, '请先处理未完成更新');
    record.mode = mode; this.save(record); this.nextCheck = 0;
    return this.public(record);
  }
  unlink({ id, confirmed }) {
    check(confirmed === true, '请确认解除关联');
    const record = this.records().find(item => item.id === id); check(record, '安装关联不存在');
    check(!record.journal, '请先恢复未完成更新，不能丢弃恢复记录');
    // Missing or externally changed locations can be forgotten without deleting their files.
    let owned = false;
    try { this.owned(record); owned = true; }
    catch (error) { if (!['ENOENT', 'CONFLICT', 'INVALID'].includes(error.code)) throw error; }
    if (owned) {
      const release = lockFile(path.join(record.directory, '.studyself-update.lock'));
      try { this.owned(record); fs.unlinkSync(path.join(record.directory, marker)); } finally { release(); }
    }
    this.store.local(key, this.records().filter(item => item.id !== id)); return this.list();
  }
}
