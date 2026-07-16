# Browser Agent Architecture (`agent.js`)

## Overview

`agent.js` implements the core **agentic loop** for a browser automation agent. It runs a multi-turn conversation between an LLM and a set of browser control tools, allowing the LLM to iteratively decide which tools to call and process their results until it completes the user's task.

---

## Custom agent systems

The Agent tab is a multi-system workspace. Each **agent system** is stored in IndexedDB (`agent-systems`) via [`system-store.js`](../browser-agent/system-store.js) with components:

| Kind | Role |
|------|------|
| `agent` | System prompt / policy text |
| `tools` | JS that assigns `self.__agentTools = { … }` |
| `html` / `css` / `ui` | Home page markup, styles, and script |

**Built-ins (seeded once):**

- **Browser Agent** — classic tab automation; Run automation uses `runAgent()` + [`tools.js`](../browser-agent/tools.js).
- **Curve Plotter** — demo home UI (cartesian plot of `y = x^2`) meant to be edited via the LLM.

**Create:** `+` in the Agent tab → empty home stub + starter components.

**Home runtime:** [`system-host.html`](../browser-agent/system-host.html) embeds sandboxed [`sandbox.html`](../browser-agent/sandbox.html) (relaxed CSP) so LLM/user JS can run. The host loads components from IndexedDB and `postMessage`s them into the sandbox.

**Tab access from sandbox:** the sandbox cannot call `chrome.*`. It uses an injected `api` (`listTabs`, `getActiveTab`, `executeInTab`, `readPage`, `click`, `typeText`, `scroll`, `navigate`, `captureTab`) bridged through the host → [`tab-bridge.js`](../browser-agent/tab-bridge.js) in the service worker. Any open tab (active or not) can be targeted by `tabId`.

**Edit components (LLM):** [`system-editor-l2.js`](../browser-agent/system-editor-l2.js) is a ReAct loop over `list_components` / `read_component` / `write_component` / `reload_home`, wired on port `system-editor` from the side panel (a restricted single-script variant lives in [`system-editor-l1.js`](../browser-agent/system-editor-l1.js)). Same `chat()` providers as the browser agent (ONNX / Ollama / API).

```
Side panel Agent tab
  ├─ system select / + / home iframe (system-host → sandbox)
  ├─ Edit components → port "system-editor" → system-editor-l2.js / -l1.js → system-store
  └─ Run automation (Browser Agent only) → port "agent" → agent.js → tools.js
```

---

## Key Components

### 1. System Prompt (Lines 5-23)

Defines the agent's role, available tools, and expected response format:

```
You are a browser automation agent. You control the user's browser tab-by-tab to complete their task.
```

**Available Tools:**
- `read_page()` — Get visible text from current tab
- `get_links()` — Get all links on current page
- `list_tabs()` — Get open tabs
- `open_tab({url})` — Open new tab
- `navigate({tabId, url})` — Navigate tab to URL
- `click({tabId, selector})` — Click element by CSS selector or visible text
- `type_text({tabId, selector, text})` — Type text into input
- `scroll({tabId, direction})` — Scroll "up" or "down"
- `fetch_url({url})` — Fetch URL text without opening tab
- `wait({ms})` — Pause execution
- `describe_image({tabId?, imageUrl?, dataUrl?})` — Local image captioning (ONNX)
- `classify_image({tabId?, imageUrl?, dataUrl?, topK?})` — Local image classification (ONNX)
- `transcribe_audio({audioUrl?, dataUrl?})` — Local Whisper ASR (ONNX)

**Response Format:**
The LLM must reply with exactly one JSON object:
- **To use a tool:** `{"thought": "...", "tool": "<name>", "args": {...}}`
- **To finish:** `{"thought": "...", "final": "<answer>"}`

No markdown fences or extra text allowed.

---

### 2. Configuration Constants (Lines 3, 26-28)

```javascript
const MAX_STEPS = 14;                              // Max iterations before timeout
const DEFAULT_READ_PAGE_CHARS = 14000;            // Truncate read_page results
const DEFAULT_FETCH_URL_CHARS = 12000;            // Truncate fetch_url results
const TOOL_RESULT_CHARS_IN_TRANSCRIPT = 8000;     // Keep conversation manageable
```

These prevent token explosion when tools return large text (e.g., scraping a large webpage).

---

### 3. Main Loop: `runAgent()` (Lines 30-74)

The core function that orchestrates the agentic loop.

**Signature:**
```javascript
export async function runAgent({ task, settings, tools, tabId, onEvent })
```

**Parameters:**
- `task` — User's goal (e.g., "search Google for 'AI'")
- `settings` — LLM provider config (ONNX/OpenAI/Ollama/Anthropic)
- `tools` — Object containing browser tool functions
- `tabId` — ID of the active browser tab
- `onEvent` — Callback to report progress (`thinking`, `tool_start`, `tool_end`, `final`)

**Flow:**

```
1. Initialize messages with system prompt + user task
   └─ messages = [
       { role: "system", content: SYSTEM_PROMPT },
       { role: "user", content: "Task: {task}\nActive tab id: {tabId}" }
      ]

2. Loop up to MAX_STEPS (14) times:
   
   a. Call LLM with full conversation history
      reply = await chat(messages, settings)
   
   b. Extract JSON from LLM response
      parsed = extractJson(reply)
   
   c. If no valid JSON → treat as final answer and exit
   
   d. Add assistant's message to history
      messages.push({ role: "assistant", content: reply })
   
   e. If LLM included "final" field → return it and exit
   
   f. Validate LLM named a tool (otherwise ask for JSON)
   
   g. Execute the tool
      result = await runTool(tools, parsed.tool, parsed.args)
   
   h. Append tool result to history
      messages.push({ role: "user", content: `Tool result:\n${result}` })
   
   i. Loop back to step 2a with updated context

3. If MAX_STEPS exceeded → return fallback message
   └─ "I reached the step limit before finishing..."
```

---

### 4. Tool Execution: `runTool()` (Lines 76-83)

Safely calls a tool function with arguments.

```javascript
async function runTool(tools, name, args, ctx)
```

**Behavior:**
1. Look up tool by name in `tools` object
2. Merge `args` with context (`tabId`)
3. Apply default `maxChars` limits if not specified
4. Call the tool function
5. Return result (or throw error, caught by loop)

**Example:**
```javascript
// LLM chooses: {"tool": "read_page", "args": {}}
// Becomes: tools.read_page({ tabId: "tab-123", maxChars: 14000 })
```

---

### 5. JSON Extraction: `extractJson()` (Lines 85-98)

Robustly parses JSON from LLM response, handling:
- Markdown code fences (`` ```json ... ``` ``)
- Extra text around JSON
- Malformed JSON (returns `null`)

**Logic:**
1. Check for markdown fences first
2. If no fences, use the raw text
3. Find first `{` and last `}`
4. Attempt JSON.parse()
5. Return parsed object or `null`

---

## State Management

The agent maintains a **conversation history** (`messages` array) that grows with each iteration:

```
Initial:
[
  { role: "system", content: "You are a browser automation agent..." },
  { role: "user", content: "Task: search Google\nActive tab id: 1" }
]

After step 1 (LLM thinks → calls search):
[
  ...,
  { role: "assistant", content: "{\"thought\": \"...\", \"tool\": \"navigate\", ...}" },
  { role: "user", content: "Tool result:\n<page text>" }
]

After step 2 (LLM thinks → types query):
[
  ...,
  { role: "assistant", content: "{\"thought\": \"...\", \"tool\": \"type_text\", ...}" },
  { role: "user", content: "Tool result:\n{\"typed\": true}" }
]

// ... continues until "final" or MAX_STEPS
```

Each step adds 2 messages (assistant's action + tool result), so context grows linearly. Truncation constants keep results bounded.

---

## Error Handling

**LLM response parsing fails:**
- If `extractJson()` returns `null` → treat entire response as final answer

**Tool execution errors:**
```javascript
try {
  result = await runTool(...)
} catch (err) {
  result = `Error: ${err.message}`
  // Append error to messages and loop continues
}
```

The agent learns from errors and can self-correct.

**Max steps exceeded:**
- Loop exits after 14 iterations
- Returns fallback: *"I reached the step limit before finishing..."*
- Prevents infinite loops or runaway token consumption

---

## Event Callbacks

The `onEvent` callback keeps the UI/terminal updated:

| Event Type | Data | Fired When |
|-----------|------|-----------|
| `thinking` | `{ content: "thought text" }` | LLM provides a thought |
| `tool_start` | `{ tool: name, args: {...} }` | About to execute tool |
| `tool_end` | `{ tool: name, result: "..." }` | Tool completed |
| `final` | `{ content: "answer" }` | Task complete or error |

Used by `sidepanel.js` to display agent progress in real-time.

---

## Performance & Limitations

| Aspect | Value | Notes |
|--------|-------|-------|
| Max iterations | 14 | Prevents runaway loops |
| read_page truncation | 14,000 chars | Large pages get condensed |
| fetch_url truncation | 12,000 chars | URL content limited |
| Transcript truncation | 8,000 chars | Individual results capped in history |
| Model dependency | Any via `chat()` | ONNX/OpenAI/Ollama/Anthropic supported |

**Gotcha:** Truncation happens *per-result*, so a 14,000-char page is added to history as 8,000 chars, then next tool result gets another 8,000, etc. Full history can still grow large over 14 steps.

---

## Integration with Other Modules

```
┌─ agent.js ──────────────┐
│ Exports: runAgent()      │
└────────┬────────────────┘
         │ calls
         ├─→ llm.js::chat() (get LLM response)
         ├─→ tools (run browser actions)
         └─→ onEvent (report progress)
```

**Called by:** `background.js` (agent port listener) → invokes `runAgent()` when user submits a task from side panel.

---

## Example: "Search Google"

**User input:** `"Search Google for Claude AI"`

**Step 1:**
```
LLM response: {"thought": "Need to open Google first", "tool": "open_tab", "args": {"url": "https://google.com"}}
Tool result: {"tabId": "tab-456"}
```

**Step 2:**
```
LLM response: {"thought": "Page loaded, now find search box and type", "tool": "click", "args": {"tabId": "tab-456", "selector": "input[name='q']"}}
Tool result: {"clicked": true}
```

**Step 3:**
```
LLM response: {"thought": "Now type the query", "tool": "type_text", "args": {"tabId": "tab-456", "text": "Claude AI"}}
Tool result: {"typed": 9}
```

**Step 4:**
```
LLM response: {"thought": "Press Enter to search", "tool": "key_press", "args": {"tabId": "tab-456", "key": "Enter"}}
(Note: key_press not in tool list → error, loop continues)
```

**Step 5:**
```
LLM response: {"final": "I successfully navigated to Google and typed 'Claude AI' in the search box. The search would be submitted by pressing Enter."}
```

Agent stops and returns the final message.

---

## Summary

`agent.js` is the **orchestrator** of an autonomous browser agent. It:
1. Maintains a rolling conversation with an LLM
2. Parses the LLM's JSON commands (tool name + arguments)
3. Executes requested tools against the browser
4. Feeds results back to the LLM for the next iteration
5. Stops when the LLM declares the task finished or after 14 steps

The design is **model-agnostic** (works with any `chat()` provider), **error-resilient** (truncates large results, catches tool errors), and **observable** (reports every step via `onEvent`).
