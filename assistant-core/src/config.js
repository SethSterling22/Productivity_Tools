// Central configuration, read once from the environment.
// All values have safe local-dev defaults; production values come from .env
// (see n8n/.env.example). Never hard-code secrets here.

import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function list(v) {
  return (v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Assistant persona name (the project is "Cerebro"; the assistant is "Rebeca").
const assistantName = process.env.ASSISTANT_NAME || "Rebeca";

export const config = {
  assistantName,

  port: Number(process.env.PORT || 8090),

  // ── LLM: Anthropic primary, Ollama fallback ────────────────────────────────
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ASSISTANT_MODEL || "claude-sonnet-4-6",
  anthropicVersion: process.env.ANTHROPIC_VERSION || "2023-06-01",
  maxTokens: Number(process.env.ASSISTANT_MAX_TOKENS || 1024),

  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  ollamaModel: process.env.ASSISTANT_FALLBACK_MODEL || "qwen3.5:4b",

  // ── Tool backends ──────────────────────────────────────────────────────────
  hermesUrl: process.env.HERMES_URL || "http://127.0.0.1:8080",
  n8nWebhookBase: process.env.N8N_WEBHOOK_BASE || "http://127.0.0.1:5678/webhook",

  // ── Persistence ────────────────────────────────────────────────────────────
  databaseUrl: process.env.DATABASE_URL || "",
  memoryWindow: Number(process.env.MEMORY_WINDOW || 20), // turns kept in context

  // ── Auth (Phase 1: Google OAuth is enforced at the edge; allowlist here) ────
  allowedEmails: list(process.env.ALLOWED_GOOGLE_EMAILS),

  // ── Tool manifest ──────────────────────────────────────────────────────────
  manifestPath: process.env.TOOLS_MANIFEST || path.join(__dirname, "..", "tools.manifest.json"),

  // Max tool-calling iterations per user turn (guards against loops).
  maxAgentSteps: Number(process.env.MAX_AGENT_STEPS || 6),

  systemPrompt:
    process.env.ASSISTANT_SYSTEM_PROMPT ||
    [
      `You are ${assistantName}, the personal assistant of Sebastian Sterling, DevSecOps Engineer at Expert Radiology (Puerto Rico).`,
      "You help with productivity: tasks (Linear), notes (the git-backed second brain), calendar (Google Calendar), and general questions.",
      "You have context on his k3s home lab (Sadida, Ocra, Sram, Xelor, Sacro, Aery).",
      "Be direct, concise and technical. Respond in the user's language (usually Spanish).",
      "Use the provided tools when the user wants to create/read/update something. Ask a brief clarifying question if a required detail is missing.",
      "The user's timezone is America/Puerto_Rico (UTC-04:00, no DST).",
    ].join(" "),
};
