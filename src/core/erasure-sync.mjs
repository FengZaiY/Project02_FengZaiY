import fs from 'node:fs';
import { sealBinary, assetAAD } from './sync-objects.mjs';
import { filterErased, mergeErasures, validateErasure } from './erasures.mjs';
import { atomicWrite, canonical, check, isHash, isId, now, sha } from './util.mjs';
import { validateEvent } from './store.mjs';
import { retirementReceipts, replacementWorkspaces } from './retired-ai.mjs';
import { retirePresentation } from './retired-presentation.mjs';

const LIMIT = 2 * 1024 * 1024;
const replacementName = part => `replace-${part.hash}.ssreplacement`;

export function readErasureReceipts(channel) {
  return mergeErasures(channel.names('.sserasure').map(name => {
    const id = name.slice(6, -10), value = channel.json(name, `v4:erase:${id}`);
    check(name === `erase-${value.id}.sserasure`, '永久删除文件名称不匹配');
    return validateErasure(value);
  }));
}

export function readHistoryPart(channel, part, visited = new Set()) {
  check(part && isHash(part.hash) && part.name === `history-${part.hash}.ssobj`
    && Number.isSafeInteger(part.size) && part.size > 0 && part.size <= LIMIT
    && Number.isSafeInteger(part.count) && part.count > 0 && part.count <= 100000, '修改记录分块索引无效');
  check(!visited.has(part.name) && visited.size < 1000, '删除替换索引循环或层数过多'); visited.add(part.name);
  const name = replacementName(part);
  if (fs.existsSync(channel.file(name))) {
    const replacement = channel.json(name, `v4:replace:${part.hash}`);
    check((replacement.format === 1 || replacement.format === 2 && replacement.retirement === 'presentation')
      && replacement.source === part.name && Array.isArray(replacement.receipts) && replacement.receipts.every(isId)
      && (replacement.receipts.length > 0 || replacement.format === 2), '删除替换索引无效');
    const known = new Set(readErasureReceipts(channel).map(receipt => receipt.id));
    check(replacement.receipts.every(id => known.has(id)), '删除凭据尚未下载完整');
    if (replacement.part === null) {
      check(replacement.receipts.length > 0, '清空修改记录需要删除凭据');
      return [];
    }
    return readHistoryPart(channel, replacement.part, visited);
  }
  const data = channel.read(part.name, `v3:history:${part.hash}`, LIMIT);
  check(data.length === part.size && sha(data) === part.hash, '修改记录分块校验失败');
  const events = JSON.parse(data.toString());
  check(Array.isArray(events) && events.length === part.count, '修改记录数量不符');
  events.forEach(validateEvent);
  return events.map(retirePresentation);
}

// Publish replacements before removing mixed objects. Other devices can follow the chain
// even if a prior device manifest still names the original history part.
export function cleanErasedTransport(sync) {
  const store = sync.store, report = { at: now(), state: 'done', deleted: 0, errors: [], cloudVerified: false };
  if (!sync.config().configured) return { ...report, state: 'unconfigured' };
  const local = sync.devices().devices.find(device => device.local);
  if (local?.suspended || local?.statusConflict) return { ...report, state: 'blocked', errors: [{ message: '本机已停用，暂停发布同步删除凭据及清理传输文件' }] };
  const channel = sync.channel(); let receipts = mergeErasures(store.erasures());
  if (!receipts.length && !store.retiredAI && store.getMeta('presentationRetired') !== '1') return report;
  for (const value of store.erasures()) channel.writeJson(`erase-${value.id}.sserasure`, value, `v4:erase:${value.id}`);
  const removedHashes = new Set(store.local('permanentDeletionAssetHashes') || []);
  const retainedHashes = new Set(store.allEvents().filter(event => event.type === 'asset').map(event => event.data.sha256));
  const descriptors = new Map([...(store.local('permanentDeletionAssetDescriptors') || []), ...sync.knownAssets()].map(asset => [asset.hash, asset]));
  const changes = [];
  for (const name of channel.names('.ssobj').filter(name => /^history-[a-f0-9]{64}\.ssobj$/.test(name))) {
    try {
      const hash = name.slice(8, -6), data = channel.read(name, `v3:history:${hash}`, LIMIT);
      check(sha(data) === hash, '同步历史对象校验失败');
      const events = JSON.parse(data.toString()); events.forEach(validateEvent);
      const retirement = retirementReceipts(store, events, receipts);
      if (retirement.length) {
        store.transaction(() => store.eraseRaw(retirement));
        receipts = mergeErasures(receipts, retirement);
        for (const value of retirement) channel.writeJson(`erase-${value.id}.sserasure`, value, `v4:erase:${value.id}`);
      }
      const remaining = filterErased(events, receipts);
      const kept = [...remaining, ...replacementWorkspaces(events, receipts)].map(retirePresentation);
      const presentationChanged = remaining.some(event => retirePresentation(event) !== event);
      for (const event of kept) if (event.type === 'asset') retainedHashes.add(event.data.sha256);
      if (remaining.length === events.length && !presentationChanged) continue;
      for (const event of events) if (event.type === 'asset' && !kept.includes(event)) removedHashes.add(event.data.sha256);
      let part = null;
      if (kept.length) {
        const text = canonical(kept), digest = sha(text);
        part = { name: `history-${digest}.ssobj`, hash: digest, size: Buffer.byteLength(text), count: kept.length };
        channel.write(part.name, Buffer.from(text), `v3:history:${digest}`);
      }
      changes.push({ name, hash, part, presentationChanged });
    } catch (error) { report.errors.push({ file: name, message: error.message }); }
  }
  // Missing placeholders and partial manifests prohibit deletion of asset objects.
  for (const name of channel.names('.sscurrent')) {
    try {
      const manifest = sync.loadCurrent(name);
      for (const asset of manifest.assets) descriptors.set(asset.hash, asset);
      for (const part of manifest.parts) {
        const change = changes.find(item => item.name === part.name);
        const events = change ? (change.part ? readHistoryPart(channel, change.part) : []) : readHistoryPart(channel, part);
        for (const event of filterErased(events, receipts)) if (event.type === 'asset') retainedHashes.add(event.data.sha256);
      }
    } catch (error) { report.errors.push({ file: name, message: error.message }); }
  }
  for (const change of changes) {
    try {
      const replacement = { format: change.presentationChanged ? 2 : 1, ...(change.presentationChanged ? { retirement: 'presentation' } : {}),
        source: change.name, part: change.part, receipts: receipts.map(value => value.id) };
      atomicWrite(channel.file(`replace-${change.hash}.ssreplacement`), sealBinary(Buffer.from(canonical(replacement)), channel.key, `v4:replace:${change.hash}`));
      fs.unlinkSync(channel.file(change.name)); report.deleted++;
    } catch (error) { report.errors.push({ file: change.name, message: error.message }); }
  }
  store.local('permanentDeletionAssetDescriptors', [...descriptors.values()].filter(asset => removedHashes.has(asset.hash)));
  if (!report.errors.length) for (const name of channel.names('.ssobj')) {
    const match = /^asset-([a-f0-9]{64})-(\d+)\.ssobj$/.exec(name);
    if (!match || !removedHashes.has(match[1]) || retainedHashes.has(match[1])) continue;
    try {
      const asset = descriptors.get(match[1]), index = Number(match[2]), chunk = asset?.chunks[index];
      check(chunk?.name === name, '原件分块缺少可核验索引，保留等待处理');
      const data = channel.read(name, assetAAD(asset, index));
      check(data.length === chunk.size && sha(data) === chunk.hash, '原件分块已损坏或被改写，保留等待处理');
      fs.unlinkSync(channel.file(name)); report.deleted++;
    }
    catch (error) { report.errors.push({ file: name, message: error.message }); }
  }
  store.local('permanentDeletionAssetHashes', [...removedHashes]);
  report.state = report.errors.length ? 'blocked' : 'done';
  store.local('permanentDeletionTransport', report);
  return report;
}
