# State of the art check — Sep 2026

A review of what's newer/better than the current stack, given the hardware, so we
can decide what (if anything) to upgrade. Sources listed at the bottom. Note this
is a fast-moving space and several sources are secondary; treat model claims as
directional, benchmark before switching.

## Hardware ceiling: Sadida

- CPU: Intel i5-12500H (16 threads), 31 GB RAM, 8 GB swap.
- GPU: **RTX 3050 Mobile — 4 GB VRAM** (+ Intel Iris Xe iGPU, not useful for LLMs).
- Disk: ~87 GB free on `/`.

4 GB VRAM is the hard constraint. The realistic "fits fully on GPU" zone is
**3B–4B parameters at Q4_K_M** (~2.5 GB weights, leaving ~1.5 GB for context).
Bigger models (7–9B) only run with CPU offload → much slower, but the 31 GB RAM
makes them *possible* for non-latency-sensitive use.

## Local models — current vs alternatives

Rebeca currently runs **`qwen3.5:4b`** on Sadida as the Ollama fallback (Claude is
primary). For that role — tool-calling fallback when the API is down — the key
axes are tool-call reliability and VRAM fit.

| Model | Params | Fits 4 GB? | Notes for our use (tool calling) |
|---|---|---|---|
| **Qwen3.5 4B** (current) | 4B | ✅ Q4_K_M | 256K context, multimodal, tool-calling improved via chat-template fixes. Solid all-rounder; still a sub-7B model so complex multi-tool chains can misfire. |
| **Gemma 4 E4B** | ~4B eff. | ✅ | Apr 2026, Apache-2.0, **built for edge with native function calling + structured JSON output**. Strongest 4 GB option specifically for tool calling. Best upgrade candidate to A/B against Qwen. |
| **Phi-4-mini** | 3.8B | ✅ (~2.5 GB) | Very strong reasoning-per-VRAM; great for summarize/Q&A, less specialized for tool calls. |
| **Llama 3.2 3B** | 3B | ✅ | Light and fast; capable chat/summarize, weaker at strict JSON tool calls. |
| **Qwen3.5 9B** | 9B | ⚠️ offload | More reliable single-tool calling, but needs CPU offload on 4 GB → slower. Only worth it if fallback quality matters more than latency. |

**Consensus from the sources:** below ~7B, general models without explicit
tool-call training emit malformed calls under pressure, and quantization harsher
than Q4_K_M degrades reliability — Q4_K_M is the floor.

### Recommendation (models)
1. **Keep Claude as primary.** The local model is a fallback; don't over-invest.
2. **A/B test `gemma4:e4b` vs `qwen3.5:4b`** as the fallback — Gemma 4's native
   function calling is the one concrete, low-risk upgrade for our tool-calling loop
   at 4 GB. Pull both on Sadida and compare on real Rebeca tool prompts.
3. Keep `nomic-embed-text` for embeddings (fine for RAG; not the bottleneck).
4. If we ever want a *good* always-local experience, the honest answer is more
   VRAM (8–12 GB) — but that's hardware you own, out of scope here.

## Hermes Agent (Nous Research) — what's new

Nous Research's **Hermes Agent** (github.com/NousResearch/hermes-agent) has moved
fast in 2026. Relevant to us because it overlaps with what our custom Hermes
gateway does (tools, MCP, memory):

- **v0.20.0 "Herald" (Aug 3 2026):** real-time conversational voice with streaming
  TTS, barge-in, on-device wake words, hands-free control; agent-to-agent (A2A)
  v1.0; signed outbound webhooks; **grounded research with verifiable citations +
  fact-checking**.
- **v0.21.0 "Pantheon" (Aug 31 2026):** "Bot Mode" — a society of named agents with
  group chats (agents talk to each other and to you).
- **Tool-calling hardening:** self-recovery on tool friction (terminal-output
  spillover to files, patch/edit detection, `write_file` disk verification,
  smarter search recovery); default tool-call iteration limit raised 90 → 500.
- **Live steering:** correct the agent mid-turn; work in flight is preserved.
- **MCP maturity:** CLI for MCP server management with OAuth 2.1 PKCE; Hermes Agent
  can itself **act as an MCP server**, exposing its interface to other MCP clients.
  Also a "blank slate" mode that pins toolsets via `platform_toolsets`/`disabled_toolsets`.

### Hermes 4 models (context, not for Sadida)
Hermes 4 (Aug 2025) is a family of open-weight models with **hybrid reasoning**
(answer directly, or think inside `<think>...</think>`), 131K context, and few
guardrails. Sizes (70B / 405B) are far beyond 4 GB VRAM — interesting to know,
not runnable locally on Sadida. Could be used via an API if we ever want an
uncensored reasoning model, but Claude covers that role today.

### Ideas worth borrowing for OUR gateway/assistant-core
These are patterns Hermes Agent proved out that map cleanly onto what we already
have — cheap wins, no dependency on their code:

1. **Grounded answers with citations** — we just added `web_search`; the natural
   next step is a system-prompt rule that when Rebeca uses `web_search` or
   `search_brain_semantic`, she cites the source URLs. (Small prompt change.)
2. **Tool-call self-recovery** — on a failed tool call, feed the error back to the
   model for a retry instead of aborting the turn. Our loop currently returns the
   error; letting the model see it and retry (within `maxAgentSteps`) is a few lines.
3. **Raise the step ceiling for autonomous tasks** — our `maxAgentSteps` is 6.
   Hermes moved to 500 for long runs. 6 is fine for chat; consider a higher cap for
   explicitly "do this multi-step task" requests.
4. **assistant-core as an MCP server** — expose our tools over MCP so Claude Code /
   other MCP clients could drive Rebeca's tools. Bigger project; park it.
5. **A2A / Bot Mode** — multiple specialized agents. Overkill for now; note for later.

## Suggested next steps (priority order)
1. ✅ **Web search** — done (this change): `web_search` via self-hosted SearXNG.
2. **Citations rule** in the system prompt (30-min change, high value with web_search).
3. **A/B Gemma 4 E4B vs Qwen3.5 4B** as the Ollama fallback on Sadida.
4. **Tool-call retry-on-error** in the agent loop (small, improves robustness).
5. Later: MCP-server mode / multi-agent, only if a real need appears.

## Sources
- Local models on 4 GB VRAM: <https://lmsa.app/blog/running-local-ai-on-a-4gb-vram-gpu-in-2026-the-real-world-guide-that-actually-works/>, <https://www.fitmyllm.com/blog/gpu/geforce-rtx-3050-4-gb>, <https://medium.com/codex/best-local-llms-for-4gb-6gb-and-8gb-vram-in-2026-by-task-657f3f973b4f>
- Small models / tool calling: <https://insiderllm.com/guides/function-calling-local-llms/>, <https://www.promptquorum.com/power-local-llm/best-local-models-tool-calling-2026>, <https://localaimaster.com/blog/small-language-models-guide-2026>, <https://unsloth.ai/docs/models/qwen3.5>
- Hermes Agent updates: <https://github.com/NousResearch/hermes-agent/releases>, <https://www.gradually.ai/en/changelogs/hermes-agent/>, <https://www.marktechpost.com/2026/06/20/nous-research-updates-hermes-agent-with-a-blank-slate-mode-that-pins-toolsets-via-platform_toolsets-cli-and-disabled_toolsets/>
- Hermes 4 models: <https://venturebeat.com/technology/nous-research-drops-hermes-4-ai-models-that-outperform-chatgpt-without-content-restrictions>, <https://nousresearch.com/releases>
