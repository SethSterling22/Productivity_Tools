// RAG over the second brain: embed notes with Ollama, store/search in Qdrant.
//   reindex()      -> (re)build the vector index from the vault
//   searchBrain()  -> semantic search, returns relevant note excerpts
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const COLLECTION = config.ragCollection;

// ── Ollama embeddings ────────────────────────────────────────────────────────
async function embed(text) {
  const res = await fetch(`${config.ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, prompt: text }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j.embedding)) throw new Error("no embedding in response");
  return j.embedding;
}

// ── Qdrant REST ──────────────────────────────────────────────────────────────
async function qdrant(method, pathname, body) {
  const res = await fetch(`${config.qdrantUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`qdrant ${method} ${pathname} ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

function uuidFrom(key) {
  const h = crypto.createHash("md5").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function chunkText(text, size = 800, overlap = 100) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out = [];
  for (let i = 0; i < clean.length; i += size - overlap) out.push(clean.slice(i, i + size));
  return out;
}

async function walkNotes(dir, rel, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkNotes(path.join(dir, e.name), childRel, out);
    else if (e.name.endsWith(".md")) {
      let content = "";
      try { content = await fs.readFile(path.join(dir, e.name), "utf8"); } catch {}
      out.push({ rel: childRel, content });
    }
  }
}

// Full rebuild: drop + recreate the collection, then embed every note chunk.
export async function reindex() {
  const notes = [];
  await walkNotes(config.brainPath, "", notes);

  try { await qdrant("DELETE", `/collections/${COLLECTION}`); } catch {}
  await qdrant("PUT", `/collections/${COLLECTION}`, {
    vectors: { size: config.embedDim, distance: "Cosine" },
  });

  const webBase = (config.brainWebUrl || "").replace(/\/+$/, "");
  const branch = config.brainBranch;
  let points = [];
  let chunks = 0;

  for (const n of notes) {
    const base = n.rel.replace(/\.md$/, "").split("/").pop();
    let title = base;
    const fm = n.content.match(/^---[\s\S]*?\ntitle:\s*"?([^"\n]+)"?/);
    if (fm) title = fm[1].trim();
    const body = n.content.replace(/^---[\s\S]*?---\n/, "");
    const url = webBase ? `${webBase}/blob/${branch}/${n.rel.split("/").map(encodeURIComponent).join("/")}` : "";

    const parts = chunkText(body);
    for (let i = 0; i < parts.length; i++) {
      let vector;
      try { vector = await embed(parts[i]); } catch { continue; }
      points.push({ id: uuidFrom(n.rel + "#" + i), vector, payload: { path: n.rel, title, url, text: parts[i] } });
      chunks++;
      if (points.length >= 64) { await qdrant("PUT", `/collections/${COLLECTION}/points`, { points }); points = []; }
    }
  }
  if (points.length) await qdrant("PUT", `/collections/${COLLECTION}/points`, { points });
  return { ok: true, notes: notes.length, chunks };
}

// Alias (index.js route calls reindexBrain).
export const reindexBrain = reindex;

// Create the collection if it doesn't exist yet.
async function ensureCollection() {
  try { await qdrant("GET", `/collections/${COLLECTION}`); return; }
  catch { await qdrant("PUT", `/collections/${COLLECTION}`, { vectors: { size: config.embedDim, distance: "Cosine" } }); }
}

// Build points (title/url/chunks) for one note's content.
function notePoints(relPath, content) {
  const base = relPath.replace(/\.md$/, "").split("/").pop();
  let title = base;
  const fm = content.match(/^---[\s\S]*?\ntitle:\s*"?([^"\n]+)"?/);
  if (fm) title = fm[1].trim();
  const body = content.replace(/^---[\s\S]*?---\n/, "");
  const webBase = (config.brainWebUrl || "").replace(/\/+$/, "");
  const url = webBase ? `${webBase}/blob/${config.brainBranch}/${relPath.split("/").map(encodeURIComponent).join("/")}` : "";
  return chunkText(body).map((text, i) => ({ key: relPath + "#" + i, title, url, text }));
}

// Incrementally (re)index a single note by its vault-relative path.
export async function indexNoteByPath(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  if (!clean.endsWith(".md")) return { ok: false, error: "not a .md path" };
  let content = "";
  try { content = await fs.readFile(path.join(config.brainPath, clean), "utf8"); }
  catch (e) { return { ok: false, error: "read failed: " + e.message }; }

  await ensureCollection();
  // Drop old points for this note (so edits/deletes don't leave stale chunks).
  try {
    await qdrant("POST", `/collections/${COLLECTION}/points/delete`, {
      filter: { must: [{ key: "path", match: { value: clean } }] },
    });
  } catch {}

  const points = [];
  for (const p of notePoints(clean, content)) {
    let vector;
    try { vector = await embed(p.text); } catch { continue; }
    points.push({ id: uuidFrom(p.key), vector, payload: { path: clean, title: p.title, url: p.url, text: p.text } });
  }
  if (points.length) await qdrant("PUT", `/collections/${COLLECTION}/points`, { points });
  return { ok: true, path: clean, chunks: points.length };
}

// Semantic search. Returns { ok, results:[{title,url,text,score}] }.
export async function searchBrain({ query, limit } = {}) {
  const q = (query || "").trim();
  if (!q) return { ok: false, error: "empty query" };
  let vector;
  try { vector = await embed(q); } catch (e) { return { ok: false, error: "embed failed: " + e.message }; }
  let res;
  try {
    res = await qdrant("POST", `/collections/${COLLECTION}/points/search`, {
      vector, limit: Number(limit) || 5, with_payload: true,
    });
  } catch (e) {
    return { ok: false, error: "search failed (¿reindexado?): " + e.message };
  }
  const results = (res.result || []).map((h) => ({
    title: h.payload?.title, url: h.payload?.url, text: h.payload?.text, score: h.score,
  }));
  return { ok: true, results };
}
