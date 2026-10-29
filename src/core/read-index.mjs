// Connection-local, rebuildable metadata. User revisions and checksums stay untouched.
export function createReadIndex(db) {
  db.exec(`
    CREATE TEMP TABLE head_read_index(event_id TEXT PRIMARY KEY, entity_id TEXT, type TEXT,
      domain TEXT, deleted INTEGER, purged INTEGER, created_at TEXT);
    CREATE INDEX head_read_entity ON head_read_index(entity_id);
    CREATE INDEX head_read_scope ON head_read_index(type,domain,created_at);
    CREATE TEMP TABLE read_epoch(value INTEGER NOT NULL);
    INSERT INTO read_epoch VALUES(0);
    INSERT INTO head_read_index
      SELECT e.id,h.entity_id,e.type,json_extract(e.json,'$.data.domain'),
        json_extract(e.json,'$.deleted'),COALESCE(json_extract(e.json,'$.purged'),0),e.created_at
      FROM heads h JOIN events e ON e.id=h.event_id;
    CREATE TEMP TRIGGER read_head_insert AFTER INSERT ON main.heads BEGIN
      INSERT OR REPLACE INTO head_read_index SELECT e.id,NEW.entity_id,e.type,json_extract(e.json,'$.data.domain'),
        json_extract(e.json,'$.deleted'),COALESCE(json_extract(e.json,'$.purged'),0),e.created_at FROM events e WHERE e.id=NEW.event_id;
      UPDATE read_epoch SET value=value+1;
    END;
    CREATE TEMP TRIGGER read_head_delete AFTER DELETE ON main.heads BEGIN
      DELETE FROM head_read_index WHERE event_id=OLD.event_id;
      UPDATE read_epoch SET value=value+1;
    END;
    CREATE TEMP TRIGGER read_event_update AFTER UPDATE OF json ON main.events BEGIN
      UPDATE head_read_index SET type=NEW.type,domain=json_extract(NEW.json,'$.data.domain'),
        deleted=json_extract(NEW.json,'$.deleted'),purged=COALESCE(json_extract(NEW.json,'$.purged'),0),created_at=NEW.created_at
        WHERE event_id=NEW.id;
      UPDATE read_epoch SET value=value+1;
    END;
    CREATE TEMP TRIGGER read_event_delete AFTER DELETE ON main.events BEGIN
      DELETE FROM head_read_index WHERE event_id=OLD.id;
      UPDATE read_epoch SET value=value+1;
    END;
    CREATE TEMP TRIGGER read_delivery_update AFTER UPDATE OF exported,received ON main.events BEGIN
      UPDATE read_epoch SET value=value+1;
    END;
    CREATE TEMP TRIGGER read_receipt_insert AFTER INSERT ON main.receipts BEGIN
      UPDATE read_epoch SET value=value+1;
    END;
    CREATE TEMP TRIGGER read_receipt_delete AFTER DELETE ON main.receipts BEGIN
      UPDATE read_epoch SET value=value+1;
    END;
  `);
}

export function selectRecordIds(db, { type, domain, query, trash = false, limit, excludedTypes = [] } = {}) {
  const clauses = [], args = [];
  if (type) { clauses.push('type=?'); args.push(type); }
  if (excludedTypes.length) { clauses.push(`type NOT IN (${excludedTypes.map(() => '?').join(',')})`); args.push(...excludedTypes); }
  const scope = domain ? ' AND MAX(domain=?)=1' : '';
  if (domain) args.push(domain);
  if (query) args.push(query.toLocaleLowerCase());
  const bounded = Number.isSafeInteger(limit) && limit > 0;
  if (bounded) args.push(Math.min(limit, 10000));
  // Keep every branch of a matched entity; a live branch takes precedence over a deleted one.
  return db.prepare(`WITH candidates AS (SELECT entity_id,MAX(created_at) AS updated,MIN(event_id) AS first_head FROM head_read_index ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    GROUP BY entity_id HAVING MIN(deleted)=${trash ? 1 : 0} AND MIN(purged)=0${scope}
    ) SELECT entity_id FROM candidates c ${query ? `WHERE EXISTS(SELECT 1 FROM heads h JOIN events e ON e.id=h.event_id
      WHERE h.entity_id=c.entity_id AND fengzaiy_search(e.json,?))` : ''}
    ORDER BY updated DESC,first_head ASC ${bounded ? 'LIMIT ?' : ''}`).all(...args).map(row => row.entity_id);
}
