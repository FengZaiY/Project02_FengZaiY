import { cleanData, validateEvent } from '../../src/core/store.mjs';
import { canonical, now, sha, uuid } from '../../src/core/util.mjs';

export const retiredPage = content => ({ v: 1, html: '<p>RETIRED_PAGE_SECRET</p>', css: 'p{color:green}',
  script: 'page.text("output", "RETIRED_SCRIPT_SECRET");', data: { obsolete: 'RETIRED_DATA_SECRET' },
  assetIds: [], noteIds: [], basis: { contentHash: sha(JSON.stringify([content.format || 'markdown', content.content || ''])), sources: [] } });

export function legacyReadingEvent(store, { id = uuid(), type = 'note', data, parents = [], deleted = false }) {
  const body = { schema: 1, id: uuid(), entityId: id, type, deviceId: store.deviceId,
    sequence: Number(store.getMeta('sequence') || 0) + 1, createdAt: now(), parents, deleted,
    data: cleanData(type, data, { legacyPresentation: true }) };
  return validateEvent({ ...body, hash: sha(canonical(body)) });
}

// Install an already-validated historical representation to simulate an old application.
export function seedLegacyReading(store, events) {
  store.transaction(() => {
    for (const event of events) {
      validateEvent(event);
      store.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,0,0)').run(event.id, event.entityId, event.type, event.deviceId, event.createdAt, JSON.stringify(event));
      for (const parent of event.parents) store.db.prepare('DELETE FROM heads WHERE entity_id=? AND event_id=?').run(event.entityId, parent);
      store.db.prepare('INSERT INTO heads VALUES(?,?)').run(event.entityId, event.id);
      store.setMeta('sequence', event.sequence);
    }
  });
}
