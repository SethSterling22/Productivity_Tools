// Web search via a self-hosted SearXNG instance (JSON API).
//
// SearXNG is a privacy-respecting metasearch engine we run in Docker (see
// n8n/docker-compose.yaml). We hit its JSON endpoint, so no API key and no
// third-party ever sees the user's queries. Rebeca calls this through the
// `web_search` builtin (see tools.js) whenever she needs current / real-world
// info: weather, news, prices, "what happened with X", docs lookups, etc.

import { config } from "./config.js";

const TIMEOUT_MS = Number(process.env.WEBSEARCH_TIMEOUT_MS || 8000);

// Strip HTML tags SearXNG sometimes leaves in snippets, collapse whitespace.
function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run a web search.
 * @param {{query:string, limit?:number, categories?:string, time_range?:string}} input
 * @returns {Promise<{ok:boolean, query?:string, answer?:string, results?:Array, error?:string}>}
 */
export async function webSearch(input = {}) {
  const query = (input.query || "").trim();
  if (!query) return { ok: false, error: "Missing 'query'." };
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10);

  const params = new URLSearchParams({
    q: query,
    format: "json",
    safesearch: "0",
    language: "es", // matches the user's default language; SearXNG still returns non-es hits
  });
  if (input.categories) params.set("categories", input.categories); // e.g. "news", "general"
  if (input.time_range) params.set("time_range", input.time_range); // day|week|month|year

  const url = `${config.searxngUrl.replace(/\/$/, "")}/search?${params}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `SearXNG HTTP ${res.status}` };
    data = await res.json();
  } catch (err) {
    const msg = err.name === "AbortError" ? "timeout" : err.message;
    return { ok: false, error: `Web search failed: ${msg}` };
  } finally {
    clearTimeout(t);
  }

  const results = (data.results || []).slice(0, limit).map((r) => ({
    title: clean(r.title),
    url: r.url,
    snippet: clean(r.content),
    ...(r.publishedDate ? { published: r.publishedDate } : {}),
  }));

  // SearXNG "answers" (instant answers) and infoboxes are high-signal — surface
  // the first one so the LLM can answer directly without parsing every result.
  let answer;
  if (Array.isArray(data.answers) && data.answers.length) {
    answer = clean(typeof data.answers[0] === "string" ? data.answers[0] : data.answers[0].answer);
  } else if (Array.isArray(data.infoboxes) && data.infoboxes.length) {
    answer = clean(data.infoboxes[0].content);
  }

  if (!results.length && !answer) {
    return { ok: true, query, results: [], note: "No results found." };
  }
  return { ok: true, query, ...(answer ? { answer } : {}), results };
}
