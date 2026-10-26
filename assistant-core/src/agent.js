// The agent loop: user message -> model -> (tool calls -> results -> loop) -> final.
// Supports multiple tool calls per turn and clarifying questions (the model may
// answer with plain text asking for a missing detail instead of calling a tool).

import { config } from "./config.js";
import { runModel } from "./llm.js";
import { routeFor, overrideChain } from "./router.js";
import { llmTools, dispatch, listTools } from "./tools.js";
import * as memory from "./memory.js";

// ── Deterministic slash commands ────────────────────────────────────────────
// "/tool arg1 rest of the args" is dispatched straight to the tool, with NO model
// involved. Without this the LLM re-interprets the command (and the conversation
// history) and may run something else entirely.
//
// Argument mapping uses the tool's own input_schema: required properties are
// filled in order and the LAST one absorbs the remaining text, so
// "/run_on_node ocra docker ps -a" -> { node: "ocra", command: "docker ps -a" }.
function parseSlashCommand(message) {
  const m = /^\/([A-Za-z_][\w]*)\s*([\s\S]*)$/.exec(String(message || "").trim());
  if (!m) return null;
  const tool = listTools().find((t) => t.name === m[1]);
  if (!tool) return null;

  const rest = (m[2] || "").trim();
  const props = (tool.input_schema && tool.input_schema.properties) || {};
  const required = (tool.input_schema && tool.input_schema.required) || [];
  // No required fields -> optionally fill the first declared property.
  const keys = required.length ? required : Object.keys(props).slice(0, 1);

  const input = {};
  if (keys.length && rest) {
    if (keys.length === 1) {
      input[keys[0]] = rest;
    } else {
      const parts = rest.split(/\s+/);
      for (let i = 0; i < keys.length - 1; i++) input[keys[i]] = parts.shift() || "";
      input[keys[keys.length - 1]] = parts.join(" ");
    }
  }
  for (const k of Object.keys(input)) {
    if (props[k] && props[k].type === "integer") {
      const n = parseInt(input[k], 10);
      if (!Number.isNaN(n)) input[k] = n;
    }
  }
  const missing = required.filter((r) => !input[r]);
  return { tool, input, missing };
}

// Render a tool result as readable markdown for the chat.
function formatToolResult(name, res) {
  if (!res || typeof res !== "object") return "```\n" + String(res) + "\n```";
  if (res.ok === false) return `⚠ **${name}**: ${res.error || "failed"}`;
  // Shell output (run_on_node)
  if (res.stdout !== undefined || res.stderr !== undefined) {
    const out = (res.stdout || "").trimEnd();
    const err = (res.stderr || "").trimEnd();
    let s = `**${res.node || name}** · \`${res.command || ""}\`${res.code ? ` (exit ${res.code})` : ""}\n`;
    s += "```\n" + (out || "(sin salida)") + "\n```";
    if (err) s += "\n_stderr:_\n```\n" + err + "\n```";
    return s;
  }
  if (res.result) return `✅ ${res.result}`;
  const json = JSON.stringify(res, null, 2);
  return "```json\n" + (json.length > 3000 ? json.slice(0, 3000) + "\n…" : json) + "\n```";
}

export async function runAgent({ sessionId, channel, userMessage, onEvent, model }) {
  const emit = onEvent || (() => {});
  const ch = channel || "api";

  await memory.ensureSession(sessionId, ch);
  await memory.append({ sessionId, role: "user", content: userMessage });
  // Default conversation name = first user message (only if not named yet).
  await memory.setTitleIfEmpty(sessionId, userMessage.slice(0, 60));

  // Explicit "/tool args" -> run exactly that tool, no model, no history bleed.
  const cmd = parseSlashCommand(userMessage);
  if (cmd) {
    emit({ type: "route", category: "command" });
    emit({ type: "model", provider: "direct", model: "sin IA" });
    let text;
    if (cmd.missing.length) {
      const sig = (cmd.tool.input_schema.required || []).join(", ");
      text = `⚠ \`/${cmd.tool.name}\` necesita: **${cmd.missing.join(", ")}**\n\nUso: \`/${cmd.tool.name} ${sig}\``;
    } else {
      emit({ type: "tool_call", name: cmd.tool.name, input: cmd.input });
      const result = await dispatch(cmd.tool.name, cmd.input);
      emit({ type: "tool_result", name: cmd.tool.name, result });
      await memory.append({ sessionId, role: "tool", toolName: cmd.tool.name, toolResult: result });
      text = formatToolResult(cmd.tool.name, result);
    }
    await memory.append({ sessionId, role: "assistant", content: text });
    emit({ type: "text", text });
    emit({ type: "done", text });
    return text;
  }

  // Prior context (already includes the user message we just stored), as
  // simple role/content turns; the loop appends tool_use/tool_result blocks.
  const context = await memory.getContext(sessionId);
  const messages = context.map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: userMessage });
  }

  const tools = llmTools(ch);
  let finalText = "";

  // Model selection. A manual override (from the dashboard dropdown) forces one
  // model with no fallback (so you can test that exact model). Otherwise the
  // task-specialized router classifies the turn and builds a failover chain.
  let chain;
  const forced = overrideChain(model);
  if (forced) {
    chain = forced;
    emit({ type: "route", category: "manual" });
  } else if (config.modelRouting) {
    const route = routeFor(userMessage);
    chain = route.chain;
    emit({ type: "route", category: route.category });
  }
  let announced = false;

  // Give the model the current date/time (LLMs don't know it) so it resolves
  // "today"/"tomorrow" correctly and emits ISO 8601 with the right date/offset.
  const nowStr = new Date().toLocaleString("es-PR", {
    timeZone: "America/Puerto_Rico",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const system =
    `${config.systemPrompt}\n\nFecha y hora actual: ${nowStr} (America/Puerto_Rico, UTC-04:00). ` +
    `Usa esto para resolver fechas relativas ("hoy", "mañana", "el viernes") y genera timestamps ISO 8601 con offset -04:00.`;

  for (let step = 0; step < config.maxAgentSteps; step++) {
    const { text, toolCalls, provider, model, host } = await runModel({
      system,
      messages,
      tools,
      chain,
    });

    // Announce which model actually answered (transparency for the dashboard).
    if (!announced) {
      announced = true;
      emit({ type: "model", provider, model, host });
    }

    if (toolCalls && toolCalls.length) {
      // Record the assistant turn (optional text + tool_use blocks).
      const asstContent = [];
      if (text) asstContent.push({ type: "text", text });
      for (const tc of toolCalls) {
        asstContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: "assistant", content: asstContent });
      await memory.append({ sessionId, role: "assistant", content: text || null, toolCalls });
      if (text) emit({ type: "text", text });

      // Execute each tool and feed results back to the model.
      const resultBlocks = [];
      for (const tc of toolCalls) {
        emit({ type: "tool_call", name: tc.name, input: tc.input });
        const result = await dispatch(tc.name, tc.input);
        emit({ type: "tool_result", name: tc.name, result });
        await memory.append({ sessionId, role: "tool", toolName: tc.name, toolResult: result });
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: resultBlocks });
      continue; // loop so the model can use the tool results
    }

    // No tool calls -> this is the final answer (or a clarifying question).
    finalText = text || "";
    messages.push({ role: "assistant", content: finalText });
    await memory.append({ sessionId, role: "assistant", content: finalText });
    emit({ type: "text", text: finalText });
    break;
  }

  emit({ type: "done", text: finalText });
  return finalText;
}
