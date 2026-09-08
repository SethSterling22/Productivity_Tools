// The agent loop: user message -> model -> (tool calls -> results -> loop) -> final.
// Supports multiple tool calls per turn and clarifying questions (the model may
// answer with plain text asking for a missing detail instead of calling a tool).

import { config } from "./config.js";
import { runModel } from "./llm.js";
import { llmTools, dispatch } from "./tools.js";
import * as memory from "./memory.js";

export async function runAgent({ sessionId, channel, userMessage, onEvent }) {
  const emit = onEvent || (() => {});
  const ch = channel || "api";

  await memory.ensureSession(sessionId, ch);
  await memory.append({ sessionId, role: "user", content: userMessage });

  // Prior context (already includes the user message we just stored), as
  // simple role/content turns; the loop appends tool_use/tool_result blocks.
  const context = await memory.getContext(sessionId);
  const messages = context.map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: userMessage });
  }

  const tools = llmTools(ch);
  let finalText = "";

  for (let step = 0; step < config.maxAgentSteps; step++) {
    const { text, toolCalls } = await runModel({
      system: config.systemPrompt,
      messages,
      tools,
    });

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
