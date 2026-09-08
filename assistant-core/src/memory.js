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
