// Postgres access: a single pool, startup migration, and thin query helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

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

// Run the SQL migrations on startup. Safe to call repeatedly (IF NOT EXISTS).
export async function migrate() {
  if (!hasDb()) return;
  const file = path.join(__dirname, "..", "migrations", "001_init.sql");
  const sql = await fs.readFile(file, "utf8");
  await getPool().query(sql);
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
