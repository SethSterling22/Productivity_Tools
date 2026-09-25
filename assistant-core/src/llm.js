// LLM adapter with function-calling.
//
// Primary: Anthropic Messages API (tools). Fallback: Ollama /api/chat (tools),
// used when ANTHROPIC_API_KEY is empty or the Anthropic call fails.
//
// Internal message format is Anthropic-style content blocks:
//   { role: "user"|"assistant", content: string | Block[] }
//   Block = { type:"text", text } | { type:"tool_use", id, name, input }
//           | { type:"tool_result", tool_use_id, content }
// The agent loop (agent.js) builds these; runModel() converts them per provider.
//
// Unified tool format (from the manifest): { name, description, input_schema }.
// Return shape: { provider, text, toolCalls: [{ id, name, input }], stopReason }.

import { config } from "./config.js";

// Run the model. `chain` is an ordered list of targets from the router
// (router.js): each is {provider:"anthropic"} or {provider:"ollama", url, model, host}.
// We try them in order — Ollama hosts are health-gated so a powered-off host is
// skipped fast — and return the first success. Without a chain we keep the legacy
// behavior (Anthropic primary, then the default Ollama).
export async function runModel({ system, messages, tools, chain }) {
  if (!chain || !chain.length) {
    chain = [];
    if (config.anthropicKey) chain.push({ provider: "anthropic" });
    chain.push({ provider: "ollama", url: config.ollamaUrl, model: config.ollamaModel });
  }

  let lastErr;
  for (const t of chain) {
    try {
      if (t.provider === "anthropic") {
        if (!config.anthropicKey) continue;
        const r = await callAnthropic({ system, messages, tools });
        return { ...r, model: config.anthropicModel };
      }
      // Ollama: skip the host quickly if it's not up (e.g. omarchy powered off).
      const base = t.url || config.ollamaUrl;
      if (!(await ollamaHealthy(base))) {
        lastErr = new Error(`ollama host down: ${base}`);
        continue;
      }
      const r = await callOllama({ system, messages, tools, baseUrl: base, model: t.model || config.ollamaModel });
      return { ...r, model: t.model || config.ollamaModel, host: t.host };
    } catch (err) {
      lastErr = err;
      console.error(`[llm] target ${t.provider}/${t.model || ""} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error("no LLM target available");
}

// Quick liveness check for an Ollama host (cheap GET /api/tags).
async function ollamaHealthy(base) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`${base}/api/tags`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────
async function callAnthropic({ system, messages, tools }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicKey,
      "anthropic-version": config.anthropicVersion,
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: config.maxTokens,
      system,
      tools: tools.length ? tools : undefined,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  return { provider: "anthropic", text, toolCalls, stopReason: data.stop_reason };
}

// ── Ollama ──────────────────────────────────────────────────────────────────
async function callOllama({ system, messages, tools, baseUrl, model }) {
  const base = baseUrl || config.ollamaUrl;
  const useModel = model || config.ollamaModel;
  const oMessages = [{ role: "system", content: system }, ...toOllamaMessages(messages)];
  const oTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: useModel,
      messages: oMessages,
      tools: oTools.length ? oTools : undefined,
      stream: false,
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status} (${useModel}@${base}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.message || {};
  const text = stripThink(msg.content || "");
  const toolCalls = (msg.tool_calls || []).map((c, i) => ({
    id: `ollama_${Date.now()}_${i}`,
    name: c.function?.name,
    input: normalizeArgs(c.function?.arguments),
  }));
  return { provider: "ollama", text, toolCalls, stopReason: toolCalls.length ? "tool_use" : "end" };
}

// Flatten Anthropic-block messages into Ollama's flat role/content (+ tool msgs).
function toOllamaMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts = [];
    const toolCalls = [];
    for (const b of m.content) {
      if (b.type === "text") textParts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({ function: { name: b.name, arguments: b.input || {} } });
      } else if (b.type === "tool_result") {
        out.push({
          role: "tool",
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        });
      }
    }
    if (m.role === "assistant" && (textParts.length || toolCalls.length)) {
      const asst = { role: "assistant", content: textParts.join("") };
      if (toolCalls.length) asst.tool_calls = toolCalls;
      out.push(asst);
    } else if (m.role === "user" && textParts.length) {
      out.push({ role: "user", content: textParts.join("") });
    }
  }
  return out;
}

function normalizeArgs(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  try { return JSON.parse(args); } catch { return {}; }
}

function stripThink(s) {
  return String(s).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
