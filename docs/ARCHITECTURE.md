# Architecture — Rebeca / Cerebro

How the personal-assistant stack is wired today: the components, how each one
talks to the others, how it's exposed on the network, and how authentication and
authorization work. Diagrams are Mermaid (render on GitHub and most Markdown
viewers).

> Scope: the automation/assistant layer. Infrastructure (Proxmox, k3s, Tailscale
> admin, GPU provisioning) is owned separately.

---

## 1. Components at a glance

| Component | Runtime | Port | Network | Role |
|---|---|---|---|---|
| **assistant-core** | Node/Fastify | `4000` | shares `tailscale` netns | The brain: chat API, agent tool-calling loop, memory, voice proxy, auth gate. Serves the dashboard + `/watch`. |
| **n8n** | n8n | `5678` | shares `tailscale` netns | Integration hub: Telegram trigger, Router (slash-commands), tool sub-workflows (Linear, Google Calendar). |
| **Hermes gateway** | Node | `8080` | shares `tailscale` netns | Low-level tool provider: brain read/write (`note_save`, `brain_list`, `brain_graph`), fs/shell. |
| **Tailscale sidecar** | tailscale | — | `n8n_network` | Network namespace shared by the three above; publishes host ports and runs Serve/Funnel. Node name `ocra-n8n`. |
| **PostgreSQL** | postgres:16 | `5432` | `n8n_network` | n8n data + assistant-core chat sessions/messages. |
| **Qdrant** | qdrant | `6333` | `n8n_network` | Vector DB for RAG over the second brain. |
| **SearXNG** | searxng | `8080` | `n8n_network` | Self-hosted metasearch for the `web_search` tool. |
| **Ollama** | external | `11434` | tailnet (sadida) | Local LLM (fallback) + embeddings (`nomic-embed-text`). |
| **Whisper (STT)** | external | `8100` | tailnet (omarchy/sadida) | Speech-to-text. |
| **Piper (TTS)** | external | `8200` | tailnet (omarchy/sadida) | Text-to-speech. |

Clients: the **dashboard** (browser on the tailnet), the **Galaxy Watch**
(Samsung Internet over the public Funnel), and **Telegram** (text + voice notes).

### System map

```mermaid
flowchart TB
  subgraph clients[Clients]
    dash[Dashboard browser<br/>tailnet device]
    watch[Galaxy Watch<br/>Samsung Internet]
    tg[Telegram app]
  end

  subgraph ts[Tailscale node: ocra-n8n]
    direction TB
    funnel443{{Funnel :443<br/>public}}
    serve8443{{Serve :8443<br/>tailnet only}}
    funnel10000{{Funnel :10000<br/>public}}

    subgraph netns[shared network namespace]
      ac[assistant-core :4000]
      n8n[n8n :5678]
      hermes[Hermes gateway :8080]
    end
  end

  subgraph dnet[Docker n8n_network]
    pg[(PostgreSQL :5432)]
    qd[(Qdrant :6333)]
    sx[SearXNG :8080]
  end

  subgraph gpu[GPU hosts over tailnet]
    ollama[Ollama :11434<br/>sadida]
    whisper[Whisper :8100<br/>omarchy/sadida]
    piper[Piper :8200<br/>omarchy/sadida]
  end

  dash --> serve8443 --> ac
  watch --> funnel10000 --> ac
  tg --> funnel443 --> n8n

  ac -->|localhost| hermes
  ac -->|localhost| n8n
  ac --> pg
  ac --> qd
  ac --> sx
  ac -->|LLM + embeddings| ollama
  ac --> whisper
  ac --> piper
  n8n -->|X-Internal-Token| ac
  n8n --> hermes
  hermes --> ollama
```

Because assistant-core, n8n and Hermes **share the Tailscale container's network
namespace** (`network_mode: service:tailscale`), they reach each other on
`localhost` (`127.0.0.1:8080`, `127.0.0.1:5678`). Postgres, Qdrant and SearXNG
live on `n8n_network`; the Tailscale container is also on that network, so the
three siblings resolve them by Docker DNS name (`postgres`, `qdrant`, `searxng`).
The GPU services are reached by Tailscale MagicDNS names.

---

## 2. Network exposure (Tailscale Serve & Funnel)

Only three ports are reachable from outside the containers, all via the Tailscale
node `ocra-n8n.stegosaurus-panga.ts.net`:

| Port | Mode | Target | Who reaches it | Purpose |
|---|---|---|---|---|
| `443` | **Funnel** (public) | `127.0.0.1:5678` (n8n) | the internet | Telegram webhook (needs public reachability). |
| `8443` | **Serve** (tailnet-only) | `127.0.0.1:4000` (assistant-core) | your tailnet devices | Dashboard (full app). |
| `10000` | **Funnel** (public) | `127.0.0.1:4000` (assistant-core) | the internet | Watch access from any network. Protected by the watch token / Google OAuth. |

```mermaid
flowchart LR
  internet((Internet)) -->|:443| n8nsvc[n8n :5678]
  internet -->|:10000| acsvc[assistant-core :4000]
  tailnet((Tailnet devices)) -->|:8443| acsvc
```

The whole app lives behind assistant-core, so both `:8443` and `:10000` hit the
same service; the difference is who can reach the port and which auth path applies
(see §5). HTTPS is terminated by Tailscale (valid `ts.net` cert), which also means
the browser mic (`getUserMedia`, secure-context only) works on both.

---

## 3. Request flow — dashboard chat

```mermaid
sequenceDiagram
  participant B as Browser (dashboard)
  participant AC as assistant-core
  participant LLM as LLM (Anthropic / Ollama)
  participant T as Tool backend
  B->>AC: POST /chat/stream (session_id, message) [cookie: rebeca_session]
  Note over AC: auth gate validates the Google session cookie
  AC->>AC: load session context from Postgres
  loop agent loop (max steps)
    AC->>LLM: messages + system + tool definitions
    LLM-->>AC: text and/or tool_use calls
    alt tool calls
      AC->>T: dispatch (builtin / hermes / n8n webhook)
      T-->>AC: result
      AC-->>B: SSE tool_call / tool_result
    else final answer
      AC-->>B: SSE text
    end
  end
  AC-->>B: SSE done
  AC->>AC: persist turns to Postgres
```

The LLM adapter (`llm.js`) uses **Anthropic (Claude) as primary and Ollama on
sadida as fallback**. Tool calls are dispatched by type (§6).

---

## 4. Request flow — Telegram (text + voice)

```mermaid
sequenceDiagram
  participant TG as Telegram
  participant F as Funnel :443
  participant N as n8n (cerebro workflow)
  participant AC as assistant-core
  participant W as Whisper
  TG->>F: webhook (message)
  F->>N: POST /webhook (:5678)
  alt slash command (/task, /note, /calendar...)
    N->>N: Router → tool sub-workflow
  else voice note
    N->>N: download voice file
    N->>AC: POST /voice/transcribe [X-Internal-Token]
    AC->>W: audio → text
    W-->>AC: transcript
    AC-->>N: text
    N->>AC: POST /chat (text) [X-Internal-Token]
    AC-->>N: response
  else free-form text
    N->>AC: POST /chat (text) [X-Internal-Token]
    AC-->>N: response
  end
  N-->>TG: reply
```

n8n calls into assistant-core with the **`X-Internal-Token`** header, which
bypasses the Google OAuth gate (service-to-service; see §5).

---

## 5. Authentication & authorization

assistant-core runs a single `onRequest` gate. Three mechanisms can authorize a
request; if none applies, HTML GETs are redirected to Google login and everything
else gets `401`.

```mermaid
flowchart TD
  req[Incoming request] --> health{path /health or /auth/*?}
  health -->|yes| allow[Allow]
  health -->|no| intern{X-Internal-Token matches?}
  intern -->|yes| allow
  intern -->|no| watch{valid watch token AND path in watch allowlist?}
  watch -->|yes| allow
  watch -->|no| sess{valid Google session cookie AND email allowlisted?}
  sess -->|yes| allow
  sess -->|no| html{HTML GET?}
  html -->|yes| redirect[302 -> /auth/login]
  html -->|no| deny[401 unauthorized]
```

### 5a. Google OAuth (dashboard)

Login uses Google OIDC, restricted to an allowlist (`ALLOWED_GOOGLE_EMAILS`). A
signed, http-only cookie (`rebeca_session`, 7 days) carries the authenticated
email.

```mermaid
sequenceDiagram
  participant B as Browser
  participant AC as assistant-core
  participant G as Google OAuth
  B->>AC: GET / (no valid session)
  AC-->>B: 302 /auth/login
  B->>AC: GET /auth/login
  AC->>AC: set signed state cookie
  AC-->>B: 302 to Google consent
  B->>G: sign in + consent
  G-->>B: 302 /auth/callback?code&state
  B->>AC: GET /auth/callback
  AC->>AC: verify state cookie
  AC->>G: exchange code for tokens
  G-->>AC: id_token (email)
  AC->>AC: check email against allowlist
  AC-->>B: set rebeca_session cookie, 302 /
```

The OAuth **redirect URI is `https://ocra-n8n.stegosaurus-panga.ts.net:8443/auth/callback`**
(the tailnet Serve address). This is why the watch, which is off-tailnet, cannot
complete the Google flow and instead uses the watch token below.

### 5b. Internal token (service-to-service)

n8n/Telegram flows send `X-Internal-Token: <INTERNAL_TOKEN>`. A match bypasses the
OAuth gate entirely. Used for `POST /chat`, `/voice/transcribe`, and the brain
index hooks. The token is a shared secret in `.env`, never in workflow JSON.

### 5c. Watch token (`/watch`)

The Galaxy Watch opens `…:10000/watch?wt=<WATCH_TOKEN>`. The gate sets a signed
cookie (`rebeca_watch`, 30 days) and authorizes **only** the watch endpoints:
`/watch`, `/watch.html`, `/chat`, `/chat/stream`, `/voice/*`. Any other path still
requires Google OAuth, so a leaked watch token cannot open the full dashboard.

```mermaid
flowchart LR
  w[Watch: /watch?wt=TOKEN] --> chk{wt == WATCH_TOKEN?}
  chk -->|yes| setc[set rebeca_watch cookie 30d] --> scoped[allow watch endpoints only]
  chk -->|no| oauth[fall through to Google OAuth]
```

---

## 6. Tool dispatch

Every capability is a descriptor in `tools.manifest.json` (bind-mounted +
hot-reloaded). assistant-core turns each into an LLM function definition and
dispatches calls by `endpoint.type`:

```mermaid
flowchart TD
  call[LLM tool call] --> type{endpoint.type}
  type -->|builtin| bi[in-process JS<br/>search_brain_semantic, web_search]
  type -->|hermes_tool| hm[Hermes gateway :8080<br/>note_save, brain_list]
  type -->|n8n_webhook| nw[n8n webhook :5678<br/>create_task, create_event, list_today_events]
  type -->|http| ht[any URL]
```

Current tools: `create_task`, `create_event`, `list_today_events` (n8n) ·
`save_note`, `search_brain` (Hermes) · `search_brain_semantic`, `web_search`
(builtin). Adding a tool is documented in [ADDING_A_TOOL.md](./ADDING_A_TOOL.md).

---

## 7. Data & knowledge flows

### RAG (second-brain semantic memory)

```mermaid
flowchart LR
  subgraph index[Indexing]
    note[save_note] --> hz[Hermes writes note + git push]
    hz --> emb1[Ollama embeddings<br/>nomic-embed-text]
    emb1 --> up[(Qdrant upsert)]
  end
  subgraph query[Query]
    q[search_brain_semantic] --> emb2[embed query]
    emb2 --> se[(Qdrant search)]
    se --> res[top note excerpts + links]
  end
```

Saving a note auto-indexes it into Qdrant (incremental), so semantic search stays
fresh without a manual reindex. `POST /brain/reindex` rebuilds the whole
collection.

### Web search

```mermaid
flowchart LR
  ws[web_search builtin] --> sx[SearXNG JSON API :8080]
  sx --> engines[(search engines)]
  sx --> ws
  ws --> ac[cleaned results + instant answer]
```

---

## 8. Persistence

| Store | Holds | Notes |
|---|---|---|
| **PostgreSQL** | `chat_session`, `chat_message` | Per-channel conversation memory; migration retries on cold boot. |
| **Qdrant** | `brain` collection (vectors) | RAG over the vault; 768-dim (`nomic-embed-text`). |
| **Second brain (git)** | Markdown vault | Written by Hermes `note_save`, pushed to GitHub. |
| **`.env`** | secrets | OAuth, internal token, watch token, DB password, TS authkey. Never committed. |
| **Tailscale state volume** | Serve/Funnel config, node identity | Survives restarts. |

---

## 9. Client channels summary

| Channel | Entry | Auth | Voice |
|---|---|---|---|
| Dashboard | Serve `:8443` (tailnet) | Google OAuth | mic push-to-talk + TTS |
| Watch | Funnel `:10000` (public) | Watch token | mic push-to-talk + TTS |
| Telegram | Funnel `:443` → n8n | Internal token | voice notes in; text out |
```
