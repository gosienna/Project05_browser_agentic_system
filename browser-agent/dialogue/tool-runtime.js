// Built-in Dialogue tools executed in the background (Tavily web search, etc.).

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** Prepended to the Dialogue system prompt when MCP tools are available (helps local ONNX models). */
export const MCP_TOOL_HINT =
  "You have MCP tools available in this chat. " +
  "When you need current information or browser actions, call the appropriate tool. " +
  "For local ONNX models, use: call:<tool_name>{arg:value,...} — e.g. call:web_search{query:today's date} or call:read_page{}.";

/**
 * Tavily Search API — basic depth (1 credit per request).
 * @see https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
export async function tavilySearch({ query, max_results = 5 } = {}, settings = {}) {
  const apiKey = settings.tavilyApiKey;
  if (!apiKey) {
    throw new Error("Tavily API key not set — open Settings and add your Tavily API key.");
  }

  const q = String(query || "").trim();
  if (!q) throw new Error("web_search requires a non-empty query.");

  const res = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query: q,
      search_depth: "basic",
      max_results: Math.min(10, Math.max(1, Number(max_results) || 5)),
      include_answer: false,
    }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Tavily returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const msg = body?.error || body?.detail || body?.message || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return {
    query: body.query || q,
    results: (body.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      score: typeof r.score === "number" ? r.score : null,
    })),
  };
}
/** Parse `key:value` or JSON-ish argument strings from small-model tool text. */
export function parseLooseToolArgs(inner) {
  const trimmed = String(inner || "").trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      try {
        const fixed = trimmed.replace(/([{,]\s*)([a-zA-Z_][\w]*)\s*:/g, '$1"$2":');
        return JSON.parse(fixed);
      } catch {
        /* fall through */
      }
    }
  }

  const args = {};
  const pairRe = /([a-zA-Z_][\w]*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)/g;
  let m;
  while ((m = pairRe.exec(trimmed)) !== null) {
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (m[1] === "max_results") args[m[1]] = Number(val) || 5;
    else if (m[1] === "maxChars") {
      const n = Number(val);
      args[m[1]] = Number.isFinite(n) && n > 0 ? n : undefined;
    } else args[m[1]] = val;
  }
  if (Object.keys(args).length) return args;

  return { query: trimmed };
}

/**
 * Parse tool calls embedded in assistant text (common with local ONNX models).
 * e.g. `call:web_search{query:weather in Sydney}`
 */
export function parseTextToolCalls(text, toolNames = []) {
  const calls = [];
  if (!text || typeof text !== "string") return calls;

  const allowed = new Set(toolNames.filter(Boolean));
  const re = /call:\s*([a-zA-Z0-9_-]+)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (allowed.size && !allowed.has(name)) continue;
    calls.push({
      id: `textcall_${calls.length}_${Date.now()}`,
      name,
      args: parseLooseToolArgs(m[2]),
      raw: m[0],
      source: "text",
    });
  }

  if (!calls.length && allowed.size) {
    const simple = /^\s*([a-zA-Z0-9_-]+)\s*\{([\s\S]+)\}\s*$/.exec(text.trim());
    if (simple && allowed.has(simple[1])) {
      calls.push({
        id: `textcall_0_${Date.now()}`,
        name: simple[1],
        args: parseLooseToolArgs(simple[2]),
        raw: text.trim(),
        source: "text",
      });
    }
  }

  return calls;
}

function parseNativeToolCall(tc) {
  let args = {};
  try {
    args = JSON.parse(tc.function?.arguments || "{}");
  } catch {
    args = {};
  }
  return {
    id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
    name: tc.function?.name,
    args,
    raw: null,
    source: "native",
  };
}

/** OpenAI tool_calls plus text-embedded calls from models without native tool support. */
export function normalizeAssistantToolCalls(message, tools = []) {
  const native = (message?.tool_calls || [])
    .map(parseNativeToolCall)
    .filter((c) => c.name);

  if (native.length) return native;

  const names = tools.map((t) => t.function?.name).filter(Boolean);
  return parseTextToolCalls(message?.content || "", names);
}

export function toOpenAiToolCall(call) {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args || {}),
    },
  };
}

/** Human-readable assistant output when the model requests tool(s). */
export function formatAssistantToolCallDisplay(message, calls = []) {
  const text = String(message?.content || "").trim();
  if (text) return text;

  const lines = [];
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    for (const tc of message.tool_calls) {
      const name = tc.function?.name || "unknown";
      const args = tc.function?.arguments || "{}";
      lines.push(`call:${name}${args.startsWith("{") ? args : `{${args}}`}`);
    }
  }

  for (const c of calls) {
    if (c.raw) lines.push(c.raw);
    else lines.push(`call:${c.name}${JSON.stringify(c.args || {})}`);
  }

  return [...new Set(lines)].join("\n") || "(tool call)";
}
