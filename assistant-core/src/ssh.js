// SSH to homelab nodes — used by the hub terminal (interactive PTY over a
// WebSocket) and by Rebeca's run_on_node tool (one-shot exec).
//
// SECURITY: connects as a dedicated non-root user (config.sshUser, in the docker
// group) with a dedicated private key (config.sshKeyPath), only to nodes in the
// registry, only over the tailnet. Mutating commands require explicit confirmation
// (see isReadOnly + run_on_node). Everything stays OFF until NODE_SSH_ENABLED=true.

import fs from "node:fs";
import { Client } from "ssh2";
import { config } from "./config.js";

// Default registry; override with the NODES env (JSON name->host).
const DEFAULT_NODES = {
  ocra: "ocra.stegosaurus-panga.ts.net",
  sadida: "sadida.stegosaurus-panga.ts.net",
  omarchy: "omarchy.stegosaurus-panga.ts.net",
  aery: "aery.stegosaurus-panga.ts.net",
  sram: "sram.stegosaurus-panga.ts.net",
  sacro: "sacro.stegosaurus-panga.ts.net",
  xelor: "xelor.stegosaurus-panga.ts.net",
};
export function nodes() {
  if (!config.nodesJson) return DEFAULT_NODES;
  try { return { ...DEFAULT_NODES, ...JSON.parse(config.nodesJson) }; } catch { return DEFAULT_NODES; }
}
export function nodeNames() { return Object.keys(nodes()); }
export function sshEnabled() { return config.sshEnabled; }

function privateKey() {
  return fs.readFileSync(config.sshKeyPath);
}
function hostFor(name) {
  const h = nodes()[name];
  if (!h) throw new Error(`Unknown node: ${name}`);
  return h;
}

// A command is "read-only" if its first token is in this allowlist. Anything else
// is treated as mutating and needs confirmation.
const RO = [
  "docker ps", "docker images", "docker logs", "docker inspect", "docker stats",
  "docker version", "docker info", "docker compose ls", "docker compose ps",
  "ls", "ll", "cat", "head", "tail", "grep", "find", "stat", "wc",
  "df", "du", "free", "uptime", "whoami", "pwd", "date", "uname", "hostname",
  "systemctl status", "journalctl", "ip a", "ip addr", "ping", "nvidia-smi",
  "top", "htop", "ps", "ss", "netstat", "echo", "env", "which",
];
export function isReadOnly(command) {
  const c = String(command || "").trim().toLowerCase();
  // reject obvious chaining that could hide a mutation after a read-only prefix
  if (/[;&|`$><]/.test(c) && !/\|\s*(grep|head|tail|wc|less|cat)\b/.test(c)) {
    // allow simple safe pipes to pagers/filters; otherwise treat as mutating
    if (/[;&`$>]|\|\|/.test(c)) return false;
  }
  return RO.some((p) => c === p || c.startsWith(p + " "));
}

// One-shot command execution. Returns { ok, node, command, stdout, stderr, code }.
export function execOnNode(nodeName, command, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!sshEnabled()) return resolve({ ok: false, error: "SSH disabled (set NODE_SSH_ENABLED=true)." });
    let host;
    try { host = hostFor(nodeName); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const conn = new Client();
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (!done) { done = true; try { conn.end(); } catch {} resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, node: nodeName, command, error: "timeout" }), timeoutMs);
    conn.on("ready", () => {
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) { clearTimeout(timer); return finish({ ok: false, node: nodeName, command, error: err.message }); }
        stream.on("close", (code) => {
          clearTimeout(timer);
          finish({ ok: true, node: nodeName, command, code, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 8000) });
        });
        stream.on("data", (d) => { stdout += d.toString("utf8"); });
        stream.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      });
    });
    conn.on("error", (e) => { clearTimeout(timer); finish({ ok: false, node: nodeName, command, error: e.message }); });
    try {
      conn.connect({ host, port: 22, username: config.sshUser, privateKey: privateKey(), readyTimeout: 15000 });
    } catch (e) { clearTimeout(timer); finish({ ok: false, node: nodeName, command, error: e.message }); }
  });
}

// Open an interactive shell (PTY). Calls handlers with the ssh2 stream. Used by the
// WebSocket terminal. Returns the Client so the caller can end() it.
export function openShell(nodeName, { cols = 80, rows = 24, onData, onClose, onError }) {
  if (!sshEnabled()) { onError && onError(new Error("SSH disabled")); return null; }
  let host;
  try { host = hostFor(nodeName); } catch (e) { onError && onError(e); return null; }
  const conn = new Client();
  let shellStream = null;
  conn.on("ready", () => {
    conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
      if (err) { onError && onError(err); try { conn.end(); } catch {} return; }
      shellStream = stream;
      stream.on("data", (d) => onData && onData(d.toString("utf8")));
      stream.stderr.on("data", (d) => onData && onData(d.toString("utf8")));
      stream.on("close", () => { onClose && onClose(); try { conn.end(); } catch {} });
    });
  });
  conn.on("error", (e) => onError && onError(e));
  conn.connect({ host, port: 22, username: config.sshUser, privateKey: privateKey(), readyTimeout: 15000 });
  return {
    write: (data) => { if (shellStream) shellStream.write(data); },
    resize: (c, r) => { if (shellStream) shellStream.setWindow(r, c, 0, 0); },
    end: () => { try { conn.end(); } catch {} },
  };
}
