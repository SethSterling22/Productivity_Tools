# Productivity Tools — Personal Automation Stack

A self-hosted, multi-channel personal assistant (**"Rebeca"**). You talk to it
from a **web dashboard**, a **Galaxy Watch**, or **Telegram** (text + voice
notes). At the center is **assistant-core**, a service that runs an LLM
tool-calling loop, keeps conversation memory, streams chat, proxies voice
(Whisper/Piper), and answers grounded in your **second brain** (RAG over Qdrant)
and the **live web** (self-hosted SearXNG). It uses **Claude** as the primary LLM
with a **local Ollama** fallback. **n8n** remains the integration hub (Telegram
trigger, slash-command Router, tool sub-workflows), and the **Hermes** gateway
provides low-level brain/fs/shell tools.

> **Architecture, communication diagrams, network exposure (Tailscale Serve /
> Funnel), and the Google OAuth flow are documented in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** The evolution plan lives in
> [`docs/JARVIS_ROADMAP.md`](docs/JARVIS_ROADMAP.md).

This repository is meant to be **reasonably portable**: the code and workflows
are wired to a specific home lab today, but every infrastructure-specific value
is called out in [Adapting to your own setup](#adapting-to-your-own-setup) so the
stack can be lifted onto a similar architecture.

> The infrastructure it currently runs on (Proxmox, k3s, Tailscale, NFS, GPU
> host) is documented in a separate **HomeLab** repository. This repo only owns
> the automation layer.

---

## Architecture

```
   Dashboard (tailnet)  ┐
   Galaxy Watch (funnel) ├─►  assistant-core (Rebeca, :4000)  ─►  LLM (Claude / Ollama)
   Telegram (funnel→n8n) ┘        • agent tool-calling loop         tools:
                                   • memory (Postgres)               • builtin  (web_search, RAG)
                                   • voice proxy (Whisper/Piper)     • Hermes   (brain, fs, shell)
                                   • auth gate (OAuth / tokens)      • n8n      (Linear, Calendar)

   Knowledge: second brain (git) ─► embeddings (Ollama) ─► Qdrant (RAG)
   Web:       web_search ─► self-hosted SearXNG
```

Today the stack runs as a **Docker Compose** deployment (assistant-core + n8n +
Hermes gateway + PostgreSQL + Qdrant + SearXNG + a Tailscale sidecar) on an
always-on host, reaching Ollama and the voice services on GPU hosts over Tailscale.
An optional Kubernetes manifest is included in `hermes-agent/k8s/`.

**See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full component,
communication, network-exposure, and Google-OAuth diagrams.**

---

## Components

| Component | Path | What it does |
| --- | --- | --- |
| **assistant-core (Rebeca)** | `assistant-core/` | Chat API + agent tool-calling loop, memory, voice proxy, auth gate; serves the dashboard and `/watch`. |
| **Dashboard** | `assistant-core/public/index.html` | Web UI: streaming chat, push-to-talk voice, brain graph, calendar, sessions. Tailnet-only (Serve `:8443`). |
| **Watch UI** | `assistant-core/public/watch.html` | Voice-first circular UI for the Galaxy Watch. Public Funnel `:10000` + watch token. |
| **Tool manifest** | `assistant-core/tools.manifest.json` | Declares every capability; hot-reloaded. See `docs/ADDING_A_TOOL.md`. |
| **n8n workflow** | `n8n/cerebro_workflow_v2.json` | Telegram entry point, slash-command Router, tool sub-workflows. |
| **Hermes gateway** | `hermes-agent/mcp-server/gateway.js` | HTTP server on `:8080`; brain/fs/shell tools via `POST /tool/:name`. |
| **Hermes MCP server** | `hermes-agent/mcp-server/server.js` | Native stdio MCP server (same tools) for MCP-native clients. |
| **Voice services** | `voice-services/` | Whisper (STT) + Piper (TTS) on GPU hosts (omarchy/sadida), with health-based failover. |
| **Compose stack** | `n8n/docker-compose.yaml` | assistant-core + n8n + hermes + postgres + qdrant + searxng + tailscale. |
| **Launch guide** | `LAUNCH.md` | Step-by-step bring-up. |

Hermes tools: `fs_list`, `fs_read`, `fs_write`, `fs_delete` (gated), `shell_exec`
(allowlist or unrestricted), `note_save` (git-backed notes), `ollama_chat`,
`claude_chat` (auto-falls back to Qwen when no API key or on failure). All
capabilities are **locked down by default** and enabled per-need through env
toggles (see `n8n/.env.example`).

---

## Routing model

> Note: this decision path applies to **Telegram slash-commands**. Free-form
> conversation (dashboard, watch, voice, non-command Telegram text) is delegated to
> **assistant-core (Rebeca)**, which runs its own LLM tool-calling loop over the
> tool manifest. Router and assistant-core call the same tools.

Every incoming Telegram message flows through the same decision path:

1. **Extract message** — normalize the Telegram payload (`raw_text`, `chat_id`).
2. **Fast route** — short-circuits without spending the classifier:
   - Slash commands go straight to an agent: `/claude`, `/task`, `/note`,
     `/content`, `/progress`, `/qwen`, `/chat` (the command token is stripped).
   - Prompts longer than **1500 characters** go straight to Claude.
3. **Classifier (Qwen 1.7b)** — only runs when Fast route did not decide. It
   returns an intent and also recognizes natural language ("quiero tomar nota de
   esto" → NOTE, "agrega esto a mis tareas" → TASK).
4. **Parse intent** — normalizes the decision. Casual chat (`CHAT` /
   `SIMPLE_QUERY`) always stays on local Qwen; Claude is reserved for technical
   queries and explicit routing.
5. **Router (Switch)** — sends the message down one agent lane.
6. **Merge response** — formats the reply with a footer showing the source and
   the intent/confidence.

---

## Agents

| Agent | Status | Backend | Notes |
| --- | --- | --- | --- |
| **Chat** | ✅ Live | Ollama / Qwen | Casual conversation, always local. |
| **Claude** | ✅ Live | Claude API → Qwen fallback | High-quality / technical answers. |
| **Note (second brain)** | ✅ Live | Hermes `note_save` → git (Obsidian vault) | Writes Markdown notes and commits/pushes them to GitHub so the vault syncs across devices. |
| **Task** | ✅ Live | Linear (GraphQL) | Creates an issue from the message (first line = title). |
| **Calendar** | ✅ Live | Google Calendar via n8n | Create events, list the day's/upcoming agenda (`create_event`, `list_today_events`). |
| **Web search** | ✅ Live | SearXNG (self-hosted) | Current facts: weather, news, prices (`web_search` builtin). |
| **Semantic brain (RAG)** | ✅ Live | Qdrant + Ollama embeddings | Answers grounded in your notes (`search_brain_semantic`). |
| **Content** | 🚧 Planned | TBD | Draft/expand written content. |
| **Progress** | 🚧 Planned | TBD | Log and report on progress/status. |

### Note agent — git-backed Obsidian vault

The "second brain" is a plain git repository of Markdown files (an Obsidian
vault). The `note_save` Hermes tool writes a note into it and, when sync is on,
runs `git add/commit/push` so the vault stays in sync across every device via
GitHub. Configure it with `HERMES_BRAIN_*` env vars (root path, remote, branch,
optional SSH deploy key). See `LAUNCH.md`.

### Calendar agent (live) — Google Calendar

Rebeca turns natural-language requests ("agéndame una llamada mañana a las 3",
"¿qué tengo hoy?") into Google Calendar actions.

- **Backend:** Google Calendar via n8n's native **Google Calendar** node (OAuth2
  credential stored in n8n, not in `.env`), exposed as the `create_event` and
  `list_today_events` tool webhooks.
- **Time zone:** America/Puerto_Rico (UTC-04:00); assistant-core injects the
  current date/time into the system prompt so relative dates resolve correctly and
  events are created with the right ISO 8601 offset.

---

## Quick start

See **`LAUNCH.md`** for the full bring-up. In short:

```bash
cd n8n
cp .env.example .env      # fill in secrets (never commit .env)
sudo docker compose up -d --build
```

Then import `n8n/cerebro_workflow_v2.json` into n8n, connect the Telegram
credential, and activate the workflow.

---

## Adapting to your own setup

This stack is wired to a specific home lab. To run it elsewhere, change these
infrastructure-specific values (search the repo for each):

| Value (current) | Where | Change to |
| --- | --- | --- |
| `sadida.stegosaurus-panga.ts.net:11434` (Ollama URL) | `.env.example`, `gateway.js`, `server.js`, `hermes-stack.yaml` | Your Ollama host:port. |
| `qwen3:1.7b`, `qwen3.5:4b` (models) | workflow, gateway/server defaults | Whatever models you pulled. |
| `127.0.0.1:8080` (Hermes URL in n8n) | workflow HTTP nodes | Keep `127.0.0.1` **only** if n8n and Hermes share a network namespace (Compose `network_mode: service:tailscale`). Otherwise use the service hostname. |
| Tailscale sidecar + `TS_AUTHKEY` | `docker-compose.yaml`, `.env.example` | Optional — remove the sidecar if you are not on Tailscale. |
| NFS `storageClassName: nfs-client`, `ReadWriteMany` PVC | `hermes-stack.yaml` | Your cluster's storage class (k8s path only). |
| `nodeSelector: kubernetes.io/hostname: ocra` | `hermes-stack.yaml` | Your target node (k8s path only). |
| `HERMES_BRAIN_*` (brain repo, remote, key) | `.env.example` | Your Obsidian/GitHub vault repo. |
| Linear `teamId` | `Build task` code node | Your Linear team id. |

Notes worth keeping in mind when porting:

- **Do not rotate `N8N_ENCRYPTION_KEY`** on an existing n8n install — you lose
  access to stored credentials.
- Leaving `ANTHROPIC_API_KEY` **empty** is supported: Hermes falls back to the
  local Qwen model automatically.
- Secrets live in `.env` (gitignored) and in n8n credentials (Telegram, Linear,
  Google) — never in the workflow JSON.

---

## Repository structure

```
Productivity_Tools/
├── README.md                 # this file
├── HANDOFF.md                # context brief for the automation agent
├── LAUNCH.md                 # step-by-step bring-up
├── .gitignore
├── n8n/
│   ├── cerebro_workflow_v2.json
│   ├── docker-compose.yaml
│   └── .env.example
└── hermes-agent/
    ├── README.md
    ├── mcp-server/           # gateway.js, server.js, Dockerfile, package.json
    ├── k8s/hermes-stack.yaml # optional Kubernetes deployment
    └── scripts/deploy.sh
```
