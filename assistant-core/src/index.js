// assistant-core HTTP API.
//   GET  /health         -> liveness + basic status
//   GET  /tools          -> the capability manifest (for the dashboard panel)
//   POST /chat           -> { session_id, message, channel } -> { response }
//   POST /chat/stream    -> same input, streams SSE events (text/tool_call/tool_result/done)
//
// Auth (Google OAuth allowlist) is added in WS-E; for now the service is
// tailnet-only. Do not expose it via Tailscale Funnel.

import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { migrate, hasDb } from "./db.js";
import { loadManifest, watchManifest, listTools, dispatch } from "./tools.js";
import { runAgent } from "./agent.js";
import * as memory from "./memory.js";
import * as rag from "./rag.js";
import { authEnabled, loginUrl, exchangeCode, emailAllowed, secureCookies } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

const SESSION = "rebeca_session";
const OAUTH_STATE = "rebeca_oauth_state";
const cookieOpts = () => ({ httpOnly: true, sameSite: "lax", path: "/", signed: true, secure: secureCookies() });

// Gate every route except /health and /auth/* once Google OAuth is configured.
// IMPORTANT: this hook must be installed AFTER @fastify/cookie is registered,
// otherwise req.cookies is not populated when it runs (causes a login loop).
function installAuthGate() {
  app.addHook("onRequest", async (req, reply) => {
    if (!authEnabled()) return;
    const p = req.url.split("?")[0];
    if (p === "/health" || p.startsWith("/auth/")) return;
    // Internal service-to-service calls (n8n/Telegram) bypass OAuth via a shared token.
    if (config.internalToken && req.headers["x-internal-token"] === config.internalToken) return;
    const raw = req.cookies?.[SESSION];
    const un = raw ? req.unsignCookie(raw) : { valid: false };
    if (un.valid && emailAllowed(un.value)) return;
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    if (wantsHtml && req.method === "GET") return reply.redirect("/auth/login");
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  });
}

app.get("/health", async () => ({
  ok: true,
  db: hasDb(),
  tools: listTools().length,
  llm: config.anthropicKey ? "anthropic+ollama" : "ollama",
}));

app.get("/tools", async () => ({ tools: listTools() }));

// Re-index the second brain into Qdrant (run after adding/changing notes).
app.post("/brain/reindex", async (req, reply) => {
  try {
    return await rag.reindexBrain();
  } catch (err) {
    return reply.code(500).send({ ok: false, error: err.message });
  }
});

// Incrementally index a single note (used by the Telegram /note flow).
app.post("/brain/index-note", async (req, reply) => {
  const p = req.body && req.body.path;
  if (!p) return reply.code(400).send({ ok: false, error: "path required" });
  try {
    return await rag.indexNoteByPath(p);
  } catch (err) {
    return reply.code(500).send({ ok: false, error: err.message });
  }
});

// Conversation history for a session (so the dashboard restores it on reload).
app.get("/chat/history", async (req) => {
  const sid = req.query && req.query.session_id;
  if (!sid) return { messages: [] };
  return { messages: await memory.getHistory(sid) };
});

// List recent conversations (for the dashboard switcher).
app.get("/chat/sessions", async (req) => {
  const channel = (req.query && req.query.channel) || "dashboard";
  return { sessions: await memory.listSessions(channel, 100) };
});

// Rename a conversation.
app.post("/chat/session/rename", async (req) => {
  const { session_id, title } = req.body || {};
  if (!session_id) return { ok: false, error: "session_id required" };
  await memory.renameSession(session_id, String(title || "").slice(0, 120));
  return { ok: true };
});

// ── Google OAuth routes ────────────────────────────────────────────────────
app.get("/auth/login", async (req, reply) => {
  if (!authEnabled()) return reply.redirect("/");
  const state = crypto.randomBytes(16).toString("hex");
  reply.setCookie(OAUTH_STATE, state, { ...cookieOpts(), maxAge: 600 });
  return reply.redirect(loginUrl(state));
});

app.get("/auth/callback", async (req, reply) => {
  const { code, state } = req.query || {};
  const raw = req.cookies?.[OAUTH_STATE];
  const un = raw ? req.unsignCookie(raw) : { valid: false };
  if (!code || !un.valid || un.value !== state) {
    return reply.code(400).send("Invalid OAuth state. Try again from /auth/login.");
  }
  let email;
  try {
    ({ email } = await exchangeCode(code));
  } catch (err) {
    return reply.code(502).send("Google token exchange failed: " + err.message);
  }
  if (!emailAllowed(email)) return reply.code(403).send("Cuenta no autorizada: " + email);
  reply.setCookie(SESSION, email, { ...cookieOpts(), maxAge: 60 * 60 * 24 * 7 });
  reply.clearCookie(OAUTH_STATE, { path: "/" });
  return reply.redirect("/");
});

app.get("/auth/logout", async (req, reply) => {
  reply.clearCookie(SESSION, { path: "/" });
  return reply.redirect("/auth/login");
});

app.get("/auth/me", async (req) => {
  const raw = req.cookies?.[SESSION];
  const un = raw ? req.unsignCookie(raw) : { valid: false };
  return { authEnabled: authEnabled(), email: un.valid ? un.value : null };
});

// ── Dashboard widget data sources (read-only) ──────────────────────────────
// Today's calendar events, via the list_today_events tool webhook.
app.get("/widgets/calendar", async () => {
  try {
    return await dispatch("list_today_events", {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Second-brain graph, straight from the Hermes brain_graph tool.
app.get("/widgets/brain-graph", async () => {
  try {
    const res = await fetch(`${config.hermesUrl}/tool/brain_graph`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const j = await res.json();
    return j.result || j;
  } catch (err) {
    return { ok: false, error: err.message, nodes: [], edges: [] };
  }
});

// ── Voice proxies (STT/TTS). Deployment-agnostic: point WHISPER_URL/PIPER_URL
//    at Ocra (CPU) now, or a GPU host later — no code change. ──────────────────
// Accept raw audio bytes from the browser (MediaRecorder) and forward to Whisper.
// Accept any audio/* (incl. "audio/webm;codecs=opus") plus octet-stream as raw bytes.
app.addContentTypeParser(/^audio\//, { parseAs: "buffer" }, (req, body, done) => done(null, body));
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (req, body, done) => done(null, body));

// Try voice hosts in preference order: a quick /health gate skips dead hosts fast,
// then run the op; if the op itself fails on a host, fall through to the next one.
async function withVoiceHost(urls, op) {
  let lastErr;
  for (const base of urls) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const h = await fetch(`${base}/health`, { signal: ctl.signal });
      clearTimeout(t);
      if (!h.ok) { lastErr = new Error(`${base} health ${h.status}`); continue; }
    } catch (e) { lastErr = e; continue; }
    try {
      return await op(base);
    } catch (e) { lastErr = e; } // op failed on this host -> try the next
  }
  throw lastErr || new Error("no voice host available");
}

app.post("/voice/transcribe", async (req, reply) => {
  const ct = req.headers["content-type"] || "audio/webm";
  try {
    return await withVoiceHost(config.whisperUrls, async (base) => {
      const fd = new FormData();
      fd.append("file", new Blob([req.body], { type: ct }), "audio.webm");
      const res = await fetch(`${base}/transcribe`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`${base} HTTP ${res.status}`);
      const j = await res.json();
      if (j.ok === false) throw new Error(`${base} STT ${j.error || "error"}`);
      return { ok: true, text: j.text || "", language: j.language, host: base };
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: "STT failed: " + err.message });
  }
});

// Strip Markdown / URLs / emojis so the TTS sounds natural (no "asterisco", no
// reading links aloud).
function forSpeech(s) {
  return String(s || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")            // [text](url) -> text
    .replace(/https?:\/\/[^\s]+/g, "")                   // bare URLs
    .replace(/```[\s\S]*?```/g, " ")                     // code fences
    .replace(/[*_`~#>|]/g, "")                           // markdown symbols
    .replace(/^[\s]*[-•]\s+/gm, "")                      // bullet markers
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "") // emojis/symbols
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

app.post("/voice/speak", async (req, reply) => {
  const text = forSpeech((req.body && req.body.text) || "");
  if (!text.trim()) return reply.code(400).send({ ok: false, error: "empty text" });
  try {
    const buf = await withVoiceHost(config.piperUrls, async (base) => {
      const res = await fetch(`${base}/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`${base} HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    reply.header("Content-Type", "audio/wav");
    return reply.send(buf);
  } catch (err) {
    return reply.code(502).send({ ok: false, error: "TTS failed: " + err.message });
  }
});

app.post("/chat", async (req, reply) => {
  const { session_id, message, channel } = req.body || {};
  if (!session_id || !message) {
    return reply.code(400).send({ ok: false, error: "session_id and message are required" });
  }
  const response = await runAgent({
    sessionId: session_id,
    channel: channel || "api",
    userMessage: message,
  });
  return { ok: true, response };
});

app.post("/chat/stream", async (req, reply) => {
  const { session_id, message, channel } = req.body || {};
  if (!session_id || !message) {
    return reply.code(400).send({ ok: false, error: "session_id and message are required" });
  }

  reply.hijack(); // we write the SSE response manually
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    await runAgent({
      sessionId: session_id,
      channel: channel || "dashboard",
      userMessage: message,
      onEvent: (e) => send(e.type, e),
    });
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    raw.end();
  }
});

async function start() {
  await app.register(cookie, { secret: config.sessionSecret });
  installAuthGate(); // after cookie plugin so req.cookies is populated
  await app.register(cors, { origin: true, credentials: true });
  // Serve the dashboard SPA (tailnet-only; Google OAuth gate arrives in WS-E).
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
  });
  await loadManifest();
  watchManifest();
  if (hasDb()) {
    try {
      await migrate();
    } catch (e) {
      app.log.error("DB migration failed: " + e.message);
    }
  }
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`assistant-core listening on :${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
