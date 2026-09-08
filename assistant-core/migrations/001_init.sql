-- assistant-core schema: conversation sessions and messages.
-- Runs automatically on startup (see src/db.js).

CREATE TABLE IF NOT EXISTS chat_session (
  id          TEXT PRIMARY KEY,           -- e.g. "telegram:1514329989" or "dashboard:<uuid>"
  channel     TEXT NOT NULL,              -- "telegram" | "dashboard"
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_message (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,              -- "user" | "assistant" | "tool"
  content     TEXT,                       -- text content (for user/assistant)
  tool_calls  JSONB,                      -- assistant tool_use blocks, if any
  tool_name   TEXT,                       -- for role=tool
  tool_result JSONB,                      -- for role=tool
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_message_session
  ON chat_message (session_id, created_at);
