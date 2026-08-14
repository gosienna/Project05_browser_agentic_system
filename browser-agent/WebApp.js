import { chat } from "./llm.js";
import { getMaxSteps } from "./agent-config.js";

const SYSTEM_PROMPT = `You are a browser automation agent. You control the user's browser tab-by-tab to complete their task.

Tools:
- browser_snapshot({tabId, target?, depth?, boxes?, maxChars?}): accessibility YAML snapshot with refs like [ref=e5]. Prefer this to understand the page.
- browser_click({tabId, target, element?, doubleClick?, button?, modifiers?}): click by ref from browser_snapshot or CSS selector. Call browser_snapshot again after navigation or DOM changes.
- read_page(): returns the visible text of the current tab.
- get_links(): returns [{text, href}] for links on the current tab.
- list_tabs(): returns open tabs [{id, title, url}].
- open_tab({url}): opens a new tab, returns its id.
- navigate({tabId, url}): navigates a tab to url.
- click({tabId, selector}): clicks the first element matching a CSS selector or visible text.
- type_text({tabId, selector, text}): types text into an input/textarea matching selector.
- scroll({tabId, direction}): scrolls the tab "up" or "down" by one screen.
- get_page_html({tabId, selector?, maxChars?}): returns raw HTML from the live tab (full document or one element).
- modify_element({tabId, selector, styles?, text?, innerHTML?, all?}): change styles or content on matched element(s).
- execute_script({tabId, script, args?}): run a JS function in the tab; return value must be JSON-serializable.
- fetch_url({url}): fetches a URL's text content without opening a tab.
- download_file({url, filename?, saveAs?, timeoutMs?}): saves a file from a URL to Downloads (use for PDFs instead of click).
- wait({ms}): pauses for ms milliseconds.
- describe_image({tabId?, imageUrl?, dataUrl?}): locally captions an image (screenshot of tabId, or imageUrl/dataUrl). Returns {caption, model}.
- classify_image({tabId?, imageUrl?, dataUrl?, topK?}): locally classifies an image. Returns {labels:[{label,score}], model}.
- transcribe_audio({audioUrl?, dataUrl?}): locally transcribes English audio via Whisper. Returns {text, model}.

On every turn, reply with exactly ONE JSON object and nothing else:
- To use a tool: {"thought": "...", "tool": "<name>", "args": {...}}
- To finish: {"thought": "...", "final": "<answer for the user>"}

Do not wrap the JSON in markdown fences. Do not include any text outside the JSON object.`;

// Tool-result truncation defaults; overridable per-run (see agent hardening, Phase 2).
const DEFAULT_READ_PAGE_CHARS = 14000;
const DEFAULT_FETCH_URL_CHARS = 12000;
const DEFAULT_PAGE_HTML_CHARS = 14000;
const TOOL_RESULT_CHARS_IN_TRANSCRIPT = 8000;

export async function runAgent({ task, settings, tools, tabId, onEvent, onComplete }) {
  const maxSteps = getMaxSteps(settings);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Task: ${task}\nActive tab id: ${tabId ?? "unknown"}` },
  ];

  const finish = async (final) => {
    if (typeof onComplete === "function") {
      try {
        await onComplete({ messages, final });
      } catch (err) {
        console.error("[agent] onComplete failed", err);
      }
    }
    return final;
  };

  for (let step = 0; step < maxSteps; step++) {
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
      messages.push({ role: "user", content: 'Missing "tool" or "final". Reply with a single valid JSON object.' });
      continue;
    }

    onEvent({ type: "thinking", content: parsed.thought || "" });
    onEvent({ type: "tool_start", tool: parsed.tool, args: parsed.args || {} });

    let result;
    try {
      result = await runTool(tools, parsed.tool, parsed.args || {}, { tabId });
    } catch (err) {
      result = `Error: ${err?.message || String(err)}`;
    }

    onEvent({ type: "tool_end", tool: parsed.tool, result });
    messages.push({ role: "user", content: `Tool result:\n${truncate(stringify(result), TOOL_RESULT_CHARS_IN_TRANSCRIPT)}` });
  }

  const fallback = "I reached the step limit before finishing. Here is what I found so far.";
  onEvent({ type: "final", content: fallback });
  return finish(fallback);
}

async function runTool(tools, name, args, ctx) {
  const fn = tools[name];
  if (typeof fn !== "function") throw new Error(`Unknown tool "${name}"`);
  const effectiveArgs = { tabId: ctx.tabId, ...args };
  if (name === "read_page") {
    const n = Number(effectiveArgs.maxChars);
    if (!Number.isFinite(n) || n <= 0) effectiveArgs.maxChars = DEFAULT_READ_PAGE_CHARS;
  }
  if (name === "fetch_url") {
    const n = Number(effectiveArgs.maxChars);
    if (!Number.isFinite(n) || n <= 0) effectiveArgs.maxChars = DEFAULT_FETCH_URL_CHARS;
  }
  if (name === "get_page_html") {
    const n = Number(effectiveArgs.maxChars);
    if (!Number.isFinite(n) || n <= 0) effectiveArgs.maxChars = DEFAULT_PAGE_HTML_CHARS;
  }
  if (name === "browser_snapshot") {
    const n = Number(effectiveArgs.maxChars);
    if (!Number.isFinite(n) || n <= 0) effectiveArgs.maxChars = DEFAULT_READ_PAGE_CHARS;
  }
  return fn(effectiveArgs);
}

export function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "\n...[truncated]" : str;
}
