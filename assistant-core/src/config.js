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

  // ── Multi-model routing ────────────────────────────────────────────────────
  // Task-specialized routing across Ollama hosts, with Claude as last resort.
  // Turn off with MODEL_ROUTING=off to fall back to "Claude primary, Ollama one".
  modelRouting: process.env.MODEL_ROUTING !== "off",
  // Ollama hosts by name. sadida = always-on light tier; omarchy = strong tier.
  ollamaHosts: {
    sadida: process.env.OLLAMA_SADIDA_URL || process.env.OLLAMA_URL || "http://sadida.stegosaurus-panga.ts.net:11434",
    omarchy: process.env.OLLAMA_OMARCHY_URL || "http://omarchy.stegosaurus-panga.ts.net:11434",
  },
  // Optional JSON override of the category→chain table (see router.js DEFAULT_ROUTES).
  modelRoutesJson: process.env.MODEL_ROUTES || "",

  // ── Tool backends ──────────────────────────────────────────────────────────
  hermesUrl: process.env.HERMES_URL || "http://127.0.0.1:8080",
  n8nWebhookBase: process.env.N8N_WEBHOOK_BASE || "http://127.0.0.1:5678/webhook",

  // Self-hosted SearXNG (metasearch) for the web_search builtin. Reached by
  // Docker DNS on n8n_network, like Qdrant. No API key needed.
  searxngUrl: process.env.SEARXNG_URL || "http://searxng:8080",

  // ── RAG / long-term memory (Qdrant + Ollama embeddings over the brain) ──────
  qdrantUrl: process.env.QDRANT_URL || "http://qdrant:6333",
  embedModel: process.env.EMBED_MODEL || "nomic-embed-text",
  brainPath: process.env.BRAIN_PATH || "/hermes/brain",

  // ── RAG (long-term memory over the second brain) ───────────────────────────
  qdrantUrl: process.env.QDRANT_URL || "http://qdrant:6333",
  embedModel: process.env.EMBED_MODEL || "nomic-embed-text",
  embedDim: Number(process.env.EMBED_DIM || 768),
  brainPath: process.env.BRAIN_PATH || "/hermes-workspace/brain",
  brainWebUrl: process.env.BRAIN_WEB_URL || "https://github.com/SethSterling22/Brain",
  brainBranch: process.env.BRAIN_BRANCH || "main",
  ragCollection: process.env.RAG_COLLECTION || "brain",

  // ── Voice services (STT/TTS) ───────────────────────────────────────────────
  // Preference-ordered lists: assistant-core uses the first host that answers a
  // quick /health (e.g. omarchy when your desktop is on, else sadida).
  // WHISPER_URLS / PIPER_URLS are comma-separated; fall back to the single *_URL.
  whisperUrls: list(process.env.WHISPER_URLS).length
    ? list(process.env.WHISPER_URLS)
    : [process.env.WHISPER_URL || "http://whisper:8100"],
  piperUrls: list(process.env.PIPER_URLS).length
    ? list(process.env.PIPER_URLS)
    : [process.env.PIPER_URL || "http://piper:8200"],

  // ── Persistence ────────────────────────────────────────────────────────────
  databaseUrl: process.env.DATABASE_URL || "",
  memoryWindow: Number(process.env.MEMORY_WINDOW || 20), // turns kept in context

  // ── Auth: Google OAuth (OIDC). Disabled until GOOGLE_CLIENT_ID is set. ──────
  allowedEmails: list(process.env.ALLOWED_GOOGLE_EMAILS),
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "",
  // Secret used to sign session cookies. Set it in .env so sessions survive restarts.
  sessionSecret: process.env.SESSION_SECRET || ("dev-insecure-" + Math.random().toString(36).slice(2)),
  // Shared secret for internal service-to-service calls (n8n -> assistant-core),
  // so they bypass the Google OAuth gate. Sent as the X-Internal-Token header.
  internalToken: process.env.INTERNAL_TOKEN || "",
  // Secret that lets the Galaxy Watch use the /watch voice UI without the Google
  // login flow. Presented once in the URL (?wt=TOKEN), then kept in a signed
  // cookie. Scoped to the watch page + the endpoints it needs (see index.js).
  watchToken: process.env.WATCH_TOKEN || "",

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
