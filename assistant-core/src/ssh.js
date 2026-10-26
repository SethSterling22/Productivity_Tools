// SSH to homelab nodes — used by the hub terminal (interactive PTY over a
// WebSocket) and by Rebeca's run_on_node tool (one-shot exec).
//
// SECURITY: connects as a dedicated non-root user (config.sshUser, in the docker
// group) with a dedicated private key (config.sshKeyPath), only to nodes in the
// registry, only over the tailnet. Mutating commands require explicit confirmation
// (see isReadOnly + run_on_node). Everything stays OFF until NODE_SSH_ENABLED=true.

import fs from "node:fs";
import net from "node:net";
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

// Quick TCP reachability check to a node's SSH port (no auth) — for status lights.
function ping(host, port = 22, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (up) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(up); } };
    s.setTimeout(timeout);
    s.on("connect", () => fin(true));
    s.on("timeout", () => fin(false));
    s.on("error", () => fin(false));
  });
}
export async function nodeStatus() {
  const n = nodes();
  const out = {};
  await Promise.all(Object.entries(n).map(async ([name, host]) => { out[name] = await ping(host); }));
  return out;
}

function privateKey() {
  return fs.readFileSync(config.sshKeyPath);
}
function hostFor(name) {
  const h = nodes()[name];
  if (!h) throw new Error(`Unknown node: ${name}`);
  return h;
}

// ── Read-only classification ────────────────────────────────────────────────
// A command is "read-only" when it only inspects the node. Anything else needs
// explicit confirmation. Rather than a flat prefix list (which kept missing
// things like `docker network ls`), binaries with subcommands are classified by
// their verb.

// Plain binaries that never change state: system, files, network, security.
const RO_BIN = new Set([
  // files & text
  "ls", "ll", "cat", "bat", "head", "tail", "grep", "egrep", "zgrep", "rg", "find", "fd",
  "stat", "wc", "file", "readlink", "realpath", "basename", "dirname", "sort", "uniq",
  "cut", "awk", "sed", "tree", "diff", "cmp", "md5sum", "sha256sum", "strings", "xxd",
  // system
  "df", "du", "free", "uptime", "whoami", "id", "groups", "pwd", "date", "uname",
  "hostname", "journalctl", "dmesg", "top", "htop", "ps", "pidof", "pgrep", "lsof",
  "env", "printenv", "which", "whereis", "type", "lsblk", "lscpu", "lsmod", "lspci",
  "lsusb", "mount", "blkid", "nproc", "vmstat", "iostat", "sensors", "uptime",
  "nvidia-smi", "rocm-smi", "echo", "printf", "last", "lastlog", "who", "w", "getent",
  "crontab -l", "timedatectl", "localectl", "hostnamectl",
  // network
  "ping", "ping6", "traceroute", "tracepath", "mtr", "dig", "host", "nslookup",
  "whois", "arp", "ss", "netstat", "ifconfig", "iwconfig", "ethtool", "nmcli",
  "tailscale", "wg", "route", "curl", "wget", "nc", "telnet", "openssl", "nmap",
  "tcpdump", "arping", "speedtest", "iperf3",
  // security / audit (read paths)
  "aa-status", "sestatus", "getcap", "getfacl", "ssh-keyscan", "ssh-keygen",
  "gpg", "certbot", "fail2ban-client", "lynis", "rkhunter", "chkrootkit", "clamscan",
  "auditctl", "ausearch", "aureport", "sudo",
]);
// Binaries above that are read-only ONLY for certain first args.
const RO_BIN_ARGS = {
  sudo: new Set(["-l", "-n", "-V", "--list", "--version"]),
  crontab: new Set(["-l"]),
  tailscale: new Set(["status", "ip", "ping", "netcheck", "version", "whois", "dns", "lock", "debug", "serve", "funnel", "metrics"]),
  wg: new Set(["show"]),
  nmcli: new Set(["device", "connection", "general", "networking", "radio", "monitor", "d", "c", "g"]),
  auditctl: new Set(["-l", "-s"]),
  "fail2ban-client": new Set(["status", "get", "ping", "version"]),
  certbot: new Set(["certificates", "--version", "show_account"]),
  "ssh-keygen": new Set(["-l", "-F", "-y"]),
  gpg: new Set(["--list-keys", "--list-secret-keys", "--fingerprint", "--verify", "--version"]),
};

// docker: read-only top-level verbs…
const RO_DOCKER = new Set([
  "ps", "images", "logs", "inspect", "stats", "version", "info", "port", "top",
  "diff", "history", "events", "search",
]);
// …and object groups whose read-only verbs live one level deeper.
const RO_DOCKER_GROUP = new Set([
  "network", "volume", "image", "container", "system", "node", "service",
  "context", "config", "compose", "secret", "plugin", "buildx",
]);
const RO_SUBVERB = new Set([
  "ls", "list", "inspect", "df", "ps", "logs", "config", "version", "history",
  "top", "port", "show", "stats", "events",
]);

// Other tools with subcommands.
const RO_SYSTEMCTL = new Set(["status", "show", "list-units", "list-unit-files", "list-timers", "list-sockets", "is-active", "is-enabled", "is-failed", "cat"]);
const RO_KUBECTL = new Set(["get", "describe", "logs", "top", "explain", "api-resources", "api-versions", "version", "config", "cluster-info", "events", "auth"]);
const RO_IP = new Set(["a", "addr", "link", "route", "neigh", "rule", "maddr", "-4", "-6", "-br", "-s", "-c"]);
const RO_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "config", "blame", "shortlog", "ls-files", "tag"]);
// LXC / LXD / Proxmox containers & VMs
const RO_LXC = new Set(["list", "info", "config", "image", "network", "storage", "profile", "version", "cluster", "monitor", "query"]);
const RO_PCT = new Set(["list", "status", "config", "df", "listsnapshot", "cpusets"]);      // Proxmox LXC
const RO_QM = new Set(["list", "status", "config", "showcmd", "listsnapshot", "monitor"]);  // Proxmox VMs
const RO_PVE = new Set(["status", "get", "ls", "report", "list"]);                          // pvesh/pvesm/pvecm
// Firewalls: listing rules is read-only, changing them is not. Flags are
// case-sensitive, so inspect the raw command instead of the lowercased token.
function iptablesIsRead(raw) {
  if (/(^|\s)-(A|I|D|R|P|N|X|F|Z|E)(\s|$)/.test(raw)) return false; // mutating flags
  return /(^|\s)(-L|-S|--list|--list-rules)(\s|$)/.test(raw);
}
const RO_UFW = new Set(["status", "show", "version"]);

// Commands that are destructive or disruptive enough that they ALWAYS require
// confirmation, even if "open" mode is enabled. These are not blocked — the user
// can still approve them — but they must never run unattended.
const DANGER_RE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,          // rm -rf …
  /\bmkfs(\.|\s)/i, /\bfdisk\b/i, /\bparted\b/i, /\bwipefs\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,                   // dd onto a device
  /\b(shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/i,
  /\bsystemctl\s+(stop|disable|mask)\b/i,
  /^(sudo\s+)?(userdel|groupdel|passwd|chpasswd|usermod)\b/i,   // account changes
  /\biptables\s+(-F|--flush|-X)\b/i, /\bufw\s+(disable|reset)\b/i,
  /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)\b/i,
  /\b(pct|qm)\s+(destroy|stop)\b/i, /\blxc\s+delete\b/i,
  /\bkubectl\s+delete\b/i,
  /\bchmod\s+(-R\s+)?777\b/i, /\bchown\s+-R\s+\//i,
  /:\(\)\s*\{.*\}\s*;?\s*:/,                    // fork bomb
  /\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/i,            // piping anything into a shell
];
export function isDangerous(command) {
  const c = String(command || "");
  return DANGER_RE.some((re) => re.test(c));
}

// Split a command line on &&, ||, |, ; and & — ignoring separators inside quotes,
// so `--format '{{range .X}}|{{end}}'` is not mistaken for a pipe.
function splitSegments(cmd) {
  const out = [];
  let cur = "", q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) { out.push(cur); cur = ""; i++; continue; }
    if (ch === "|" || ch === ";" || ch === "&") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// True when the character appears outside quotes (redirection, substitution…).
function hasUnquoted(cmd, chars) {
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (chars.includes(ch)) return true;
    if (ch === "$" && cmd[i + 1] === "(") return true;
  }
  return false;
}

export function isReadOnly(command) {
  const c = String(command || "").trim();
  if (!c) return false;

  // Writing to a file or substituting a command is never plain reading.
  if (hasUnquoted(c, "><`")) return false;

  // A chain is read-only only if EVERY segment is. This is what allows
  // `docker inspect X --format '…' && docker network ls | grep -v CONTAINER`.
  const segments = splitSegments(c);
  if (segments.length > 1) return segments.every((s) => isReadOnly(s));

  const t = segments[0].split(/\s+/);
  const bin = t[0].toLowerCase();
  const a1 = (t[1] || "").toLowerCase();
  const a2 = (t[2] || "").toLowerCase();

  // Binaries that are read-only only for some first args (sudo -l, wg show, …).
  if (RO_BIN_ARGS[bin]) {
    if (!RO_BIN_ARGS[bin].has(a1)) return false;
    // `sudo -l` is fine; `sudo <anything else>` is classified by the inner command.
    return true;
  }
  if (RO_BIN.has(bin)) return true;
  if (bin === "docker" || bin === "podman" || bin === "nerdctl") {
    if (RO_DOCKER.has(a1)) return true;
    if (RO_DOCKER_GROUP.has(a1)) return RO_SUBVERB.has(a2);
    return false;
  }
  if (bin === "systemctl") return RO_SYSTEMCTL.has(a1);
  if (bin === "kubectl" || bin === "k3s") return RO_KUBECTL.has(a1) || (a1 === "kubectl" && RO_KUBECTL.has(a2));
  if (bin === "ip") return RO_IP.has(a1);
  if (bin === "git") return RO_GIT.has(a1);
  if (bin === "lxc" || bin === "incus") return RO_LXC.has(a1) && (a1 === "list" || a1 === "info" || a1 === "version" || RO_SUBVERB.has(a2) || a2 === "show" || a2 === "get");
  if (bin === "pct") return RO_PCT.has(a1);
  if (bin === "qm") return RO_QM.has(a1);
  if (bin === "pvesh" || bin === "pvesm" || bin === "pvecm" || bin === "pveversion") return !a1 || RO_PVE.has(a1);
  if (bin === "iptables" || bin === "ip6tables") return iptablesIsRead(segments[0]);
  if (bin === "nft") return a1 === "list";
  if (bin === "ufw") return RO_UFW.has(a1);
  if (bin === "zfs" || bin === "zpool") return a1 === "list" || a1 === "status" || a1 === "get";
  return false;
}

// Three-tier classification used by run_on_node.
//   read   -> runs immediately
//   write  -> needs confirm:true (or NODE_SSH_MODE=open)
//   danger -> always needs confirm:true, and the model must warn the user
export function classifyCommand(command) {
  if (isDangerous(command)) return "danger";
  return isReadOnly(command) ? "read" : "write";
}
// "open" lets ordinary write commands run unattended; danger still needs a yes.
export function openMode() {
  return String(process.env.NODE_SSH_MODE || "guarded").toLowerCase() === "open";
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
