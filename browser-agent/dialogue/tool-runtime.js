// Built-in Dialogue tools executed in the background (Tavily web search, etc.).

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** Prepended to the Dialogue system prompt when MCP tools are available (helps local ONNX models). */
export const MCP_TOOL_HINT =
  "You have MCP tools available in this chat. " +
  "When you need current information or browser actions, call the appropriate tool. " +
  "For local ONNX models, use: call:<tool_name>{arg:value,...} — e.g. call:web_search{query:today's date} or call:modify_element{selector:h1,styles:{fontSize:2.5rem,color:red}}.";

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
/** Extract content between balanced `{` `}` starting at openIdx. */
function extractBalancedBraces(text, openIdx) {
  if (text[openIdx] !== "{") return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return { inner: text.slice(openIdx + 1, i), end: i + 1 };
      }
    }
  }
  return null;
}

function quoteLooseJsonValues(jsonish) {
  return jsonish.replace(/:\s*([^",{[\s][^,}]*?)\s*([,}])/g, (match, val, tail) => {
    const v = val.trim();
    if (/^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(v)) return `:${v}${tail}`;
    return `:"${v.replace(/"/g, '\\"')}"${tail}`;
  });
}

function parseLooseObjectString(str) {
  const trimmed = String(str || "").trim();
  if (!trimmed) return null;
  const wrapped = trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
  try {
    const parsed = JSON.parse(wrapped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* try quote-fixing keys and bare values */
  }
  try {
    let fixed = wrapped.replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":');
    fixed = quoteLooseJsonValues(fixed);
    const parsed = JSON.parse(fixed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function readLooseValue(s, start) {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return { value: "", end: i };

  const q = s[i];
  if (q === '"' || q === "'") {
    i++;
    let val = "";
    while (i < s.length && s[i] !== q) {
      if (s[i] === "\\" && i + 1 < s.length) {
        val += s[i + 1];
        i += 2;
      } else {
        val += s[i];
        i++;
      }
    }
    if (s[i] === q) i++;
    return { value: val, end: i };
  }

  if (s[i] === "{") {
    const br = extractBalancedBraces(s, i);
    if (br) {
      const obj = parseLooseObjectString(`{${br.inner}}`);
      return { value: obj ?? `{${br.inner}}`, end: br.end };
    }
  }

  let j = i;
  while (j < s.length && s[j] !== ",") j++;
  return { value: s.slice(i, j).trim(), end: j };
}

function coerceToolArg(key, val) {
  if (key === "max_results") return Number(val) || 5;
  if (key === "maxChars") {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  if (key === "all") return val === true || val === "true";
  return val;
}

/** Parse `key:value` or JSON-ish argument strings from small-model tool text. */
export function parseLooseToolArgs(inner) {
  const trimmed = String(inner || "").trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    const parsed = parseLooseObjectString(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }

  const args = {};
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /[\s,]/.test(trimmed[i])) i++;
    if (i >= trimmed.length) break;
    const keyMatch = /^([a-zA-Z_][\w]*)\s*:/.exec(trimmed.slice(i));
    if (!keyMatch) break;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    const { value, end } = readLooseValue(trimmed, i);
    i = end;
    args[key] = coerceToolArg(key, value);
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
  const re = /call:\s*([a-zA-Z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (allowed.size && !allowed.has(name)) continue;
    const openIdx = m.index + m[0].length - 1;
    const br = extractBalancedBraces(text, openIdx);
    if (!br) continue;
    calls.push({
      id: `textcall_${calls.length}_${Date.now()}`,
      name,
      args: parseLooseToolArgs(br.inner),
      raw: text.slice(m.index, br.end),
      source: "text",
    });
    re.lastIndex = br.end;
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
