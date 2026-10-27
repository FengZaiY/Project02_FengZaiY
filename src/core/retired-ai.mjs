import { RETIRED_AI_TYPES } from './catalog.mjs';
import { mergeErasures } from './erasures.mjs';
import { deletionFiles, scheduleDeletion } from './permanent-files.mjs';
import { canonical, check, now, sha, uuid } from './util.mjs';
import { sameRevision, sourceRevisionHash, withoutPresentation } from './retired-presentation.mjs';

export const retiredAI = type => RETIRED_AI_TYPES.includes(type);

const legacyWorkspace = event => event.type === 'workspace' && (event.data.tabs || []).some(tab =>
  ['prompt', 'modelId', 'conversationId', 'jobId', 'messages'].some(key => Object.hasOwn(tab, key))
  || retiredAI(tab.type) || retiredAI(tab.draft?.type));

export function retirementReceipts(store, events, existing = store.erasures()) {
  if (!store.retiredAI) return [];
  const known = new Map(mergeErasures(existing).flatMap(receipt => receipt.versions.map(version =>
    [version.id, { ...version, entityId: receipt.entityId, type: receipt.type }])));
  const workspaces = new Set([...events.filter(legacyWorkspace).map(event => event.entityId),
    ...existing.filter(receipt => receipt.type === 'workspace' && receipt.purpose === 'retired-ai').map(receipt => receipt.entityId)]);
  const identities = new Map();
  for (const event of events) {
    const prior = identities.get(event.id) || store.event(event.id);
    check(!prior || sameRevision(prior, event) && prior.entityId === event.entityId && prior.type === event.type, '同步记录身份冲突');
    identities.set(event.id, event);
  }
  const groups = new Map();
  for (const event of events.filter(event => retiredAI(event.type) || workspaces.has(event.entityId))) {
    const prior = known.get(event.id);
    if (prior) {
      check(prior.hash === sourceRevisionHash(event) && prior.entityId === event.entityId && prior.type === event.type, '退役记录身份校验失败');
      continue;
    }
    if (!groups.has(event.entityId)) groups.set(event.entityId, new Map());
    const group = groups.get(event.entityId), duplicate = group.get(event.id);
    check(!duplicate || sameRevision(duplicate, event), '退役记录身份冲突');
    group.set(event.id, event);
  }
  return [...groups].map(([entityId, group]) => {
    const revisions = [...group.values()], type = revisions[0].type;
    check(revisions.every(event => event.type === type), '退役实体类型冲突');
    const body = { format: 1, id: uuid(), entityId, type, deviceId: store.deviceId, at: now(), purpose: 'retired-ai',
      versions: revisions.map(event => ({ id: event.id, hash: sourceRevisionHash(event) })).sort((a, b) => a.id.localeCompare(b.id)) };
    return { ...body, hash: sha(canonical(body)) };
  });
}

export function cleanRetiredTabs(workspace, ids = new Set()) {
  if (!workspace || !Array.isArray(workspace.tabs)) return workspace;
  const tabs = workspace.tabs.filter(tab => !ids.has(tab.recordId) && !retiredAI(tab.type)
    && !retiredAI(tab.draft?.type)
    && !(tab.conversationId && (!tab.recordId || tab.recordId === tab.conversationId))).map(tab => {
    const { prompt, modelId, conversationId, jobId, attachments, messages, ...keep } = tab;
    return keep;
  });
  return { ...workspace, tabs, selectedTab: tabs.some(tab => tab.id === workspace.selectedTab) ? workspace.selectedTab : null };
}

const replacementId = id => {
  const hash = sha(`studyself-retired-ai-workspace:${id}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

export function replacementWorkspaces(events, receipts) {
  const workspaces = new Set(receipts.filter(receipt => receipt.type === 'workspace' && receipt.purpose === 'retired-ai').map(receipt => receipt.entityId));
  return events.filter(event => workspaces.has(event.entityId) && event.type === 'workspace').map(event => {
    const { hash, retiredPresentation, ...source } = event;
    const body = { ...source, id: replacementId(event.id), entityId: replacementId(event.entityId),
      parents: event.parents.map(replacementId), data: withoutPresentation('workspace', cleanRetiredTabs(event.data)) };
    return { ...body, hash: sha(canonical(body)) };
  });
}

export function migrateRetiredAI(store, validateEvent) {
  return store.transaction(() => {
    const events = store.allEvents(), queued = ['pending', 'rejected'].flatMap(table =>
      store.db.prepare(`SELECT json FROM ${table}`).all().map(row => JSON.parse(row.json)));
    const cached = store.db.prepare("SELECT value FROM local_config WHERE key LIKE 'v3:%:plan'").all()
      .flatMap(row => Object.values(JSON.parse(row.value)?.metadata || {}).flat());
    const journal = store.local('retiredV2Journal')?.snapshot?.events || [];
    const all = [...events, ...queued, ...cached, ...journal];
    const obsoleteWorkspaces = new Set(all.filter(legacyWorkspace).map(event => event.entityId));
    const retired = all.filter(event => retiredAI(event.type) || obsoleteWorkspaces.has(event.entityId));
    const valid = retired.filter(event => { try { validateEvent(event); return true; } catch { return false; } });
    const ids = [...new Set(retired.map(event => event.entityId))];
    scheduleDeletion(store, ids, deletionFiles(store, ids));
    const receipts = retirementReceipts(store, valid);
    const replacements = replacementWorkspaces(valid, mergeErasures(store.erasures(), receipts));
    for (const event of replacements) {
      validateEvent(event);
      if (!store.event(event.id)) store.db.prepare('INSERT OR IGNORE INTO pending VALUES(?,?)').run(event.id, JSON.stringify(event));
    }
    // Rejected invalid payloads cannot become usable history; discard only the retired types.
    for (const table of ['pending', 'rejected']) for (const type of RETIRED_AI_TYPES) {
      store.db.prepare(`DELETE FROM ${table} WHERE json_extract(json,'$.type')=?`).run(type);
    }
    if (receipts.length) store.eraseRaw(receipts);
    let settings = 0;
    for (const { key } of store.db.prepare('SELECT key FROM local_config').all()) {
      if (!/^(secret:api:|provider:|probe:|attempt:)/.test(key)) continue;
      store.db.prepare('DELETE FROM local_config WHERE key=?').run(key); settings++;
    }
    const workspace = store.local('workspace'), cleaned = cleanRetiredTabs(workspace, new Set(ids));
    const tabsChanged = canonical(workspace) !== canonical(cleaned);
    if (tabsChanged) store.local('workspace', cleaned);
    const changed = retired.length > 0 || settings > 0 || tabsChanged;
    if (changed) store.local('retiredAiCleanup', { at: now(), records: ids.length, revisions: retired.length, settings, pending: true });
    return changed || store.local('retiredAiCleanup')?.pending === true;
  });
}
