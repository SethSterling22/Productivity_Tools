// Homelab metrics via direct PromQL against Prometheus.
//
// Used by:
//   - GET /widgets/homelab  (dashboard panels: CPU/RAM/disk/GPU per node)
//   - the `query_metrics` builtin tool, so Rebeca can read metrics and reason
//     ("is the GPU hot?", "how full is Ocra's disk?").
//
// Metric names assume node_exporter (CPU/RAM/disk) and an NVIDIA exporter (GPU).
// If your exporters differ, override the panels with the METRICS_PANELS env var.

import { config } from "./config.js";

// Default homelab panels. Each returns a vector keyed by instance/gpu.
const DEFAULT_PANELS = [
  {
    label: "CPU",
    unit: "%",
    query: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
  },
  {
    label: "RAM",
    unit: "%",
    query: "100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))",
  },
  {
    label: "Disk /",
    unit: "%",
    query:
      '100 * (1 - (node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}))',
  },
  {
    label: "GPU util",
    unit: "%",
    // DCGM exporter. If you use nvidia_gpu_exporter use e.g.
    // nvidia_smi_utilization_gpu_ratio*100. Override via METRICS_PANELS.
    query: "DCGM_FI_DEV_GPU_UTIL",
  },
  {
    label: "GPU mem",
    unit: "%",
    query: "100 * DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE)",
  },
];

export function metricsEnabled() {
  return Boolean(config.prometheusUrl);
}

function panels() {
  if (!config.metricsPanelsJson) return DEFAULT_PANELS;
  try {
    const p = JSON.parse(config.metricsPanelsJson);
    return Array.isArray(p) && p.length ? p : DEFAULT_PANELS;
  } catch {
    return DEFAULT_PANELS;
  }
}

// Run a single PromQL instant query. Returns the raw Prometheus vector result.
export async function promInstant(query) {
  if (!config.prometheusUrl) throw new Error("PROMETHEUS_URL not set");
  const url = `${config.prometheusUrl.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
    const j = await res.json();
    if (j.status !== "success") throw new Error(`Prometheus: ${j.error || "query failed"}`);
    return j.data?.result || [];
  } finally {
    clearTimeout(t);
  }
}

// A friendly label for a series (node hostname, gpu id, or the instance).
function seriesLabel(metric) {
  const inst = metric.instance || "";
  const host = inst.split(":")[0]; // drop :9100 etc.
  return host || metric.gpu || metric.Hostname || metric.job || "value";
}

// Build the homelab widget panels. Never throws — on error a panel carries an
// `error` field so the UI can show it without breaking the whole widget.
export async function homelabPanels() {
  if (!config.prometheusUrl) return [];
  const out = [];
  for (const p of panels()) {
    try {
      const result = await promInstant(p.query);
      const series = result.map((r) => ({
        name: seriesLabel(r.metric),
        value: Math.round(Number(r.value[1]) * 10) / 10,
      }));
      out.push({ label: p.label, unit: p.unit || "", series });
    } catch (err) {
      out.push({ label: p.label, unit: p.unit || "", series: [], error: err.message });
    }
  }
  return out;
}

// Tool: run an arbitrary PromQL query so the LLM can reason over metrics.
export async function queryMetrics(input = {}) {
  const query = (input.query || "").trim();
  if (!query) {
    return {
      ok: false,
      error: "Missing 'query' (PromQL).",
      hint: "Examples: node_filesystem_avail_bytes{mountpoint=\"/\"}, DCGM_FI_DEV_GPU_UTIL, up",
    };
  }
  if (!config.prometheusUrl) return { ok: false, error: "Metrics not configured (PROMETHEUS_URL empty)." };
  try {
    const result = await promInstant(query);
    const series = result.map((r) => ({
      labels: r.metric,
      value: Number(r.value[1]),
    }));
    return { ok: true, query, count: series.length, series: series.slice(0, 50) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
