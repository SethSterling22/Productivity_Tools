# Adding a tool to Rebeca

Every capability Rebeca has is a **tool descriptor** in
`assistant-core/tools.manifest.json`. assistant-core loads the manifest, offers
each tool to the LLM (function-calling), dispatches calls to the declared backend,
and the dashboard's capabilities panel lists them automatically.

The manifest is bind-mounted into the container, so **editing it + `git pull`
hot-reloads** — no rebuild for manifest-only changes.

## Descriptor shape

```jsonc
{
  "name": "create_task",                 // unique; what the LLM calls
  "description": "When/what to use it for. Be specific — this drives tool choice.",
  "input_schema": {                      // JSON Schema; the LLM fills this
    "type": "object",
    "properties": { "title": { "type": "string" } },
    "required": ["title"]
  },
  "endpoint": { "type": "n8n_webhook", "path": "/tool/create_task" },
  "channels": ["dashboard", "telegram"], // where it's offered/shown
  "icon": "check-square"                 // capabilities panel
}
```

## Endpoint types

- **`n8n_webhook`** — for external integrations (any app n8n supports). Dispatched
  to `N8N_WEBHOOK_BASE + path`. Build a Webhook sub-workflow (see below).
- **`hermes_tool`** — for things in the Hermes gateway (brain, fs, shell).
  Dispatched to `HERMES_URL + path` (a `POST /tool/<name>` on Hermes).
- **`builtin`** — in-process JS in assistant-core. Add a function to `BUILTINS` in
  `src/tools.js` (`endpoint: { "type": "builtin", "name": "my_fn" }`). Needs a
  rebuild (it's code).
- **`http`** — any URL (`endpoint: { "type": "http", "url": "https://..." }`).

## Recipe A — external integration (n8n webhook)

1. In n8n: **Import** `n8n/tools/_template.workflow.json`, rename it, and set the
   Webhook **path** to `tool/<your_name>`.
2. Replace the "Do work" Code node with real nodes (e.g. an HTTP/app node), and
   make the last node return a small JSON `{ ok: true, ... }`.
3. **Activate** the workflow (the production webhook only works when active).
4. Add the descriptor to `tools.manifest.json` with
   `"endpoint": { "type": "n8n_webhook", "path": "/tool/<your_name>" }`.
5. `git pull` on Ocra → hot-reload. Done.

Note: n8n webhooks are **not** behind the dashboard OAuth gate, so they need no
token. (The `X-Internal-Token` is only for calls *into* assistant-core, e.g. the
Telegram → Rebeca and Index note nodes.)

## Recipe B — Hermes tool

1. Add the tool to `hermes-agent/mcp-server/gateway.js` (in the `TOOLS` object),
   rebuild Hermes: `docker compose up -d --build --no-deps hermes-gateway`.
2. Add the descriptor with `"endpoint": { "type": "hermes_tool", "path": "/tool/<name>" }`.
3. `git pull` → hot-reload.

## Recipe C — builtin (in-process)

1. Add a function to `BUILTINS` in `assistant-core/src/tools.js`.
2. Descriptor: `"endpoint": { "type": "builtin", "name": "<fn key>" }`.
3. Rebuild assistant-core (`up -d --build --no-deps assistant-core`).

## Testing

```bash
# The tool shows up in the manifest:
sudo docker exec assistant_core wget -qO- http://127.0.0.1:4000/tools

# n8n webhook responds:
sudo docker exec assistant_core wget -qO- --header='Content-Type: application/json' \
  --post-data='{"...":"..."}' http://127.0.0.1:5678/webhook/tool/<your_name>
```

Then ask Rebeca to do the thing; she'll pick the tool by its `description`.

## Conventions

- Keep `description` action-oriented and disambiguating (it's how the model chooses).
- Always return `ok: true|false` so failures are legible to the LLM and the UI.
- Set `channels` to limit a tool to dashboard-only or telegram-only when relevant.
- Never put secrets in the manifest or workflow JSON (they're versioned in git);
  use n8n credentials or `.env`.
