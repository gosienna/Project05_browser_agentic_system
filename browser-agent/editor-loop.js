// Shared ReAct loop for the system editors (level 1 and level 2). Each level
// supplies its own system prompt and tool map; the loop mechanics are identical.

import { chat } from "./llm.js";
import { extractJson } from "./agent.js";

const MAX_STEPS = 14;
const TOOL_RESULT_CHARS = 8000;

export async function runEditorLoop({ systemPrompt, userIntro, tools, settings, onEvent, onComplete }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userIntro },
  ];

  const finish = async (final) => {
    if (typeof onComplete === "function") {
      try {
        await onComplete({ messages, final });
      } catch (err) {
        console.error("[editor-loop] onComplete failed", err);
      }
    }
    return final;
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chat(messages, settings);
    const parsed = extractJson(reply);

    if (!parsed) {
      messages.push({ role: "assistant", content: reply });
      onEvent({ type: "final", content: reply });
      return finish(reply);
    }

    messages.push({ role: "assistant", content: reply });

    if (parsed.final !== undefined) {
      onEvent({ type: "final", content: parsed.final });
      return finish(parsed.final);
    }

    if (!parsed.tool) {
      messages.push({
        role: "user",
        content: 'Missing "tool" or "final". Reply with a single valid JSON object.',
      });
      continue;
    }

    onEvent({ type: "thinking", content: parsed.thought || "" });
    onEvent({ type: "tool_start", tool: parsed.tool, args: parsed.args || {} });

    let result;
    try {
      const fn = tools[parsed.tool];
      if (typeof fn !== "function") throw new Error(`Unknown editor tool "${parsed.tool}"`);
      result = await fn(parsed.args || {});
    } catch (err) {
      result = `Error: ${err?.message || String(err)}`;
    }

    onEvent({ type: "tool_end", tool: parsed.tool, result });
    messages.push({
      role: "user",
      content: `Tool result:\n${truncate(stringify(result), TOOL_RESULT_CHARS)}`,
    });
  }

  const fallback = "I reached the step limit before finishing the system edits.";
  onEvent({ type: "final", content: fallback });
  return finish(fallback);
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "\n...[truncated]" : str;
}
