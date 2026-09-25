// Task-specialized model router.
//
// Classifies a user turn into a category, then returns an ordered chain of LLM
// targets to try (strong local → light local → Claude). llm.js runs the chain
// with a per-host health gate and falls through on failure, so a powered-off
// omarchy (or a missing model) degrades gracefully instead of erroring.
//
// Targets: { provider:"ollama", host, url, model } | { provider:"anthropic" }

import { config } from "./config.js";

const H = config.ollamaHosts;
const o = (host, model) => ({ provider: "ollama", host, url: H[host], model });
const claude = () => ({ provider: "anthropic" });

// category -> ordered failover chain. Editable via MODEL_ROUTES (JSON) env.
const DEFAULT_ROUTES = {
  // pure greetings / acknowledgements: cheapest, always-on
  trivial: [o("sadida", "qwen3:1.7b"), o("sadida", "qwen3.5:4b"), claude()],
  // default conversation (may call productivity tools): tool-capable small model
  general: [o("sadida", "qwen3.5:4b"), claude()],
  // math / logic / analysis: reasoning ("thinking") models
  reasoning: [o("omarchy", "deepseek-r1:8b"), o("sadida", "deepseek-r1:1.5b"), claude()],
  // code / technical: coding specialists
  coding: [o("omarchy", "qwen2.5-coder:7b"), o("sadida", "qwen2.5-coder:3b"), claude()],
  // long / ambiguous / high-stakes: Claude first, local as a safety net
  complex: [claude(), o("sadida", "qwen3.5:4b")],
};

function loadRoutes() {
  if (!config.modelRoutesJson) return DEFAULT_ROUTES;
  try {
    // Env override format: { category: [ {host,model} | {claude:true}, ... ] }
    const raw = JSON.parse(config.modelRoutesJson);
    const out = {};
    for (const [cat, chain] of Object.entries(raw)) {
      out[cat] = chain.map((t) => (t.claude ? claude() : o(t.host, t.model)));
    }
    return { ...DEFAULT_ROUTES, ...out };
  } catch (e) {
    console.error("[router] bad MODEL_ROUTES JSON, using defaults:", e.message);
    return DEFAULT_ROUTES;
  }
}
const ROUTES = loadRoutes();

// ── Classifier (cheap heuristics; zero extra latency) ───────────────────────
const CODE_RE = /```|\b(bug|error|stack ?trace|traceback|exception|compile|deploy|refactor|regex|docker|kubernetes|k8s|terraform|ansible|sql|query|endpoint|api|función|funcion|function|script|clase|class|import|npm|pip|git|yaml|json|bash|shell|nginx)\b|\b(python|javascript|typescript|node|java|golang|rust|c\+\+|c#|php|ruby|kotlin|swift)\b/i;
const REASON_RE = /\b(por ?qué|porque|calcula|cálculo|calculo|demuestra|demostrar|resuelve|resolver|razona|razonamiento|analiza|análisis|analisis|compara|comparación|estrategia|optimiza|prueba matemática|paso a paso|step ?by ?step|prove|proof|derive|reason|logic|lógica|logica|math|matemática|matematica|ecuación|ecuacion)\b/i;
const GREET_RE = /^(hola+|hey|buenas|buenos días|buenos dias|buenas tardes|buenas noches|qué tal|que tal|cómo estás|como estas|gracias|muchas gracias|ok|okay|vale|perfecto|genial|adiós|adios|chao|hi|hello|thanks|thank you)[\s!.,]*$/i;

export function classify(message) {
  const m = (message || "").trim();
  const len = m.length;
  if (CODE_RE.test(m)) return "coding";
  if (REASON_RE.test(m)) return "reasoning";
  if (len > 800) return "complex";           // long, likely needs the strongest model
  if (len <= 30 && GREET_RE.test(m)) return "trivial";
  return "general";
}

// ── Model discovery + manual override ───────────────────────────────────────
// Remember the last models seen per host so we can still list them (greyed out)
// when the host is temporarily offline.
const seen = {};

// List every model across the Ollama hosts (auto-discovered via /api/tags) plus
// Claude. Each: { id, provider, host, model, available }. New models a host has
// pulled show up automatically. id is what the client sends back to force a model.
export async function listModels() {
  const out = [];
  if (config.anthropicKey) {
    out.push({ id: "anthropic", provider: "anthropic", host: "claude", model: config.anthropicModel, available: true });
  }
  await Promise.all(
    Object.entries(config.ollamaHosts).map(async ([host, url]) => {
      let up = false, models = [];
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const res = await fetch(`${url}/api/tags`, { signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) { up = true; models = ((await res.json()).models || []).map((m) => m.name); }
      } catch {}
      if (up) seen[host] = models;
      const known = up ? models : (seen[host] || []);
      for (const m of known) out.push({ id: `${host}/${m}`, provider: "ollama", host, model: m, available: up });
      if (!known.length) out.push({ id: `${host}/__offline`, provider: "ollama", host, model: "(sin modelos / offline)", available: false });
    })
  );
  return out;
}

// Build a single-target chain to force a specific model (from the dropdown).
// No auto-fallback: the point is to test that exact model's answer.
export function overrideChain(id) {
  if (!id || id === "auto") return null;
  if (id === "anthropic") return config.anthropicKey ? [{ provider: "anthropic" }] : null;
  const i = id.indexOf("/");
  if (i === -1) return null;
  const host = id.slice(0, i), model = id.slice(i + 1);
  const url = config.ollamaHosts[host];
  if (!url || model.startsWith("__")) return null;
  return [{ provider: "ollama", host, url, model }];
}

// Returns { category, chain }. Chain is filtered to drop Claude when no API key,
// and to drop Ollama hosts with no configured URL.
export function routeFor(message) {
  const category = classify(message);
  let chain = (ROUTES[category] || ROUTES.general).filter((t) => {
    if (t.provider === "anthropic") return Boolean(config.anthropicKey);
    return Boolean(t.url);
  });
  // Safety net: always have at least one usable target.
  if (!chain.length) {
    chain = config.anthropicKey
      ? [claude()]
      : [{ provider: "ollama", host: "sadida", url: config.ollamaUrl, model: config.ollamaModel }];
  }
  return { category, chain };
}
