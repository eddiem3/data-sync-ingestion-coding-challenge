import { Pool } from 'pg';

export interface ApiEvent {
  id: string;
  sessionId: string;
  userId: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  timestamp: number | string;
  session: {
    id: string;
    deviceType: string;
    browser: string;
  };
}

export interface Checkpoint {
  lastCursor: string | null;
  eventsIngested: number;
  completed: boolean;
}

export async function setupDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingested_events (
      id          UUID PRIMARY KEY,
      session_id  UUID,
      user_id     UUID,
      type        TEXT,
      name        TEXT,
      properties  JSONB,
      timestamp   TIMESTAMPTZ,
      device_type TEXT,
      browser     TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingestion_state (
      id              INT PRIMARY KEY DEFAULT 1,
      last_cursor     TEXT,
      events_ingested BIGINT DEFAULT 0,
      completed       BOOLEAN DEFAULT FALSE,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function batchInsertEvents(pool: Pool, events: ApiEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const ids: string[] = [];
  const sessionIds: string[] = [];
  const userIds: string[] = [];
  const types: string[] = [];
  const names: string[] = [];
  const properties: string[] = [];
  const timestamps: Date[] = [];
  const deviceTypes: string[] = [];
  const browsers: string[] = [];

  for (const event of events) {
    ids.push(event.id);
    sessionIds.push(event.sessionId);
    userIds.push(event.userId);
    types.push(event.type);
    names.push(event.name);
    properties.push(JSON.stringify(event.properties));
    timestamps.push(normalizeTimestamp(event.timestamp));
    deviceTypes.push(event.session.deviceType);
    browsers.push(event.session.browser);
  }

  const result = await pool.query(
    `INSERT INTO ingested_events (id, session_id, user_id, type, name, properties, timestamp, device_type, browser)
     SELECT * FROM unnest(
       $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[],
       $6::jsonb[], $7::timestamptz[], $8::text[], $9::text[]
     )
     ON CONFLICT (id) DO NOTHING`,
    [ids, sessionIds, userIds, types, names, properties, timestamps, deviceTypes, browsers]
  );

  return result.rowCount ?? 0;
}

export async function loadCheckpoint(pool: Pool): Promise<Checkpoint> {
  const result = await pool.query(
    `SELECT last_cursor, events_ingested, completed
     FROM ingestion_state
     WHERE id = 1`
  );

  if (result.rows.length === 0) {
    return { lastCursor: null, eventsIngested: 0, completed: false };
  }

  const row = result.rows[0];
  return {
    lastCursor: row.last_cursor ?? null,
    eventsIngested: Number(row.events_ingested),
    completed: row.completed,
  };
}

export async function saveCheckpoint(pool: Pool, cursor: string | null, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_state (id, last_cursor, events_ingested, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_cursor = EXCLUDED.last_cursor,
       events_ingested = EXCLUDED.events_ingested,
       updated_at = NOW()`,
    [cursor, count]
  );
}

export async function markComplete(pool: Pool, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_state (id, events_ingested, completed, updated_at)
     VALUES (1, $1, TRUE, NOW())
     ON CONFLICT (id) DO UPDATE SET
       events_ingested = EXCLUDED.events_ingested,
       completed = TRUE,
       updated_at = NOW()`,
    [count]
  );
}

function normalizeTimestamp(ts: number | string): Date {
  if (typeof ts === 'number') return new Date(ts);
  return new Date(ts);
}
