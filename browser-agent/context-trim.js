// Rough token budgeting for local models with small context windows (WebLLM).

const CHARS_PER_TOKEN = 3;
const MESSAGE_OVERHEAD_CHARS = 32;
const TOOLS_OVERHEAD_CHARS = 192;

function messageContentChars(msg) {
  if (!msg) return 0;
  const c = msg.content;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) {
    return c.reduce((n, part) => {
      if (part?.type === "text") return n + (part.text?.length ?? 0);
      if (part?.type === "image_url") return n + 512;
      return n + 64;
    }, 0);
  }
  return 0;
}

/** Char-length heuristic → approximate token count (no tokenizer). */
export function estimateChatTokens(messages, tools) {
  let chars = TOOLS_OVERHEAD_CHARS;
  if (Array.isArray(tools) && tools.length) {
    try {
      chars += JSON.stringify(tools).length;
    } catch {
      chars += tools.length * 400;
    }
  }
  for (const msg of messages || []) {
    chars += MESSAGE_OVERHEAD_CHARS + messageContentChars(msg);
    if (Array.isArray(msg.tool_calls)) {
      try {
        chars += JSON.stringify(msg.tool_calls).length;
      } catch {
        chars += msg.tool_calls.length * 120;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function trimText(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  if (maxChars < 80) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 40)}\n\n…[trimmed to fit context window]`;
}

function trimMessageContent(msg, maxChars) {
  if (!msg || maxChars <= 0) return msg;
  const c = msg.content;
  if (typeof c === "string") {
    if (c.length <= maxChars) return msg;
    return { ...msg, content: trimText(c, maxChars) };
  }
  if (!Array.isArray(c)) return msg;
  let budget = maxChars;
  const next = [];
  for (const part of c) {
    if (part?.type === "text" && typeof part.text === "string") {
      if (part.text.length <= budget) {
        next.push(part);
        budget -= part.text.length;
      } else if (budget > 80) {
        next.push({ ...part, text: trimText(part.text, budget) });
        budget = 0;
      }
      continue;
    }
    if (budget > 0) {
      next.push(part);
      budget -= 512;
    }
  }
  return next.length ? { ...msg, content: next } : { ...msg, content: trimText("(content removed)", 80) };
}

/**
 * Drop oldest non-system turns (and shrink oversized messages) until the
 * estimated prompt fits `contextLimit - maxOutputTokens`.
 *
 * @returns {{ messages: object[], trimmed: boolean, droppedTurns: number, estimatedTokens: number, budget: number }}
 */
export function trimChatMessagesForContext(messages, tools, contextLimit, maxOutputTokens = 1024) {
  const budget = Math.max(256, contextLimit - maxOutputTokens - 256);
  const system = (messages || []).filter((m) => m.role === "system");
  let rest = (messages || []).filter((m) => m.role !== "system");
  let droppedTurns = 0;

  const fit = () => estimateChatTokens([...system, ...rest], tools) <= budget;

  while (rest.length > 1 && !fit()) {
    rest.shift();
    droppedTurns += 1;
  }

  let trimmed = droppedTurns > 0;
  let estimated = estimateChatTokens([...system, ...rest], tools);

  if (!fit() && rest.length === 1) {
    const maxChars = Math.floor(budget * CHARS_PER_TOKEN * 0.85);
    rest = [trimMessageContent(rest[0], maxChars)];
    trimmed = true;
    estimated = estimateChatTokens([...system, ...rest], tools);
  }

  if (!fit() && system.length) {
    const sysBudget = Math.floor(budget * CHARS_PER_TOKEN * 0.4);
    const trimmedSystem = system.map((m, i) =>
      i === system.length - 1 ? trimMessageContent(m, sysBudget) : m
    );
    const merged = [...trimmedSystem, ...rest];
    estimated = estimateChatTokens(merged, tools);
    return {
      messages: merged,
      trimmed: true,
      droppedTurns,
      estimatedTokens: estimated,
      budget,
    };
  }

  return {
    messages: [...system, ...rest],
    trimmed,
    droppedTurns,
    estimatedTokens: estimated,
    budget,
  };
}
