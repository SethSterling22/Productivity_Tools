// Tool registry: loads tools.manifest.json, exposes tool definitions to the LLM,
// and dispatches tool calls to their declared backend (n8n webhook or Hermes tool).
//
// Adding a new capability later = add a descriptor to tools.manifest.json plus,
// for n8n_webhook tools, a Webhook-triggered sub-workflow. No code change here.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";

let manifest = { version: 0, tools: [] };
let byName = new Map();

export async function loadManifest() {
  const raw = await fsp.readFile(config.manifestPath, "utf8");
  manifest = JSON.parse(raw);
  byName = new Map((manifest.tools || []).map((t) => [t.name, t]));
  return manifest;
}

// Hot-reload when the manifest file changes on disk.
export function watchManifest() {
  try {
    fs.watch(config.manifestPath, { persistent: false }, () => {
      loadManifest().catch((e) => console.error("[tools] reload failed:", e.message));
    });
  } catch {
    // Non-fatal (e.g. read-only FS); manifest is still loaded once at startup.
  }
}

export function listTools() {
  return manifest.tools || [];
}

// Filter tools available on a given channel and shape them for the LLM.
export function llmTools(channel) {
  return listTools()
    .filter((t) => !channel || !t.channels || t.channels.includes(channel))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

// Execute a tool call. Returns a plain object (or string) result.
export async function dispatch(name, input) {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  const ep = tool.endpoint || {};
  let url;
  if (ep.type === "hermes_tool") url = config.hermesUrl + ep.path;
  else if (ep.type === "n8n_webhook") url = config.n8nWebhookBase + ep.path;
  else if (ep.type === "http") url = ep.url;
  else return { ok: false, error: `Unsupported endpoint type: ${ep.type}` };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input || {}),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) return { ok: false, error: `Tool ${name} HTTP ${res.status}`, body };
    return body;
  } catch (err) {
    return { ok: false, error: `Tool ${name} failed: ${err.message}` };
  }
}
