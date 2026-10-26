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
| **Trivial / fast chat** (greetings, quick facts, reformat) | `qwen3:1.7b` | Sadida | 1.7 GB measured | 100% GPU; also the always-on tool-calling fallback when omarchy is off |
| **General + tool calling** (default agent loop) | `qwen3:8b` | omarchy | ~6 GB | measured 100% GPU; the tier that matters most for agentic work |
| **Reasoning / math / logic** | `deepseek-r1:8b` | omarchy | ~5.2 GB | R1 distill, chain-of-thought; 88% MATH-500 (beats general 7–8B) |
| **Coding / technical** | `qwen2.5-coder:7b` | omarchy | ~4.7 GB | dense coder that fits 8 GB (qwen3-coder only ships 30B/480B MoE — too big) |
| **Planning / compose-new** | Claude (`ASSISTANT_MODEL`) | cloud | — | breaking a goal into a project + subtasks; needs to invent clean structure |

### Classification rules (as implemented)

The classifier is pure heuristics (keywords + length), evaluated in this order:

1. **Planning** ("planifica", "desglosa en tareas", "hoja de ruta", "roadmap") →
   `complex` → **Claude first**. This is the "invent something new" case.
2. **Explicit `/tool …` invocations** and **node commands** (a node name +
   infra word, or `run_on_node`) → `general` → **the local tool model** (`qwen3:8b`
   on omarchy, `qwen3:1.7b` on Sadida), Claude only
   as fallback. Deliberately *not* the coder: a small coding model tends to answer
   with text instead of calling the tool.
3. **Coding** (code fences, stack traces, language/tooling keywords) → `coding`.
4. **Reasoning** ("por qué", "calcula", "paso a paso", "demuestra") → `reasoning`.
5. Very long input (>800 chars) → `complex`; short greetings → `trivial`;
   everything else → `general`.

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

## Rollout  ✅ IMPLEMENTED

1. ✅ omarchy confirmed at 8 GB; models pulled on both hosts.
2. ✅ Router implemented in assistant-core:
   - `src/router.js` — `classify()` (heuristic categories) + `routeFor()` (failover
     chain per category). Table = `DEFAULT_ROUTES`, override via `MODEL_ROUTES` env.
   - `src/llm.js` — `runModel({..., chain})` tries targets in order, health-gates each
     Ollama host (`GET /api/tags`, 1.5 s), and falls through (omarchy → sadida → Claude).
   - `src/agent.js` — classifies the turn once, passes the chain, and emits `route`
     (category) and `model` (provider/model/host) SSE events for transparency.
3. Categories → chains are in the table above.

### Config / tuning
- `MODEL_ROUTING=on|off` (default on; off = legacy "Claude primary, Ollama fallback").
- `OLLAMA_SADIDA_URL`, `OLLAMA_OMARCHY_URL` — host endpoints.
- `MODEL_ROUTES` — JSON to override the table, e.g.
  `{"coding":[{"host":"omarchy","model":"qwen2.5-coder:7b"},{"claude":true}]}`.

### Deploy (code change → rebuild)
```bash
# workstation: git push origin main
cd ~/Productivity_Tools/n8n && git pull
sudo docker compose up -d --build --no-deps assistant-core
```

### Verify
Ask something in each category and check `docker logs assistant_core` /the SSE `model`
event shows the expected host+model; power off omarchy and confirm reasoning/coding
fall back to sadida's light models, then to Claude.

---

## Review — October 2026

### The gap: omarchy has no tool-calling model

Node commands, explicit `/tool` calls and the default agent loop all land in
**`general`**, whose only local target is **`qwen3.5:4b` on Sadida (4B)**. omarchy
(8 GB) only holds a *reasoning* and a *coding* model, so the strongest hardware is
never used for the thing that fails most often: multi-step tool calling.

That matches the observed symptom — the 4B model announcing an action instead of
emitting the tool call, or giving up after one refusal.

### What the numbers say (BFCL-v4 / TAU2-Bench)

| Model | Fits | Tool-calling evidence |
|---|---|---|
| **Qwen3.5-9B** | omarchy (8 GB) | Reported **66.1 BFCL-V4 / 79.1 TAU2-Bench**; described as the strongest option that fits an 8 GB card |
| **Qwen3.5-4B** (current) | Sadida (4 GB) | **79.9 TAU2-Bench**, <3 GB at 4-bit — already the right pick for the small tier |
| **Gemma 4 E4B** | Sadida | Native function-call special tokens (structural advantage over prompt-based JSON) — worth A/B testing |
| Qwen3-4B | Sadida | Held the top sub-7B spot through early 2026 |

Conclusion: the small tier is already well chosen; **what's missing is a 9B
tool-caller on omarchy**.

### Recommended change

```bash
# on omarchy (8 GB) — the missing tool-calling tier
ollama pull qwen3.5:9b        # ~6.6 GB
```

Then route `general` to it first, falling back to Sadida's 4B and finally Claude:

```
general: omarchy/qwen3.5:9b → sadida/qwen3.5:4b → claude
```

Set it without touching code via `MODEL_ROUTES`:

```
MODEL_ROUTES={"general":[{"host":"omarchy","model":"qwen3.5:9b"},{"host":"sadida","model":"qwen3.5:4b"},{"claude":true}]}
```

### Measured outcome (what actually happened)

The 9B recommendation did **not** survive contact with the hardware. Real
`ollama ps` numbers:

| Model | Host | Reported size | Result |
|---|---|---|---|
| `qwen3.5:4b` | Sadida (4 GB) | 3.8 GB | **43% CPU** — never fit; removed |
| `qwen3.5:9b` | omarchy (8 GB) | 6.3 GB | 32% CPU — doesn't fit |
| `qwen3:8b` @ ctx 8192 | omarchy | 6.0 GB | 18% CPU |
| `qwen3:8b` @ ctx 4096 | omarchy | 5.7 GB | 12% CPU |
| **`qwen3:8b` @ ctx 8192, Whisper stopped** | omarchy | — | **100% GPU ✅** |
| **`qwen3:1.7b`** | Sadida | 1.7 GB | **100% GPU ✅** |
| `gemma4:e2b` | Sadida | 4.6 GB on disk | too big (its `ollama ps` size of 288 MB is a bogus reading for multimodal models) |

Three lessons:
1. **`ollama ps` SIZE includes the KV cache and compute buffers**, not just weights —
   and for multimodal models it under-reports badly. Trust `nvidia-smi`.
2. **Usable VRAM is well under the sticker number.** omarchy's 8 GB had ~1.9 GB taken
   by the desktop, Opera, the terminal and — the big one — **Rebeca's own Whisper
   container holding 708 MB**. Voice and the LLM were competing for the same GPU;
   stopping `whisper_stt` on omarchy was what finally made the 8B fit.
3. **Context length is paid up front.** With 23 tool schemas in every request, 4096 is
   genuinely tight for agentic turns, so 8192 is the floor worth defending — which is
   exactly why freeing that 708 MB mattered more than shrinking the context.

Final layout: voice lives on Sadida only; omarchy runs the tool-calling tier.

### Evaluated and rejected

- **Ternary Bonsai-2** (PrismML, Sep 2026) — a 27B retaining ~98% of Qwen3.8-27B
  in a fraction of the size, with tools/thinking/vision, which would be spectacular
  for this hardware. **But it needs PrismML's own llama.cpp fork**: stock Ollama
  cannot run it until the ternary kernels land upstream. Re-check later; not
  actionable today.
- **Nemotron 3.5 / Muse Spark / DeepSeek V4.1** — far beyond 8 GB.

## Prompt-processing optimization (Ollama tuning)

These cost nothing and directly attack the two problems we hit: VRAM pressure on
4 GB and the cold-start timeout.

Set on **each Ollama host** (systemd override or the service env):

```bash
OLLAMA_FLASH_ATTENTION=1      # cuts KV-cache VRAM ~30-50%
OLLAMA_KV_CACHE_TYPE=q8_0     # halves KV memory again; quality impact negligible
                              #   (needs flash attention enabled)
OLLAMA_KEEP_ALIVE=30m         # keeps the model resident -> no 100s+ cold start
OLLAMA_CONTEXT_LENGTH=8192    # KV is allocated up front for the FULL context;
                              #   don't pay for 256K you never use
```

Notes:
- On **Sadida (4 GB)** flash attention + `q8_0` is what buys the headroom to keep a
  4B model fully on GPU instead of spilling to CPU.
- `num_batch` (default 512) raises prompt-eval speed / time-to-first-token, but only
  raise it once the model sits at 100% GPU — otherwise it makes things worse.
- `OLLAMA_KEEP_ALIVE` is the direct fix for the Telegram timeout we saw: the first
  request of the day was paying the model load.

## Sources
- Small/fast models: <https://localaimaster.com/blog/small-language-models-guide-2026>, <https://benchlm.ai/best/ollama-models>
- 8/12 GB reasoning + tool calling: <https://localaimaster.com/vram/best-llm-12gb-vram>, <https://modelfit.io/blog/best-ai-models-for-8gb-vram/>
- Coding specialists: <https://localaimaster.com/models/best-local-ai-coding-models>, <https://www.morphllm.com/best-ollama-models>
- DeepSeek-R1 distills vs Qwen: <https://www.promptquorum.com/power-local-llm/deepseek-vs-qwen-local-comparison-2026>, <https://ollama.com/library/deepseek-r1>

### October 2026 review
- Tool-calling benchmarks (BFCL-v4 / TAU2): <https://gorilla.cs.berkeley.edu/leaderboard.html>, <https://benchlm.ai/benchmarks/bfcl-v4>, <https://ai.rs/ai-developer/gemma-4-vs-qwen-3-5-vs-llama-4-compared>, <https://www.ertas.ai/blog/on-device-tool-calling-2026-qwen3-gemma4-phi4>, <https://vdf.ai/blog/best-local-llm-for-agents-tool-calling/>
- Ternary Bonsai-2: <https://prismml.com/news/bonsai-2-27b>, <https://local-ai-zone.github.io/blog/bonsai-2-27b-ternary-quantization-deep-dive.html>
- Ollama tuning: <https://docs.ollama.com/faq>, <https://modelpiper.com/blog/ollama-kv-cache-quantization>, <https://www.ssdnodes.com/learn/ollama-kv-cache-quantization>, <https://eastondev.com/blog/en/posts/ai/20260410-ollama-performance-optimization/>
