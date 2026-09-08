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
import { authEnabled, loginUrl, exchangeCode, emailAllowed, secureCookies } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

const SESSION = "rebeca_session";
const OAUTH_STATE = "rebeca_oauth_state";
const cookieOpts = () => ({ httpOnly: true, sameSite: "lax", path: "/", signed: true, secure: secureCookies() });

// Gate every route except /health and /auth/* once Google OAuth is configured.
app.addHook("onRequest", async (req, reply) => {
  if (!authEnabled()) return;
  const p = req.url.split("?")[0];
  if (p === "/health" || p.startsWith("/auth/")) return;
  const raw = req.cookies?.[SESSION];
  const un = raw ? req.unsignCookie(raw) : { valid: false };
  if (un.valid && emailAllowed(un.value)) return;
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml && req.method === "GET") return reply.redirect("/auth/login");
  return reply.code(401).send({ ok: false, error: "unauthorized" });
});

app.get("/health", async () => ({
  ok: true,
  db: hasDb(),
  tools: listTools().length,
  llm: config.anthropicKey ? "anthropic+ollama" : "ollama",
}));

app.get("/tools", async () => ({ tools: listTools() }));

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
