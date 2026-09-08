# Phase 1 — Dashboard + Interactive Text Chat (breakdown)

Goal: a self-hosted, **tailnet-only** web dashboard where Sebastian can chat with the
assistant (streaming text), see today's calendar, explore the second-brain graph, and
see the available capabilities/health. Both the dashboard and Telegram free-text share
one brain (**assistant-core**); slash-commands keep using the **Router**.

Out of scope for Phase 1: voice (Whisper/Piper), wake word, Qdrant/RAG. Those are
Phases 2–3.

Legend: each task has an ID, and an **AC** (acceptance criteria). Suggested execution
order is in §8.

---

## WS-A — assistant-core service (the conversational brain)

Node.js (Fastify) service on the compose/tailscale network. Owns conversation memory
and the LLM tool-calling loop.

- **A1. Scaffold service.** Fastify app, `Dockerfile`, compose entry
  `assistant-core` on the tailscale network (no Funnel). Config via env:
  `ANTHROPIC_API_KEY`, `OLLAMA_URL`, `HERMES_URL`, `N8N_WEBHOOK_BASE`,
  `DATABASE_URL` (Postgres), `ALLOWED_GOOGLE_EMAILS`.
  **AC:** `GET /health` returns 200 from another tailnet node.
- **A2. Postgres schema.** Tables `chat_session(id, channel, created_at, ...)` and
  `chat_message(id, session_id, role, content, tool_calls, created_at)`. Reuse the
  existing Postgres instance (new DB or schema).
  **AC:** migration runs; rows insert/select.
- **A3. LLM adapter with function-calling.** Anthropic Messages API with `tools`
  (primary); Ollama `/api/chat` with `tools` as fallback when `ANTHROPIC_API_KEY`
  is empty or the call fails. (Note: Hermes `claude_chat` is prompt/response only,
  so the *agent* loop talks to the LLM directly; Hermes stays for brain tools.)
  **AC:** a prompt with one tool definition returns a tool_use call.
- **A4. Tool registry + dispatcher.** Load `tools.manifest.json` (WS-B), convert each
  descriptor to an LLM tool definition, and dispatch invocations by endpoint type:
  `n8n_webhook` (HTTP POST to n8n) or `hermes_tool` (HTTP POST to Hermes). Hot-reload
  on file change.
  **AC:** a tool call from the model reaches the right endpoint and the result is fed
  back to the model.
- **A5. Agent loop.** message → model → (execute tool calls → append results → loop)
  → final answer. Support multiple tool calls per turn and clarifying questions
  (model may ask before acting).
  **AC:** "agenda reunión con Ana mañana 3pm y créame un task para preparar la agenda"
  triggers *two* tools and a combined reply.
- **A6. Streaming chat endpoint.** `POST /chat/stream` (SSE): input
  `{session_id, message, channel}`; stream assistant tokens + `tool_call`/`tool_result`
  events. Also `POST /chat` (non-stream) for Telegram.
  **AC:** curl the SSE endpoint and see tokens stream.
- **A7. Session memory.** Load a rolling window of recent turns for the `session_id`,
  persist new turns. Telegram uses `chat_id` as session; dashboard uses a per-login id.
  **AC:** "créalo" in a follow-up message resolves against the previous turn.

## WS-B — tool manifest + tool endpoints

- **B1. `tools.manifest.json`.** Author the schema (see roadmap §4) and the initial
  tool set: `create_task`, `create_event`, `list_today_events`, `save_note`,
  `search_brain` (list/read). Each with name, description, `input_schema`, `endpoint`,
  `channels`, `icon`.
  **AC:** manifest validates against the schema; assistant-core loads it.
- **B2. n8n webhook sub-workflows.** Create Webhook-triggered sub-workflows for
  `create_task` (Linear), `create_event` + `list_today_events` (Google Calendar),
  reusing the existing node logic. Each accepts JSON input and returns JSON result.
  **AC:** `curl` each webhook returns the expected result (task/event created/listed).
- **B3. Brain tools via Hermes.** Point `save_note` → Hermes `note_save`,
  `search_brain` → Hermes `brain_list` (+ read), using `hermes_tool` endpoints. No new
  n8n workflow needed.
  **AC:** assistant-core can save and list notes through the manifest.

## WS-C — `brain_graph` tool (Hermes)

- **C1. Implement `brain_graph` in `gateway.js`.** Walk the vault, build
  `{ nodes:[{id, title, folder, tags, url}], edges:[{source, target, type}] }` where
  edges come from `[[wikilinks]]` and/or shared tags. Read-only. Include the GitHub
  blob URL per note (reuse the `HERMES_BRAIN_WEB_URL` logic).
  **AC:** `POST /tool/brain_graph` returns valid graph JSON.
- **C2. Rebuild Hermes.** `docker compose up -d --build --no-deps hermes-gateway`.
  **AC:** the new tool responds in the running container.

## WS-D — dashboard SPA

React + Vite. Served by its own container (nginx) or by assistant-core; **tailnet-only**.

- **D1. Scaffold + deploy.** Vite React app, `Dockerfile`, compose entry `dashboard`
  on the tailscale network (no Funnel). Base layout: left chat panel, right widget grid.
  **AC:** dashboard loads from a tailnet device.
- **D2. Chat panel.** Connect to `POST /chat/stream` (SSE); render streaming tokens,
  tool-call/results as inline chips, and message history. Text input (voice comes in
  Phase 2 — leave a disabled mic button placeholder).
  **AC:** send a message, see it stream, tools reflected in the UI.
- **D3. Calendar widget.** Show today's events via `list_today_events`. Time + title,
  "all day" handling, PR timezone.
  **AC:** widget shows the same events as `/calendar` in Telegram.
- **D4. Brain graph widget.** `react-force-graph` fed by `brain_graph`; node color by
  folder, hover shows tags, click opens the GitHub note URL.
  **AC:** graph renders; clicking a node opens the note on GitHub.
- **D5. Capabilities / status panel.** List tools from `GET /tools` (manifest) with
  icons, and health of assistant-core / Hermes / n8n.
  **AC:** panel lists current capabilities and service health.

## WS-E — Google OAuth (auth)

- **E1. Google OAuth client.** In the existing Google Cloud project, add a Web OAuth
  client for the dashboard; set the redirect URI. Scope: `openid email profile`.
  **AC:** consent screen reachable; client id/secret issued.
- **E2. assistant-core auth.** Verify Google OIDC token, issue a session cookie,
  enforce `ALLOWED_GOOGLE_EMAILS` allowlist. Protect all chat/tool endpoints.
  **AC:** requests without a valid allowlisted session are 401.
- **E3. Dashboard login flow.** "Sign in with Google" gate; app hidden until authed.
  **AC:** only Sebastian's Google account can enter; others rejected.

## WS-F — Telegram delegation

- **F1. Route free-text to assistant-core.** In the cerebro workflow, send
  non-command / chat intents to assistant-core (`POST /chat`) using `chat_id` as
  `session_id`, instead of the current direct Ollama chat. Slash-commands unchanged
  (Router).
  **AC:** a free-text Telegram message goes through the agent (memory + tools) and
  replies; `/task`, `/note`, etc. still go through the Router.

## WS-G — deployment & security

- **G1. Compose additions.** Add `assistant-core` and `dashboard` services on the
  tailscale network. (Qdrant is Phase 3 — not added now.)
  **AC:** `docker compose up -d` brings both up healthy.
- **G2. Tailnet-only exposure.** Neither service behind Funnel; reachable only via
  MagicDNS on the tailnet. Funnel stays reserved for the Telegram webhook.
  **AC:** services are not reachable from the public internet; reachable on tailnet.
- **G3. Secrets.** All new keys (Anthropic, Google client secret, DB) in `.env`;
  nothing in the brain repo.
  **AC:** `.env.example` updated; no secrets committed.

---

## 8. Suggested execution order

1. **A1–A3** — assistant-core skeleton + LLM adapter (validate with a single hardcoded
   tool via curl).
2. **C1–C2 + B1–B3** — brain_graph tool and the manifest/tool endpoints.
3. **A4–A7** — wire the registry, full agent loop, streaming, memory.
4. **D1–D5** — dashboard (chat first, then calendar, brain graph, status).
5. **E1–E3** — Google auth in front of everything.
6. **F1** — delegate Telegram free-text to assistant-core.
7. **G1–G3** — finalize compose, tailnet-only, secrets.

## 9. Definition of done (Phase 1)

- Open the dashboard on a tailnet device, sign in with Google (allowlisted).
- Chat with streaming replies; the assistant can create a task, create/list calendar
  events, and save/list brain notes through natural language, remembering context
  across turns.
- Calendar widget shows today's events; brain graph renders and links to GitHub;
  capabilities panel lists tools + service health.
- Telegram free-text uses the same brain; slash-commands still use the Router.
- Everything tailnet-only; secrets in `.env`.
