// Nextcloud client (WebDAV for files + OCS for shares/quota).
//
// Credentials stay server-side (app password in .env). Used by the /files/* routes
// (dashboard widget) and the Archivos builtins (chat/voice tools). Node's fetch
// (undici) allows custom WebDAV methods (PROPFIND, MKCOL, MOVE, DELETE).

import { config } from "./config.js";

export function nextcloudEnabled() {
  return Boolean(config.nextcloudUrl && config.nextcloudUser && config.nextcloudPassword);
}

function auth() {
  return "Basic " + Buffer.from(`${config.nextcloudUser}:${config.nextcloudPassword}`).toString("base64");
}
function davBase() {
  return `${config.nextcloudUrl}/remote.php/dav/files/${encodeURIComponent(config.nextcloudUser)}`;
}
// Normalize a user path ("", "/", "Docs/a.pdf") to a clean relative path.
function clean(p) {
  return String(p || "").replace(/^\/+|\/+$/g, "").split("/").filter((s) => s && s !== "..").join("/");
}
// Build a full WebDAV URL for a relative path (each segment encoded).
function davUrl(p) {
  const rel = clean(p);
  const enc = rel ? "/" + rel.split("/").map(encodeURIComponent).join("/") : "";
  return davBase() + enc;
}

async function dav(method, p, { headers = {}, body } = {}) {
  if (!nextcloudEnabled()) throw new Error("Nextcloud not configured (NEXTCLOUD_URL/USER/APP_PASSWORD).");
  const res = await fetch(davUrl(p), { method, headers: { Authorization: auth(), ...headers }, body });
  return res;
}

// ── Listing (PROPFIND depth 1) ──────────────────────────────────────────────
const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:getlastmodified/><d:getcontentlength/><d:resourcetype/><d:getcontenttype/>" +
  "</d:prop></d:propfind>";

function tag(block, name) {
  const m = new RegExp(`<[a-z0-9]*:?${name}[^>]*>([\\s\\S]*?)<\\/[a-z0-9]*:?${name}>`, "i").exec(block);
  return m ? m[1].trim() : "";
}

export async function list(path = "") {
  const res = await dav("PROPFIND", path, {
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: PROPFIND_BODY,
  });
  if (!res.ok && res.status !== 207) throw new Error(`Nextcloud list HTTP ${res.status}`);
  const xml = await res.text();
  const base = `/remote.php/dav/files/${config.nextcloudUser}`;
  const here = clean(path);
  const items = [];
  const blocks = xml.split(/<[a-z0-9]*:?response[ >]/i).slice(1);
  for (const b of blocks) {
    const hrefRaw = tag(b, "href");
    if (!hrefRaw) continue;
    let rel = decodeURIComponent(hrefRaw).replace(base, "").replace(/^\/+|\/+$/g, "");
    if (rel === here) continue; // skip the folder itself
    const isDir = /<[a-z0-9]*:?collection\s*\/?>/i.test(b);
    const name = rel.split("/").pop();
    items.push({
      name,
      path: rel,
      isDir,
      size: Number(tag(b, "getcontentlength") || 0),
      mtime: tag(b, "getlastmodified") || null,
      mime: tag(b, "getcontenttype") || (isDir ? "folder" : ""),
    });
  }
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, path: here, items };
}

// ── File ops ────────────────────────────────────────────────────────────────
export async function download(path) {
  const res = await dav("GET", path);
  if (!res.ok) throw new Error(`Nextcloud download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, mime: res.headers.get("content-type") || "application/octet-stream" };
}

export async function upload(path, buffer, mime) {
  const res = await dav("PUT", path, {
    headers: { "Content-Type": mime || "application/octet-stream" },
    body: buffer,
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error(`Nextcloud upload HTTP ${res.status}`);
  return { ok: true, path: clean(path) };
}

export async function mkdir(path) {
  const res = await dav("MKCOL", path);
  if (!res.ok && res.status !== 201 && res.status !== 405) throw new Error(`Nextcloud mkdir HTTP ${res.status}`);
  return { ok: true, path: clean(path), result: `Folder created: ${clean(path)}` };
}

export async function move(src, dst) {
  const res = await dav("MOVE", src, { headers: { Destination: davUrl(dst), Overwrite: "F" } });
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error(`Nextcloud move HTTP ${res.status}`);
  return { ok: true, result: `Moved to ${clean(dst)}`, path: clean(dst) };
}

export async function remove(path) {
  const res = await dav("DELETE", path);
  if (!res.ok && res.status !== 204) throw new Error(`Nextcloud delete HTTP ${res.status}`);
  return { ok: true, result: `Deleted: ${clean(path)} (moved to Nextcloud trash)` };
}

// ── OCS: share link + quota ─────────────────────────────────────────────────
async function ocs(method, apiPath, body) {
  const res = await fetch(`${config.nextcloudUrl}/ocs/v2.php${apiPath}`, {
    method,
    headers: {
      Authorization: auth(),
      "OCS-APIRequest": "true",
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j };
}

export async function shareLink(path, { password } = {}) {
  const form = new URLSearchParams({ path: "/" + clean(path), shareType: "3", permissions: "1" });
  if (password) form.set("password", password);
  const { data } = await ocs("POST", "/apps/files_sharing/api/v1/shares?format=json", form.toString());
  const d = data && data.ocs && data.ocs.data;
  if (!d || !d.url) return { ok: false, error: (data && data.ocs && data.ocs.meta && data.ocs.meta.message) || "share failed" };
  return { ok: true, url: d.url, result: `Share link: ${d.url}` };
}

export async function quota() {
  const res = await dav("PROPFIND", "", {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>',
  });
  const xml = await res.text();
  const used = Number(tag(xml, "quota-used-bytes") || 0);
  const avail = Number(tag(xml, "quota-available-bytes") || 0); // -3 = unlimited
  const total = avail >= 0 ? used + avail : null;
  return { ok: true, used, available: avail, total, usedGB: +(used / 1e9).toFixed(2), totalGB: total ? +(total / 1e9).toFixed(2) : null };
}
