# Productivity Tools — Personal Automation Stack

A self-hosted, chat-driven automation stack. You talk to it over **Telegram**;
**n8n** classifies what you want; a custom gateway called **Hermes** runs the
right tool and answers using either a **local LLM (Ollama/Qwen)** or the
**Claude API**. Around that core sit a set of task-specific agents (notes, tasks,
content, progress, calendar) that turn a message into an action in your tools.

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
┌───────────────────────────────────────────────────────────────────────┐
│  Telegram  ─►  n8n (workflow)  ─►  Hermes gateway (:8080)  ─►  LLMs      │
│                                                                         │
│   • n8n           orchestrates the flow, classifies intent, routes      │
│   • Hermes        HTTP gateway exposing tools (fs, shell, notes, LLMs)  │
│   • Ollama/Qwen   local model for casual chat + intent classification   │
│   • Claude API    high-quality answers (optional; falls back to Qwen)   │
│                                                                         │
│  External integrations: Obsidian (git), Linear, Google Calendar …       │
└───────────────────────────────────────────────────────────────────────┘
```

Today the stack runs as a **Docker Compose** deployment (n8n + Hermes gateway +
PostgreSQL + a Tailscale sidecar) on an always-on host, and reaches Ollama on a
separate GPU host over Tailscale. An optional Kubernetes manifest is included in
`hermes-agent/k8s/` for cluster deployments.

---

## Components

| Component | Path | What it does |
| --- | --- | --- |
| **n8n workflow** | `n8n/cerebro_workflow_v2.json` | Telegram entry point, routing brain, agent orchestration. |
| **Hermes gateway** | `hermes-agent/mcp-server/gateway.js` | HTTP server on `:8080`; exposes tools via `POST /tool/:name`. What n8n calls. |
| **Hermes MCP server** | `hermes-agent/mcp-server/server.js` | Native stdio MCP server (same tools) for MCP-native clients. |
| **Compose stack** | `n8n/docker-compose.yaml` | n8n + hermes-gateway + postgres + tailscale. |
| **Launch guide** | `LAUNCH.md` | Step-by-step bring-up. |

Hermes tools: `fs_list`, `fs_read`, `fs_write`, `fs_delete` (gated), `shell_exec`
(allowlist or unrestricted), `note_save` (git-backed notes), `ollama_chat`,
`claude_chat` (auto-falls back to Qwen when no API key or on failure). All
capabilities are **locked down by default** and enabled per-need through env
toggles (see `n8n/.env.example`).

---

## Routing model

Every incoming message flows through the same decision path:

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
| **Content** | 🚧 Planned (phase 4) | TBD | Draft/expand written content. |
| **Progress** | 🚧 Planned (phase 5) | TBD | Log and report on progress/status. |
| **Calendar** | 🗓️ Planned | Google Calendar | See below. |

### Note agent — git-backed Obsidian vault

The "second brain" is a plain git repository of Markdown files (an Obsidian
vault). The `note_save` Hermes tool writes a note into it and, when sync is on,
runs `git add/commit/push` so the vault stays in sync across every device via
GitHub. Configure it with `HERMES_BRAIN_*` env vars (root path, remote, branch,
optional SSH deploy key). See `LAUNCH.md`.

### Calendar agent (planned) — Google Calendar

The calendar agent will turn natural-language requests ("agéndame una llamada
mañana a las 3", "mueve mi reunión del viernes") into Google Calendar events.

Planned design:

- **Backend:** Google Calendar via n8n's native **Google Calendar** node
  (OAuth2 credential stored in n8n, like the Telegram token — not in `.env`).
- **New route:** add `CALENDAR` to the Router and a `/cal` slash command in
  Fast route; teach the classifier to recognize scheduling language.
- **Node chain (mirrors the Task agent):**
  `Build event` (Code — parse title, start/end, attendees from `raw_text`) →
  `Google Calendar — Create event` → `Parse event` (Code — format the ✅/⚠️
  reply with the event link).
- **Capabilities:** create events, quick-add from text, move/reschedule, set
  reminders, and read the day's agenda ("¿qué tengo hoy?").
- **Time zone:** default to the user's TZ; make it a single configurable value.

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
