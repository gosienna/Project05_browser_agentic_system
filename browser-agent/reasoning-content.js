/**
 * Normalize model reasoning/thinking across providers (Ollama, WebLLM, ONNX).
 * Qwen3 / WebLLM may embed <think>…</think> or …
 * in content; Ollama returns separate message.thinking / message.reasoning fields.
 */

const THINK_OPEN = "<" + "think" + ">";
const THINK_CLOSE = "</" + "think" + ">";

/** Default on — only disabled when settings.enableThinking === false. */
export function isThinkingEnabled(settings) {
  return settings?.enableThinking !== false;
}

export function stripReasoningFromAssistantContent(text) {
  if (typeof text !== "string" || !text) return text;

  let out = text;

  out = out.replace(/<think>[\s\S]*?<\/redacted_thinking>\s*/gi, "");

  const closeIdx = out.lastIndexOf(THINK_CLOSE);
  if (closeIdx !== -1) {
    out = out.slice(closeIdx + THINK_CLOSE.length);
  } else {
    const openRe = new RegExp(`^\\s*${THINK_OPEN}[\\s\\S]*$`, "i");
    out = out.replace(openRe, "");
  }

  const blockRe = new RegExp(`${THINK_OPEN}[\\s\\S]*?${THINK_CLOSE}\\s*`, "gi");
  out = out.replace(blockRe, "");

  return out.trim();
}

/** Pull embedded thinking blocks out of a single content string. */
export function extractEmbeddedReasoning(text) {
  if (typeof text !== "string" || !text) return { content: "", reasoning: "" };

  const reasoningParts = [];
  let content = text;

  content = content.replace(/<think>([\s\S]*?)<\/redacted_thinking>\s*/gi, (_, inner) => {
    if (inner?.trim()) reasoningParts.push(inner.trim());
    return "";
  });

  const blockRe = new RegExp(`${THINK_OPEN}([\\s\\S]*?)${THINK_CLOSE}\\s*`, "gi");
  content = content.replace(blockRe, (_, inner) => {
    if (inner?.trim()) reasoningParts.push(inner.trim());
    return "";
  });

  const openOnlyRe = new RegExp(`^\\s*${THINK_OPEN}([\\s\\S]*)$`, "i");
  const openOnly = content.match(openOnlyRe);
  if (openOnly) {
    if (openOnly[1]?.trim()) reasoningParts.push(openOnly[1].trim());
    content = "";
  }

  return { content: content.trim(), reasoning: reasoningParts.join("\n\n").trim() };
}

/** WebLLM model ids for Qwen3 hybrid thinking models. */
export function isQwen3ThinkingModel(modelId) {
  return typeof modelId === "string" && /^Qwen3/i.test(modelId);
}

/**
 * Split provider-specific assistant fields into { content, reasoning }.
 * @param {object} message
 * @param {{ thinkingEnabled?: boolean }} options
 */
export function normalizeAssistantMessage(message, { thinkingEnabled = true } = {}) {
  const base = message && typeof message === "object" ? { ...message } : { role: "assistant", content: "" };

  let content = typeof base.content === "string" ? base.content : "";
  let reasoning =
    (typeof base.reasoning === "string" ? base.reasoning.trim() : "") ||
    (typeof base.thinking === "string" ? base.thinking.trim() : "") ||
    (typeof base.reasoning_content === "string" ? base.reasoning_content.trim() : "");

  delete base.thinking;
  delete base.reasoning_content;

  const embedded = extractEmbeddedReasoning(content);
  content = embedded.content;
  if (embedded.reasoning) {
    reasoning = reasoning ? `${reasoning}\n\n${embedded.reasoning}` : embedded.reasoning;
  }

  if (!thinkingEnabled) {
    content = stripReasoningFromAssistantContent(content);
    reasoning = "";
  }

  base.content = content;
  if (reasoning) base.reasoning = reasoning;
  else delete base.reasoning;
  return base;
}

/** Normalize every choice in an OpenAI-shaped chat.completion. */
export function normalizeChatCompletion(response, { thinkingEnabled = true } = {}) {
  if (!response?.choices?.length) return response;
  return {
    ...response,
    choices: response.choices.map((choice) => {
      const rawMessage = choice?.message ?? {};
      return {
        ...choice,
        message: normalizeAssistantMessage(rawMessage, { thinkingEnabled }),
        rawMessage,
      };
    }),
  };
}
