// Tool registry: loads tools.manifest.json, exposes tool definitions to the LLM,
// and dispatches tool calls to their declared backend (n8n webhook or Hermes tool).
//
// Adding a new capability later = add a descriptor to tools.manifest.json plus,
// for n8n_webhook tools, a Webhook-triggered sub-workflow. No code change here.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";
import * as rag from "./rag.js";
import { webSearch } from "./websearch.js";
import { queryMetrics } from "./metrics.js";

// Tools implemented in-process (no external HTTP hop).
const BUILTINS = {
  search_brain_semantic: (input) => rag.searchBrain(input || {}),
  web_search: (input) => webSearch(input || {}),
  query_metrics: (input) => queryMetrics(input || {}),
  create_plan: (input) => createPlan(input || {}),
};

// Planning: create a parent task plus its subtasks in one step, reusing the
// create_task tool (which returns the Linear issue id we use as the parent).
async function createPlan(input) {
  const title = (input.title || "").trim();
  if (!title) return { ok: false, error: "Missing 'title' (the plan/goal)." };
  const subs = Array.isArray(input.subtasks) ? input.subtasks : [];

  // Resolve the project: use an existing id, or create one from `new_project`.
  let projectId = input.project || null;
  let projectInfo = null;
  if (!projectId && input.new_project) {
    const pr = await dispatch("create_project", { name: String(input.new_project), description: input.description });
    if (!pr || pr.ok === false || !pr.id) return { ok: false, error: "Could not create the project.", detail: pr };
    projectId = pr.id;
    projectInfo = { name: pr.name, url: pr.url };
  }

  const parent = await dispatch("create_task", { title, description: input.description, project: projectId });
  if (!parent || parent.ok === false || !parent.id) {
    return { ok: false, error: "Could not create the parent task.", detail: parent };
  }
  const children = [];
  for (const s of subs) {
    const stitle = typeof s === "string" ? s : (s && s.title);
    if (!stitle) continue;
    const c = await dispatch("create_task", {
      title: String(stitle),
      description: typeof s === "object" ? s.description : undefined,
      project: projectId,
      parent: parent.id,
    });
    children.push(c && c.ok !== false ? { ref: c.identifier, title: c.title, url: c.url } : { error: true, title: String(stitle) });
  }
  return {
    ok: true,
    result: `Plan creado${projectInfo ? ` en el proyecto "${projectInfo.name}"` : ""}: ${parent.identifier || ""} ${parent.title} con ${children.length} subtarea(s).`,
    project: projectInfo,
    parent: { ref: parent.identifier, title: parent.title, url: parent.url, id: parent.id },
    children,
  };
}

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

  // In-process builtins (e.g. semantic brain search) run without an HTTP hop.
  if (ep.type === "builtin") {
    const fn = BUILTINS[ep.name || name];
    if (!fn) return { ok: false, error: `Unknown builtin: ${ep.name || name}` };
    try { return await fn(input); }
    catch (err) { return { ok: false, error: `${name} failed: ${err.message}` }; }
  }

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
    // Auto-index a saved note into Qdrant (fire-and-forget) so semantic search
    // stays fresh without a manual /brain/reindex.
    if (name === "save_note" && body && body.ok !== false) {
      const m = /Note saved:\s*(\S+\.md)/.exec(body.result || "");
      if (m) rag.indexNoteByPath(m[1]).catch(() => {});
    }
    return body;
  } catch (err) {
    return { ok: false, error: `Tool ${name} failed: ${err.message}` };
  }
}
