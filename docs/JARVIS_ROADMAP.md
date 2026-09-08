# Jarvis Roadmap — Cerebro Personal Assistant

Evolving the Telegram-driven "Cerebro" into a multi-channel, voice-capable,
productivity-focused personal assistant with a self-hosted dashboard.

Owner: Sebastian Sterling (DevSecOps, Expert Radiology).
Scope of this document: the **automation/assistant layer** (n8n, Hermes gateway,
new assistant-core + voice services, dashboard). Infrastructure (Proxmox, k3s,
Tailscale, NFS, GPU provisioning) is out of scope and owned separately.

---

## 1. Decisions locked in

- **Voice backend:** self-hosted. Whisper (STT) + Piper (TTS), running on the GPU
  node (Sadida). Private, no per-use cost, consistent with the local-first stack.
- **Voice activation:** both, phased — push-to-talk first, wake word ("Hey Jarvis")
  later.
- **First milestone:** dashboard + interactive text chat.

### Hard constraint: Telegram cannot do calls
The Telegram **Bot API does not support voice/video calls**. Bots can only
send/receive *voice messages* (audio files). Real-time spoken conversation lives
in the **dashboard** (browser mic + WebRTC/streaming). On Telegram we achieve
"voice" by transcribing incoming voice notes and optionally replying with a TTS
voice note.

---

## 2. Target architecture

```
                         ┌──────────────────────────────┐
   Telegram  ───────────▶│            n8n                │  (integration hub:
   (text + voice notes)  │  cerebro workflow + tool      │   Linear, Google
                         │  sub-workflows via webhooks   │   Calendar, brain, …)
                         └───────────────┬──────────────┘
                                         │  (tool calls / results)
   Dashboard (browser)                   ▼
   ├─ chat (SSE stream)   ┌──────────────────────────────┐
   ├─ push-to-talk  ─────▶│        assistant-core         │◀── LLM: Claude
   ├─ brain graph         │  • conversation memory        │     (Qwen fallback,
   ├─ today's calendar    │  • LLM tool-calling loop      │      both via Hermes)
   └─ capabilities/status │  • tool registry (manifest)   │
                          └───────┬───────────────┬──────┘
                                  │               │
                          ┌───────▼──────┐  ┌─────▼───────┐
                          │  Whisper STT │  │  Piper TTS  │   (GPU node: Sadida)
                          └──────────────┘  └─────────────┘

   Hermes gateway stays as the low-level tool/LLM provider (claude_chat,
   ollama_chat, note_save, brain_list, brain_graph, fs/shell, …).
```

### Component responsibilities

- **assistant-core (new service):** the single "brain" for **natural-language /
  conversational** input. Maintains per-channel conversation state, runs the LLM
  function-calling loop (multi-tool chaining, clarifying questions), dispatches tool
  calls, and exposes a streaming chat API. Both the dashboard and n8n/Telegram talk
  to it, so behavior is identical across channels.
- **Router (kept):** the existing n8n Switch stays as the deterministic front for
  **explicit slash-commands** (`/task`, `/note`, `/calendar`, …) — fast, cheap,
  predictable. Only free-form messages (dashboard chat, voice, non-command Telegram
  text) are delegated to assistant-core. Router and assistant-core **coexist and call
  the same tools** via the manifest. See §10 for the rationale.
- **n8n:** stays the **tool execution / integration hub**. Each capability is an
  n8n sub-workflow behind a Webhook trigger. Adding an integration = add a
  sub-workflow + a manifest entry (see §4). The existing cerebro workflow keeps
  handling the Telegram trigger and the Router.
- **Hermes gateway:** unchanged role — provides `claude_chat`, `ollama_chat`,
  brain read/write tools, and gets a new `brain_graph` tool. assistant-core uses
  Hermes for LLM + brain access.
- **Whisper (STT) / Piper (TTS):** small HTTP microservices on the GPU node.
- **Dashboard:** self-hosted SPA. **Tailnet-only** (see §5 Security).

---

## 3. Feature map

| Feature | Channel | Backend |
| --- | --- | --- |
| Interactive text chat (streaming) | Dashboard, Telegram | assistant-core + Hermes LLM |
| Voice input | Dashboard (mic), Telegram (voice notes) | Whisper |
| Voice output | Dashboard, Telegram (optional) | Piper |
| Wake word "Hey Jarvis" | Dashboard | openWakeWord (browser) |
| Second-brain graph | Dashboard | `brain_graph` (Hermes) + force-graph |
| Today's calendar | Dashboard, Telegram (/calendar) | Google Calendar via n8n |
| Capabilities / status panel | Dashboard | tool manifest + health checks |
| Existing commands (task, note, plan, show_brain, schedule, …) | Telegram, Dashboard | n8n tool sub-workflows |

---

## 4. Extensibility model (core design goal)

Everything the assistant can do is a **tool descriptor**:

```jsonc
{
  "name": "create_task",
  "description": "Create a task/issue in Linear from a title and optional description.",
  "input_schema": {                     // JSON Schema — used for LLM function calling
    "type": "object",
    "properties": {
      "title":       { "type": "string" },
      "description": { "type": "string" }
    },
    "required": ["title"]
  },
  "endpoint": {                         // where assistant-core dispatches the call
    "type": "n8n_webhook",             // or "hermes_tool"
    "url": "http://127.0.0.1:5678/webhook/tool/create_task"
  },
  "channels": ["dashboard", "telegram"], // where it is offered/shown
  "icon": "check-square"                 // for the capabilities panel
}
```

- All descriptors live in a single **`tools.manifest.json`** (versioned in the repo).
- assistant-core loads the manifest at startup (hot-reload on change), converts each
  descriptor into an LLM function-calling definition, and dispatches invocations to
  the declared endpoint.
- The dashboard reads the same manifest to render the **capabilities panel**
  automatically.

**Adding a new tool in the future = 2 steps, no agent code changes:**
1. Build an n8n sub-workflow with a Webhook trigger that accepts the tool input and
   returns a JSON result.
2. Add its descriptor to `tools.manifest.json`.

The LLM can then call it, and it appears in the dashboard. This is the mechanism
that makes the assistant "adapt easily to any future n8n tool."

---

## 5. Security

- **Dashboard is tailnet-only.** Do **not** put it behind Tailscale Funnel. Serve it
  on the tailnet (MagicDNS name, no public exposure); only your Tailscale devices
  reach it. Funnel stays reserved for the Telegram webhook, which is the only piece
  that genuinely needs public reachability.
- **assistant-core and voice services** listen only on the tailscale/compose network.
- **Auth on the dashboard: Google OAuth (OIDC)**, even on the tailnet, restricted to
  an allowlist of Google accounts (Sebastian's). Reuse the same Google Cloud project
  as the Calendar credential. Result = double lock: private network (tailnet) +
  identity (Google), so a compromised device on the tailnet is not automatically an
  open mic.
- **Secrets** stay in `.env`. Never write tokens/keys into the brain repo (it syncs
  to GitHub).

---

## 6. Conversation memory

- **Short-term:** per-channel session (Telegram `chat_id`, dashboard session id).
  Rolling window of recent turns kept in Postgres (already running) or Redis.
- **Long-term (Phase 3):** semantic memory over the brain vault — embed notes
  (Ollama embeddings), store vectors, and retrieve relevant notes to ground answers
  (RAG). Lets Jarvis answer "what did I decide about X?" from your own notes.
  **Vector store: Qdrant** (chosen — runs as a container on the homelab; also a good
  chance to practice a production-grade vector DB). It scales well, offers rich
  payload filtering and snapshots, and exposes a clean REST/gRPC API. Trade-off vs.
  the embedded alternative:
  - *Qdrant (chosen):* standalone service, scales to millions, rich payload filtering
    and production features; one extra container to run and back up.
  - *sqlite-vec / sqlite-vss:* embedded single-file, zero infra; simpler but limited
    filtering and not meant for very large collections.

---

## 7. Phased plan

### Phase 0 — Foundations (prep)
- Define `tools.manifest.json`; wrap existing capabilities (task, note, plan,
  calendar, brain) as descriptors.
- Stand up **assistant-core** with a text chat endpoint that runs the tool-calling
  loop using Hermes for the LLM. No UI yet — validate via curl.
- Add a `brain_graph` tool to Hermes (parse vault: notes as nodes, `[[wikilinks]]`
  and shared tags as edges) returning `{nodes, edges}` JSON.

### Phase 1 — Dashboard + interactive text chat  ← START HERE
- SPA (React + Vite), served by a container, **tailnet-only**.
- Chat panel with streaming responses (SSE) against assistant-core.
- Calendar widget (today's Google Calendar events).
- Second-brain graph widget (force-directed, from `brain_graph`).
- Capabilities/status panel (from the manifest + service health checks).
- Wire Telegram's cerebro workflow to delegate "chat" intents to assistant-core so
  both channels share one brain.

### Phase 2 — Voice
- Deploy **Whisper** (faster-whisper) and **Piper** as HTTP services on the GPU node.
- Dashboard **push-to-talk**: record mic → Whisper → chat → response → Piper playback.
- Telegram: n8n downloads incoming voice notes → Whisper → text → assistant-core →
  reply (optionally as a Piper-generated voice note).

### Phase 3 — Jarvis polish
- **Wake word** "Hey Jarvis" in the dashboard (openWakeWord), with push-to-talk
  fallback.
- Continuous conversation, barge-in, streaming TTS.
- **Long-term memory / RAG** over the brain (embeddings + vector search).

### Phase 4 — Extensibility hardening
- Document and templatize the "add a tool" flow (sub-workflow template + manifest
  entry + optional dashboard icon).
- Optional: auto-generate the manifest from tagged n8n sub-workflows.

---

## 8. Proposed tech stack

- **assistant-core:** Node.js (consistency with Hermes; reuse its LLM/tool patterns).
- **STT/TTS services:** Python (faster-whisper) + Piper (CLI/HTTP wrapper).
- **Dashboard:** React + Vite SPA. Graph: `react-force-graph` / d3-force.
  Charts: Recharts. Streaming: SSE for chat, WebSocket for voice (Phase 2).
- **State:** Postgres (existing) for sessions/memory; Redis optional for speed.
- **Deploy:** new services added to `docker-compose.yaml`, all on the tailscale
  network; dashboard tailnet-only, no Funnel.

---

## 9. Decisions & open questions

Resolved:
- **Dashboard auth:** Google OAuth (OIDC), allowlisted accounts, tailnet-only (§5).
- **Vector store (Phase 3): Qdrant** (containerized), chosen for scale, filtering,
  and hands-on practice (§6).
- **Router vs assistant-core:** keep both — Router for slash-commands, assistant-core
  for conversation (§10).
- **TTS:** Piper; voice/language selection happens in **Phase 2**, when voice is wired
  into the dashboard chat (not needed for Phase 1 text chat).

Still open:
- assistant-core migration order: which conversational paths move first (dashboard
  chat vs. Telegram free-text).
- Piper voice choice (es vs en, specific voice model) — decide at Phase 2.

---

## 10. Rationale: keep the Router, add assistant-core

The Router (n8n Switch) is excellent for **explicit, deterministic commands** and
stays. assistant-core is added for what the Router structurally cannot do:

| Capability | Router (Switch) | assistant-core (agent) |
| --- | --- | --- |
| Explicit slash-commands | ✅ ideal | ✅ (delegates to same tools) |
| Conversation memory / follow-ups | ❌ (stateless; /plan confirm is a static-data hack) | ✅ native |
| Multiple tools in one message | ❌ picks one branch | ✅ chains tools |
| Clarifying questions | ❌ | ✅ |
| RAG-grounded answers from the brain | ❌ | ✅ (Phase 3) |
| Streaming chat UX (dashboard) | ❌ awkward in n8n | ✅ |

Free-form messages (dashboard chat, voice, non-command Telegram text) go to
assistant-core; slash-commands keep going through the Router. Both invoke the same
tool sub-workflows via the manifest, so there is one source of truth for capabilities.
