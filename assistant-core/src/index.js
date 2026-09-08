// assistant-core HTTP API.
//   GET  /health         -> liveness + basic status
//   GET  /tools          -> the capability manifest (for the dashboard panel)
//   POST /chat           -> { session_id, message, channel } -> { response }
//   POST /chat/stream    -> same input, streams SSE events (text/tool_call/tool_result/done)
//
// Auth (Google OAuth allowlist) is added in WS-E; for now the service is
// tailnet-only. Do not expose it via Tailscale Funnel.

import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { migrate, hasDb } from "./db.js";
import { loadManifest, watchManifest, listTools } from "./tools.js";
import { runAgent } from "./agent.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  ok: true,
  db: hasDb(),
  tools: listTools().length,
  llm: config.anthropicKey ? "anthropic+ollama" : "ollama",
}));

app.get("/tools", async () => ({ tools: listTools() }));

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
  await app.register(cors, { origin: true, credentials: true });
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
