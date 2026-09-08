// Postgres access: a single pool, startup migration, and thin query helpers.
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// Schema is inlined (not read from a file) so it can never be missed by a
// Docker build. Keep migrations/001_init.sql in sync for reference/tooling.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_session (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_message (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT,
  tool_calls  JSONB,
  tool_name   TEXT,
  tool_result JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_message_session
  ON chat_message (session_id, created_at);
`;

let pool = null;

export function hasDb() {
  return Boolean(config.databaseUrl);
}

export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  }
  return pool;
}

// Run the schema migration on startup. Safe to call repeatedly (IF NOT EXISTS).
export async function migrate() {
  if (!hasDb()) return;
  await getPool().query(SCHEMA_SQL);
}

export async function ensureSession(id, channel, title) {
  await getPool().query(
    `INSERT INTO chat_session (id, channel, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
    [id, channel, title || null]
  );
}

export async function insertMessage(row) {
  const { sessionId, role, content, toolCalls, toolName, toolResult } = row;
  await getPool().query(
    `INSERT INTO chat_message (session_id, role, content, tool_calls, tool_name, tool_result)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sessionId,
      role,
      content ?? null,
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolName ?? null,
      toolResult ? JSON.stringify(toolResult) : null,
    ]
  );
}

// Most recent messages for a session, oldest-first, capped to `limit`.
export async function recentMessages(sessionId, limit) {
  const { rows } = await getPool().query(
    `SELECT role, content, tool_calls, tool_name, tool_result
       FROM chat_message
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sessionId, limit]
  );
  return rows.reverse();
}
