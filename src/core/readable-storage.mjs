import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, canonical, check, inside, noSymlink, sha } from './util.mjs';

const marker = '.fengzaiy-directory.json';
export function readableName(value, limit = 64) {
  let name = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, limit).replace(/[. ]+$/g, '');
  if (!name || name.startsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `未命名-${name.replace(/^\.+/, '')}`;
  return name;
}

// Local maps reserve names before bytes are copied. They never grant ownership of an existing foreign file.
export function readableDirectory(store, parent, title, key, create = true, limit = 48) {
  noSymlink(parent);
  const base = readableName(title, limit), entries = store.local('readableDirectories') || {};
  const owner = sha(key);
  const owns = directory => {
    const file = path.join(directory, marker); noSymlink(file);
    try { return fs.statSync(file).size < 4096 && JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner; } catch { return false; }
  };
  for (let index = 0; index < 100; index++) {
    const name = index ? `${base}-${owner.slice(0, 8)}${index > 1 ? `-${index}` : ''}` : base;
    const target = path.join(parent, name), relative = path.relative(store.directory, target);
    check(!relative.startsWith('..') && !path.isAbsolute(relative) && target.length <= 240, '目录层级或名称过长，请缩短名称后重试');
    noSymlink(target);
    const existing = fs.existsSync(parent) && fs.readdirSync(parent).find(item => item.normalize('NFKC').toLowerCase() === name.toLowerCase());
    if (existing && (existing !== name || !fs.statSync(target).isDirectory() || !owns(target))) continue;
    if (Object.entries(entries).some(([other, value]) => other !== key && value.toLowerCase() === relative.toLowerCase())) continue;
    if (create) {
      fs.mkdirSync(target, { recursive: true });
      if (!existing) atomicWrite(path.join(target, marker), JSON.stringify({ format: 1, owner }));
    }
    if (create || store.planningPaths) { entries[key] = relative; store.local('readableDirectories', entries); }
    return target;
  }
  check(false, '同名目录过多，无法安全分配目录');
}

export function materialLocation(store, data) {
  if (!data.materialTopicId) return { category: '待整理', topic: '未分类资料', categoryId: null, topicId: null };
  const topic = store.get(data.materialTopicId), category = topic && store.get(topic.data.materialCategoryId);
  check(topic?.type === 'materialTopic' && !topic.deleted && !topic.conflict && category?.type === 'materialCategory' && !category.deleted && !category.conflict,
    '资料分类或主题不可用，请先处理冲突或归属', 'CONFLICT');
  return { category: category.data.title, topic: topic.data.title, categoryId: category.id, topicId: topic.id };
}

export function readableAssetPath(store, record, create = true) {
  check(record?.id && record.data?.filename && record.data.sha256, '原件缺少稳定身份与名称');
  const { data, id } = record, location = materialLocation(store, data);
  const root = readableDirectory(store, store.directory, '资料', 'materials', create);
  const category = readableDirectory(store, root, location.category, `category:${location.categoryId || 'unfiled'}`, create);
  const directory = readableDirectory(store, category, location.topic, `topic:${location.topicId || 'unfiled'}`, create);
  const original = data.managedFilename || data.filename, extension = path.extname(original);
  const base = readableName(path.basename(original, extension), Math.max(8, Math.min(80, 215 - directory.length - extension.length)));
  const names = store.local('readableAssets') || {}, key = `${id}:${data.sha256}`;
  const expected = canonical([location, original]);
  if (names[key]?.expected === expected) {
    const target = inside(store.directory, names[key].relative); noSymlink(target);
    if (path.dirname(target) === directory) return target;
  }
  for (let index = 0; index < 100; index++) {
    const name = `${base}${index ? `-${id.slice(0, 8)}${index > 1 ? `-${index}` : ''}` : ''}${extension}`;
    const file = path.join(directory, name), relative = path.relative(store.directory, file); noSymlink(file);
    check(file.length <= 250, '资料路径过长，请缩短分类、主题或文件名');
    if (Object.entries(names).some(([other, entry]) => other !== key && entry.relative.toLowerCase() === relative.toLowerCase())) continue;
    const existing = fs.existsSync(directory) && fs.readdirSync(directory).some(item => item.toLowerCase() === name.toLowerCase());
    if (existing && names[key]?.relative !== relative) continue;
    if (create || store.planningPaths) {
      if (names[key]?.relative && names[key].relative !== relative) {
        const history = store.local('readableAssetHistory') || {};
        history[names[key].relative] = { hash: names[key].hash, id }; store.local('readableAssetHistory', history);
      }
      names[key] = { relative, expected, hash: data.sha256, id }; store.local('readableAssets', names);
    }
    return file;
  }
  check(false, '同名文件过多，请调整资料名称');
}

export function isReadableAsset(store, file) {
  const relative = path.relative(store.directory, path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return Object.values(store.local('readableAssets') || {}).some(entry => entry.relative === relative)
    || !!(store.local('readableAssetHistory') || {})[relative];
}

export function requiresReadableFormat(event) {
  return ['materialCategory', 'materialTopic'].includes(event.type) || !!event.data?.materialItems?.length
    || !!event.data?.materialTopicId || !!event.data?.managedFilename;
}
