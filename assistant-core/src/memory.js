// Conversation memory. Uses Postgres when DATABASE_URL is set, otherwise an
// in-process map (handy for local testing without a DB).
//
// For LLM context we return a simplified rolling window of user/assistant *text*
// turns. The within-turn tool_use / tool_result blocks live in the agent loop's
// working array; they are also persisted for audit but not replayed as history,
// which keeps cross-turn context robust and simple.

import { config } from "./config.js";
import * as db from "./db.js";

const mem = new Map(); // sessionId -> [{ role, content, ... }]

export async function ensureSession(id, channel, title) {
  if (db.hasDb()) return db.ensureSession(id, channel, title);
  if (!mem.has(id)) mem.set(id, []);
}

export async function append(row) {
  if (db.hasDb()) return db.insertMessage(row);
  const arr = mem.get(row.sessionId) || [];
  arr.push(row);
  mem.set(row.sessionId, arr);
}

// Session list / titles (DB-backed; in-memory fallback is minimal).
export async function listSessions(channel, limit = 100) {
  if (db.hasDb()) return db.listSessions(channel, limit);
  return [...mem.keys()]
    .filter((id) => id.startsWith(channel + ":"))
    .map((id) => ({ id, title: null, created_at: null, updated_at: null }));
}
export async function setTitleIfEmpty(id, title) {
  if (db.hasDb()) return db.setTitleIfEmpty(id, title);
}
export async function renameSession(id, title) {
  if (db.hasDb()) return db.renameSession(id, title);
}

// Full-ish history for display in the dashboard (oldest-first), capped larger.
export async function getHistory(sessionId, limit = 200) {
  let rows;
  if (db.hasDb()) {
    rows = await db.recentMessages(sessionId, limit);
  } else {
    rows = (mem.get(sessionId) || []).slice(-limit);
  }
  return rows
    .filter((r) => (r.role === "user" || r.role === "assistant") && r.content)
    .map((r) => ({ role: r.role, content: r.content }));
}

// Returns [{ role: "user"|"assistant", content }] oldest-first, capped.
export async function getContext(sessionId) {
  let rows;
  if (db.hasDb()) {
    rows = await db.recentMessages(sessionId, config.memoryWindow * 2);
  } else {
    rows = (mem.get(sessionId) || []).slice(-config.memoryWindow * 2);
  }
  return rows
    .filter((r) => (r.role === "user" || r.role === "assistant") && r.content)
    .map((r) => ({ role: r.role, content: r.content }))
    .slice(-config.memoryWindow);
}
