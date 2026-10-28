import { legacyNames, libraryMarkerPath } from './legacy-names.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { check, inside, isId, isHash, noSymlink, sha } from './util.mjs';
import { centralAssetPath } from './material-center.mjs';
import { MATERIAL_SCOPE } from './personal-schema.mjs';
import { readableAssetPath } from './readable-storage.mjs';

const markerName = '.fengzaiy-library.json';
const reserved = new Set(['资料', '导出', 'objects', 'assets', 'incoming', 'opened-files', 'electron-profile', 'knowledge.sqlite', 'device-vault.key', 'version-repositories', 'version-staging', 'received-objects']);
export function legacyLibraryId(scope) {
  const hash = sha(`${legacyNames.librarySeed}${scope}`).slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}
function folderName(title) {
  let name = String(title).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 64).replace(/[. ]+$/g, '');
  if (!name || name.startsWith('.') || reserved.has(name.toLowerCase()) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `知识库-${name || '未命名'}`;
  return name;
}

export class LibraryDirectories {
  constructor(store) { this.store = store; }
  location(name) {
    check(typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name) && path.basename(name) === name, '知识库目录映射无效');
    const directory = inside(this.store.directory, name);
    noSymlink(directory);
    return directory;
  }
  owns(directory, id) {
    const marker = libraryMarkerPath(directory);
    noSymlink(marker);
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile() || fs.statSync(marker).size > 4096) return false;
    try { const data = JSON.parse(fs.readFileSync(marker, 'utf8')); return data.format === 1 && data.libraryId === id; }
    catch { return false; }
  }
  ensure(record) {
    check(record?.type === 'library' && isId(record.id), '知识库标识无效');
    const mappings = this.store.local('libraryDirectories') || {};
    const saved = mappings[record.id];
    if (Object.hasOwn(mappings, record.id)) {
      const directory = this.location(saved);
      if (fs.existsSync(directory)) {
        check(fs.statSync(directory).isDirectory() && this.owns(directory, record.id), '知识库文件夹已被替换或缺少标识，不会覆盖其内容');
        return directory;
      }
      this.create(directory, record);
      return directory;
    }
    const base = folderName(record.data.title);
    const names = new Map(fs.readdirSync(this.store.directory).map(name => [name.normalize('NFKC').toLowerCase(), name]));
    for (let index = 0; index < 100; index++) {
      const name = index === 0 ? base : `${base}-${record.id.slice(0, 8)}${index > 1 ? `-${index}` : ''}`;
      const existing = names.get(name.normalize('NFKC').toLowerCase());
      const directory = this.location(existing || name);
      if (existing) {
        if (!fs.statSync(directory).isDirectory() || !this.owns(directory, record.id)) continue;
      } else {
        try { this.create(directory, record); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      }
      this.store.local('libraryDirectories', { ...mappings, [record.id]: existing || name });
      return directory;
    }
    throw new Error('无法分配知识库文件夹，请检查同名文件');
  }
  create(directory, record) {
    noSymlink(directory);
    fs.mkdirSync(directory);
    const file = path.join(directory, markerName);
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ format: 1, libraryId: record.id, domain: record.data.domain })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  describe(records) {
    return records.map(record => {
      try { return { ...record, localDirectory: this.ensure(record), directoryError: null }; }
      catch (error) { return { ...record, localDirectory: null, directoryError: error.message }; }
    });
  }
  assetPath(domain, hash, record) {
    if (record && (this.store.personalSystem || domain === MATERIAL_SCOPE || record.data.centralized)) return readableAssetPath(this.store, record);
    if (this.store.personalSystem || domain === MATERIAL_SCOPE) return centralAssetPath(this.store, hash);
    check(typeof domain === 'string' && domain && domain !== '__all_libraries__' && isHash(hash), '附件知识库或内容标识无效');
    const library = this.store.libraries().find(item => item.data.domain === domain) || {
      id: legacyLibraryId(domain), type: 'library', data: { title: domain, domain }
    };
    const directory = path.join(this.ensure(library), 'attachments');
    noSymlink(directory); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, hash); noSymlink(file);
    return file;
  }
}
