# Multi-model routing plan (task-specialized)

Goal: route each request to the *specialized* local model that's best at that kind
of task — small models often beat a big generalist on their niche — and reserve
Claude for the hardest cases. Grounded in Sep 2026 model landscape (sources at end).

## Hosts (what we route across)

| Host | GPU / VRAM | Availability | Role |
|---|---|---|---|
| **Sadida** | RTX 3050 Mobile, **4 GB** | always on | fast / default tier (one small model at a time) |
| **omarchy** | ~**8 GB** (verify: `nvidia-smi --query-gpu=name,memory.total --format=csv`) | when desktop is on | heavy / specialized tier (reasoning, coding) |
| **Claude** | cloud (Anthropic API) | always | last resort for the most complex tasks |

Ollama swaps models in/out of VRAM on demand, so each host holds one active model at
a time; first call after a switch pays a load cost. That's why fast-tier lives on
always-on Sadida and the heavy specialists on omarchy.

## Proposed lineup by task

| Task category | Model (Ollama tag) | Host | ~VRAM (Q4) | Why |
|---|---|---|---|---|
| **Trivial / fast chat** (greetings, quick facts, reformat) | `qwen3:1.7b` | Sadida | ~1.3 GB | 25–40 tok/s, loads instantly; good enough for throwaway turns |
| **General + tool calling** (default agent loop) | `qwen3.5:4b` (current) or `gemma4:e4b` | Sadida | ~3 GB | reliable tool/JSON; Gemma 4 has native function calling |
| **Reasoning / math / logic** | `deepseek-r1:8b` | omarchy | ~5.2 GB | R1 distill, chain-of-thought; 88% MATH-500 (beats general 7–8B) |
| **Coding / technical** | `qwen2.5-coder:7b` | omarchy | ~4.7 GB | dense coder that fits 8 GB (qwen3-coder only ships 30B/480B MoE — too big) |
| **Most complex / fallback** | Claude (`ASSISTANT_MODEL`) | cloud | — | multi-step, ambiguous, high-stakes; last resort |

Notes on the 8 GB ceiling for omarchy:
- `deepseek-r1:8b` (~5.2 GB) and `qwen3:8b` (~5 GB) fit comfortably.
- 14B specialists (`deepseek-r1:14b`, `qwen2.5-coder:14b`, ~9 GB) are **too big for 8 GB**
  — only viable if omarchy turns out to have 12 GB+. Confirm VRAM first.
- `qwen3-coder` on Ollama only ships as 30B (~19 GB) and 480B MoE — neither fits; use
  the dense `qwen2.5-coder` series (0.5B–32B) for small coding models.
- If omarchy is off, the router falls back: reasoning/coding → Claude; trivial/general
  stay on Sadida.

## Routing design (assistant-core)

Add a **model router** in front of the existing LLM adapter:

1. **Classify** the incoming user turn into a category (trivial / general / reasoning /
   coding / complex). Two options:
   - *Heuristic first (cheap, zero latency):* keywords + length + whether tools are
     likely needed. Good enough to start.
   - *Model-assisted (later):* a one-shot call to the fast model to label the task.
2. **Map** category → `{host, model}` via a small routing table (env/JSON, editable
   like `tools.manifest.json`).
3. **Health-gate + failover** (reuse the `withVoiceHost` pattern): if the target host
   fails `/health` or the call errors, fall to the next choice (omarchy → Sadida →
   Claude). So a powered-off omarchy never breaks a request.
4. The **tool-calling loop is unchanged** — only *which* model backs a given turn
   changes. Tool descriptors, Hermes, n8n all stay the same.

### Config sketch

```
OLLAMA_HOSTS = { sadida: "http://sadida...:11434", omarchy: "http://omarchy...:11434" }
MODEL_ROUTES = {
  trivial:   { host: "sadida",  model: "qwen3:1.7b" },
  general:   { host: "sadida",  model: "qwen3.5:4b" },
  reasoning: { host: "omarchy", model: "deepseek-r1:8b", fallback: "claude" },
  coding:    { host: "omarchy", model: "qwen3-coder:8b", fallback: "claude" },
  complex:   { model: "claude" }
}
```

## Host split (light specialists on Sadida, strong ones on omarchy)

Same categories exist on both hosts: the router prefers omarchy's strong model and
falls back to Sadida's light version when omarchy is off, then to Claude.

**Sadida (4 GB, always on) — light tier (all fit; loaded one at a time):**
```bash
ollama pull qwen3:1.7b          # trivial / fast          (~1.3 GB)
# qwen3.5:4b already present     # general + tool calling  (~3 GB)
ollama pull deepseek-r1:1.5b    # reasoning (light)       (~1.1 GB)
ollama pull qwen2.5-coder:3b    # coding (light)          (~2 GB)
```

**omarchy (~8 GB, when on) — strong tier:**
```bash
ollama pull deepseek-r1:8b      # reasoning               (~5.2 GB)
ollama pull qwen2.5-coder:7b    # coding                  (~4.7 GB)
ollama pull qwen3:8b            # strong general (optional, ~5 GB)
```

## Rollout
1. Confirm omarchy VRAM.
2. Pull the models above on the right hosts.
3. Implement the router (heuristic classifier + routing table + failover) in
   assistant-core; wire it into the agent's LLM adapter.
4. Test each category routes to the expected host, and that omarchy-off falls back.

## Sources
- Small/fast models: <https://localaimaster.com/blog/small-language-models-guide-2026>, <https://benchlm.ai/best/ollama-models>
- 8/12 GB reasoning + tool calling: <https://localaimaster.com/vram/best-llm-12gb-vram>, <https://modelfit.io/blog/best-ai-models-for-8gb-vram/>
- Coding specialists: <https://localaimaster.com/models/best-local-ai-coding-models>, <https://www.morphllm.com/best-ollama-models>
- DeepSeek-R1 distills vs Qwen: <https://www.promptquorum.com/power-local-llm/deepseek-vs-qwen-local-comparison-2026>, <https://ollama.com/library/deepseek-r1>
