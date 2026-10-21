import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, canonical, check, hashFile, inside, noSymlink, now, outside, sha, uuid } from './util.mjs';
import { placedTypes } from './hierarchy.mjs';
import { legacyNoteId } from './note-hierarchy.mjs';

const names = { note: '笔记', draft: '草稿', source: '来源', annotation: '备注', relation: '关联', proposal: '整理方案', asset: '资料' };
const safeName = title => String(title).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 24) || '未命名';

// This is a rebuildable current-content projection, never the authority for note history.
export class LocalHierarchy {
  constructor(store) { this.store = store; this.running = false; }
  status() {
    return { enabled: this.store.local('hierarchyEnabled') === true, busy: this.running,
      pending: this.store.local('hierarchyDirty') === true, ...(this.store.local('hierarchyReport') || {}) };
  }
  root(library) {
    return this.store.directories.ensure(library);
  }
  checked(relative) {
    check(relative && typeof relative === 'string', '本地目录记录无效');
    const file = inside(this.store.directory, relative); noSymlink(file); return file;
  }
  projectionFile(file) {
    for (const [id, name] of Object.entries(this.store.local('libraryDirectories') || {})) {
      const directory = this.store.directories.location(name);
      if (!this.store.directories.owns(directory, id)) continue;
      if (!outside(directory, file)) return true;
    }
    return false;
  }
  pruneEmpty(directory) {
    while (this.projectionFile(directory) && !fs.existsSync(path.join(directory, '.studyself-library.json'))) {
      noSymlink(directory);
      if (!fs.existsSync(directory) || fs.readdirSync(directory).length) return;
      fs.rmdirSync(directory);
      directory = path.dirname(directory);
    }
  }
  write(file, data, files) {
    const relative = path.relative(this.store.directory, file), digest = sha(data);
    noSymlink(file);
    if (fs.existsSync(file)) {
      const current = sha(fs.readFileSync(file));
      check(current === digest || files[relative] === current, '本地目录文件被其他程序修改，已保留；请先移开修改副本后重试');
    }
    if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== digest) atomicWrite(file, data);
    files[relative] = digest;
    // Persist ownership immediately so interruption can resume without overwriting unknown files.
    this.store.local('hierarchyFiles', files);
    return relative;
  }
  managedOriginal(file) {
    if (!outside(this.store.directory, file)) {
      const received = path.join(this.store.directory, 'received-objects');
      if (path.dirname(file) === received && /^[a-f0-9]{64}$/.test(path.basename(file))) return true;
      for (const [id, name] of Object.entries(this.store.local('libraryDirectories') || {})) {
        const directory = this.store.directories.location(name);
        if (!this.store.directories.owns(directory, id)) continue;
        if (path.dirname(file) === path.join(directory, 'attachments') && /^[a-f0-9]{64}$/.test(path.basename(file))) return true;
        const tracked = this.store.local('hierarchyOriginals') || {};
        if (tracked[path.relative(this.store.directory, file)] && !outside(directory, file)) return true;
      }
    }
    return false;
  }
  async cleanOriginals() {
    const pending = this.store.local('hierarchyCleanup') || [], keep = [];
    for (const item of pending) {
      const file = this.checked(item.relative);
      if (!fs.existsSync(file)) continue;
      if (item.assetId && this.store.activeAssetReads?.get(item.assetId) > 0) { keep.push(item); continue; }
      if (this.store.db.prepare('SELECT 1 FROM assets WHERE path=?').get(file)) continue;
      if (!this.managedOriginal(file) || await hashFile(file) !== item.hash) { keep.push(item); continue; }
      fs.unlinkSync(file);
      this.pruneEmpty(path.dirname(file));
    }
    this.store.local('hierarchyCleanup', keep);
  }
  async original(record, directory, verify) {
    const local = this.store.assetLocation(record.id);
    if (!local || !fs.existsSync(local.path)) return { available: false };
    const source = local.path; noSymlink(source);
    const extension = path.extname(record.data.filename).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
    const file = path.join(directory, `${safeName(path.basename(record.data.filename, path.extname(record.data.filename)))}-${record.id}${extension}`);
    noSymlink(file);
    if (path.resolve(file) === path.resolve(source)) {
      const stat = fs.statSync(source);
      const stamp = { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino, hash: record.data.sha256 };
      const verified = this.store.local('hierarchyVerified') || {}, relative = path.relative(this.store.directory, source);
      if (verify || canonical(verified[relative]) !== canonical(stamp)) {
        check(stat.size === record.data.size && await hashFile(source) === record.data.sha256, '本地分类原件校验失败');
        verified[relative] = stamp; this.store.local('hierarchyVerified', verified);
      }
      return { available: true, file: path.basename(file) };
    }
    check(!(this.store.activeAssetReads?.get(record.id) > 0), '原件正在读取，稍后重试本地目录整理');
    check(fs.statSync(source).size === record.data.size && await hashFile(source) === record.data.sha256, '原件校验失败，未移动或覆盖');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file)) {
      check(await hashFile(file) === record.data.sha256, '目标原件已被修改，不会覆盖');
    } else {
      const temp = `${file}.${uuid()}.partial`;
      try {
        await fs.promises.copyFile(source, temp);
        check(await hashFile(temp) === record.data.sha256, '原件复制期间发生变化');
        const handle = await fs.promises.open(temp, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.promises.rename(temp, file);
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    check(canonical(this.store.headIds(record.id)) === canonical(record.heads), '资料归属已变化，稍后重新整理');
    check(!(this.store.activeAssetReads?.get(record.id) > 0), '原件开始读取，已保留两份副本，稍后重试整理');
    const current = this.store.assetLocation(record.id);
    check(current?.path === source, '原件位置已变化，稍后重试整理');
    this.store.transaction(() => {
      const originals = this.store.local('hierarchyOriginals') || {};
      originals[path.relative(this.store.directory, file)] = record.data.sha256;
      this.store.local('hierarchyOriginals', originals);
      this.store.local('hierarchyCleanup', [...(this.store.local('hierarchyCleanup') || []),
        { relative: path.relative(this.store.directory, source), hash: record.data.sha256, assetId: record.id }].filter(item => !path.isAbsolute(item.relative) && !item.relative.startsWith('..')));
      this.store.bindAsset(record.id, file, current.pinned === 1);
    });
    return { available: true, file: path.basename(file) };
  }
  async refresh({ enable = false, verify = true } = {}) {
    check(!this.running, '本地目录正在整理');
    if (enable) this.store.local('hierarchyEnabled', true);
    this.running = true;
    const files = this.store.local('hierarchyFiles') || {}, used = new Set();
    const report = { at: now(), records: 0, missing: 0, errors: [] };
    const initial = this.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    try {
      for (const library of this.store.libraries()) {
        const root = this.root(library), notes = this.store.noteTree(library.data.domain), dirs = new Map();
        const noteDirectory = node => {
          if (dirs.has(node.id)) return dirs.get(node.id);
          const parent = node.parentNoteId ? notes.find(item => item.id === node.parentNoteId) : null;
          const directory = path.join(parent ? noteDirectory(parent) : root, `${safeName(node.data.title)}-${node.id}`);
          noSymlink(directory); fs.mkdirSync(directory, { recursive: true });
          dirs.set(node.id, directory);
          return directory;
        };
        const records = [...this.store.list({ domain: library.data.domain }), ...this.store.list({ domain: library.data.domain, trash: true })]
          .filter(record => placedTypes.includes(record.type));
        const owners = new Map();
        for (const note of notes.filter(item => !item.conflict)) for (const id of [...(note.data.assetIds || []), ...(note.data.sourceIds || [])]) {
          if (!owners.has(id)) owners.set(id, new Set());
          owners.get(id).add(note.id);
        }
        for (const record of records) {
          try {
            const ownerIds = owners.get(record.id);
            const ownerId = ownerIds?.size === 1 ? [...ownerIds][0] : record.data.noteId
              || (record.data.folderId ? legacyNoteId(record.data.folderId) : null);
            const node = notes.find(item => item.id === (record.type === 'note' ? record.id : ownerId));
            const base = record.deleted ? path.join(root, '回收站') : record.conflict ? path.join(root, '待处理冲突')
              : ownerIds?.size > 1 ? path.join(root, '共享资料') : node ? noteDirectory(node) : root;
            const directory = record.type === 'note' && !record.deleted && !record.conflict ? base : path.join(base, names[record.type]);
            noSymlink(directory); fs.mkdirSync(directory, { recursive: true });
            const stem = `${safeName(record.data.title)}-${record.id}`;
            let original;
            if (record.type === 'asset' && !record.conflict) {
              original = await this.original(record, directory, verify);
              if (!original.available) report.missing++;
            }
            used.add(this.write(path.join(directory, `${stem}.json`), JSON.stringify({ format: 1, id: record.id, type: record.type,
              data: record.data, heads: record.heads, versions: record.versions, deleted: record.deleted, original }, null, 2), files));
            if (typeof record.data.content === 'string') used.add(this.write(path.join(directory, `${stem}.md`),
              `# ${record.data.title}\n\n${record.data.content}\n${record.data.presentation ? '\n本文件为知识正文，不包含可运行交互；完整页面定义保留在同名 JSON 中。\n' : ''}`, files));
            report.records++;
          } catch (error) { report.errors.push({ id: record.id, message: error.message }); }
        }
      }
      // Only remove unmodified files previously generated by this projection, never user extras.
      if (!report.errors.length) for (const [relative, digest] of Object.entries(files)) {
        if (used.has(relative)) continue;
        const file = this.checked(relative);
        check(this.projectionFile(file), '待整理文件不在所属知识库分类目录，已停止清理');
        if (fs.existsSync(file)) {
          if (sha(fs.readFileSync(file)) !== digest) continue;
          fs.unlinkSync(file);
        }
        delete files[relative];
        this.pruneEmpty(path.dirname(file));
      }
      await this.cleanOriginals();
      this.store.local('hierarchyFiles', files);
      this.store.local('hierarchyDirty', report.errors.length > 0 || initial !== this.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n);
    } catch (error) { report.errors.push({ message: error.message }); this.store.local('hierarchyDirty', true); }
    finally { this.running = false; this.store.local('hierarchyReport', report); }
    return this.status();
  }
}
