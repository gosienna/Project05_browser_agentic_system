# Browser Agent Tools (`tools.js`)

Browser-side tools invoked by the agent loop (`agent.js`). Each tool takes a single args object and returns a plain string/object result that gets fed back into the chat transcript.

---

## Tool Reference

### `read_page({ tabId, maxChars = 14000 })`
Returns the visible text of the current tab.
- Runs `document.body.innerText` via `chrome.scripting.executeScript`
- Truncates result to `maxChars` (default 14,000)

### `get_links({ tabId })`
Returns links on the current page.
- Queries all `a[href]` elements (capped at first 200)
- Returns `[{ text, href }]`, with link text truncated to 120 chars

### `list_tabs()`
Returns all open browser tabs.
- Uses `chrome.tabs.query({})`
- Returns `[{ id, title, url, active }]`

### `open_tab({ url })`
Opens a new tab at the given URL.
- Uses `chrome.tabs.create({ url })`
- Returns `{ id, url }` of the new tab

### `navigate({ tabId, url })`
Navigates an existing tab to a URL.
- Uses `chrome.tabs.update(tabId, { url })`
- Returns `{ ok: true }`

### `click({ tabId, selector })`
Clicks an element on the page.
- Tries `document.querySelector(selector)` first
- Falls back to matching visible text against clickable elements (`a`, `button`, `[role='button']`, `input[type=submit]`)
- Scrolls element into view before clicking
- Returns `{ ok: true }` or `{ ok: false, error }` if no match found

### `type_text({ tabId, selector, text })`
Types text into an input/textarea.
- Finds element via `document.querySelector(selector)`
- Focuses it, sets `.value`, dispatches `input` and `change` events (so frameworks like React detect the change)
- Returns `{ ok: true }` or `{ ok: false, error }` if no match found

### `scroll({ tabId, direction = "down" })`
Scrolls the page up or down.
- Scrolls by 90% of viewport height (`window.innerHeight * 0.9`)
- Returns `{ ok: true, scrollY }`

### `get_page_html({ tabId, selector?, maxChars = 14000 })`
Returns raw HTML from the live tab (after JS rendering).
- Without `selector`: `document.documentElement.outerHTML`
- With `selector`: `document.querySelector(selector).outerHTML` (preferred on large pages)
- Returns `{ ok: true, html, url }` or `{ ok: false, error }` if selector misses
- Truncates to `maxChars` (default 14,000); adds `truncated`, `totalChars`, `shownChars` when cut
- Dialogue further caps HTML in the LLM transcript (~6k) to avoid local ONNX/WebGPU OOM on the next turn
- Changes are in-memory only — reload reverts the page

### `modify_element({ tabId, selector, styles?, text?, innerHTML?, all? })`
Structured DOM manipulation on a tab.
- `styles`: camelCase CSS object applied via `Object.assign(el.style, styles)`
- `text`: sets `textContent`
- `innerHTML`: sets `innerHTML`
- `all`: if `true`, applies to all `querySelectorAll` matches (capped at 100)
- Requires at least one of `styles`, `text`, or `innerHTML`
- Returns `{ ok: true, matched, updated }` or `{ ok: false, error }`

**Examples:**
- Enlarge title: `{ selector: "h1", styles: { fontSize: "2.5rem" } }`
- Bold red name: `{ selector: "#author", styles: { color: "red", fontWeight: "bold" } }`

### `execute_script({ tabId, script, args? })`
Runs a JavaScript function in the tab (same semantics as sandbox `executeInTab`).
- `script`: function source string, e.g. `"() => document.title"` or `"(x) => x + 1"`
- `args`: optional array passed to the function
- Runs in isolated world — DOM read/write works; page JS variables do not
- Return value must be JSON-serializable

**Example — highlight download controls:**
```js
execute_script({
  tabId,
  script: `() => {
    const sel = 'a[download], a[href$=".pdf"], button[download]';
    let n = 0;
    document.querySelectorAll(sel).forEach(el => {
      el.style.outline = '3px solid red';
      el.style.backgroundColor = '#fff3cd';
      n++;
    });
    return { highlighted: n };
  }`,
})
```

### `fetch_url({ url, maxChars = 12000 })`
Fetches a URL's text content without opening a tab.
- Plain `fetch(url)` — no browser rendering, no cookies/session from open tabs
- Strips `<script>`/`<style>` blocks and all HTML tags, collapses whitespace
- Truncates result to `maxChars` (default 12,000)

### `wait({ ms = 1000 })`
Pauses execution.
- Sleeps for `ms` milliseconds, capped at 15,000ms (15s) to prevent runaway waits
- Returns `{ ok: true }`

### `describe_image({ tabId?, imageUrl?, dataUrl? })`
Captions an image using a local Transformers.js `image-to-text` model (runs in the ONNX offscreen engine).
- Prefers `dataUrl`, else `imageUrl` (fetched by the pipeline), else screenshots `tabId` via `chrome.tabs.captureVisibleTab` (JPEG quality 70)
- Returns `{ caption, model }`

### `classify_image({ tabId?, imageUrl?, dataUrl?, topK = 5 })`
Classifies an image using a local ViT (`image-classification`).
- Same image resolution as `describe_image`
- Returns `{ labels: [{ label, score }], model }`

### `transcribe_audio({ audioUrl?, dataUrl? })`
Transcribes English audio using local Whisper (`automatic-speech-recognition`).
- Requires `audioUrl` or `dataUrl` (no microphone capture)
- Returns `{ text, model }`

---

## Shared Helpers

### `requireTabId(tabId)`
Throws `"This tool requires an active tabId"` if `tabId` is null/undefined. Used by every tool that needs to act on a specific tab (`read_page`, `get_links`, `click`, `type_text`, `scroll`, `navigate`).

### `truncate(str, max)`
Slices a string to `max` characters and appends `"\n...[truncated]"` if it was cut off. Used by `read_page` and `fetch_url` to keep tool results bounded for the LLM context window.

### `runInTab(tabId, func, args)` (internal)
Shared helper for all `chrome.scripting.executeScript` calls. Runs `func` in the tab's isolated world and returns the injection result.

---

## Implementation Pattern

| Category | Tools | Mechanism |
|----------|-------|-----------|
| **Page inspection/interaction** | `read_page`, `get_links`, `click`, `type_text`, `scroll` | `chrome.scripting.executeScript()` — injects and runs a function inside the tab's page context |
| **Page HTML / DOM manipulation** | `get_page_html`, `modify_element`, `execute_script` | Same `executeScript` path via internal `runInTab()` |
| **Tab management** | `list_tabs`, `open_tab`, `navigate` | `chrome.tabs.*` API — no script injection needed |
| **Network** | `fetch_url` | Plain `fetch()` — bypasses the browser tab entirely |
| **Timing** | `wait` | `setTimeout` wrapped in a Promise |
| **Local multimodal (ONNX)** | `describe_image`, `classify_image`, `transcribe_audio` | Offscreen Transformers.js via `engine.run`. Models are picked in Settings (`onnxCaptionModel`, `onnxClassifyModel`, `onnxAsrModel`) from the curated Xenova/onnx-community registry. |

All tools requiring `tabId` validate it via `requireTabId()` before running, so a missing tab produces a clear error the LLM can react to rather than a silent failure.

---

## Sandbox `api` (custom agent systems)

Home UI / tools JS for custom systems runs in [`sandbox.html`](../browser-agent/sandbox.html) and cannot call `chrome.*` directly. The host injects an `api` object bridged through [`tab-bridge.js`](../browser-agent/tab-bridge.js):

`listTabs`, `getActiveTab`, `executeInTab`, `readPage`, `click`, `typeText`, `scroll`, `navigate`, `captureTab`

`executeInTab` delegates to `execute_script` in [`tools/browser.js`](../browser-agent/tools/browser.js). The MCP/Agent tools `get_page_html`, `modify_element`, and `execute_script` are also available directly in Dialogue and Browser Agent automation.

These reuse the same privileged paths as above and accept any open `tabId` (active or background), except `captureTab` which requires a visible tab.
