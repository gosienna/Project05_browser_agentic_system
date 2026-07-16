# System Editor Architecture (`system-editor-l2.js` / `system-editor-l1.js`)

## Overview

The system editor is a **meta-agent**: instead of controlling browser tabs, it edits the
components of an *agent system* (its own prompt, tools, and home UI) stored in IndexedDB.
It runs the same ReAct-style loop as `agent.js` (`agent.md`), but its "tools" read/write
[`system-store.js`](../browser-agent/system-store.js) instead of browser-control actions.

It comes in **two access levels**. The level is an **immutable property of each system**:
it is chosen once when the system is created (built-ins are seeded with theirs) and stored
on the system record in IndexedDB (`level`, plus `editableKind` for level 1). Every editor
run on that system uses its predefined level — the user customizes the system *within*
that level and cannot change it afterwards:

| Level | File | LLM can touch | Tools exposed to the LLM |
|-------|------|----------------|---------------------------|
| **2** (full system) | [`system-editor-l2.js`](../browser-agent/system-editor-l2.js) | all 5 components | `list_components`, `read_component`, `write_component`, `reload_home` |
| **1** (single script) | [`system-editor-l1.js`](../browser-agent/system-editor-l1.js) | exactly ONE designated component | `read_script`, `write_script`, `reload_home` |

Both levels share one generic loop implementation,
[`editor-loop.js`](../browser-agent/editor-loop.js) — each level file only supplies its own
system prompt and tool map. Both execute **inside the service worker** (`background.js`),
not inside the side panel or any iframe — the side panel only drives them remotely over a
`chrome.runtime` port.

## The two access levels

### Level 2 — full-system editor (`system-editor-l2.js`)

The original behavior: the LLM sees all component kinds, can list them, read any of them,
and overwrite any of them. Its system prompt (`EDITOR_PROMPT`) describes the whole
component model and encourages it to pick the right kind for the change.

### Level 1 — single-script editor (`system-editor-l1.js`)

A restricted variant for narrow, safer edits. The system's record designates one component
kind (`editableKind`, e.g. the Curve Plotter's `ui` script — the code that turns `y = x^2`
into the plotted curve), and the LLM gets only three tools: `read_script()`,
`write_script({content})`, and `reload_home()`. There is deliberately **no** `list_components`/`read_component` —
the other four components are not just off-limits by prompt instruction, they are
*mechanically unreachable*: `runScriptEditor` binds `read_script`/`write_script` to the
one `kind` passed in, so even a jailbroken or confused LLM reply cannot name another
component. Its prompt (`L1_PROMPT`) tells it to say so in the final answer if the task
would require touching locked components, rather than attempting it.

### Where the level is fixed and enforced

- **Creation** — `createSystem(name, { level, editableKind })` in `system-store.js` stamps
  the level onto the system record (level 1 also stores which script is editable, default
  `ui`); nothing ever updates these fields afterwards. The side panel's `+` button prompts
  for the level (and, for level 1, the script) when creating a system. Built-ins are
  seeded as **Browser Agent = level 2** and **Curve Plotter = level 1 (`ui`)**; a one-time
  migration in `ensureSeeded()` backfills these onto databases seeded before levels
  existed.
- **Display** — the side panel shows a read-only badge under "Edit components" (e.g.
  `Level 1 — LLM may edit only the "ui" script`), and the components viewer shows the same
  in its header. There is no per-run level control.
- **Enforcement** — the port message is just `{type:"run", task, systemId}`; it carries no
  level. `background.js` looks the system up in IndexedDB and dispatches on
  `system.level` / `system.editableKind`, so a modified or malicious side panel cannot
  request an escalated level — the choice lives server-side (in the service worker's
  store), and level 1's tool map makes other components mechanically unreachable on top of
  that.

---

## The component model

Every agent system (built-in or user-created) is a row in the `systems` IndexedDB store,
with up to 5 associated rows in `components` (keyed by `[systemId, kind]`):

| Kind    | Role                                                             |
|---------|-------------------------------------------------------------------|
| `agent` | System prompt / policy for that system's own agent loop           |
| `tools` | JS assigning `self.__agentTools = { name: async (args, api) => … }` |
| `html`  | Home page markup                                                  |
| `css`   | Home page styles                                                  |
| `ui`    | Home page script (runs after html/css mount)                      |

The editors never touch the DOM. They only read/write these five text blobs via
`system-store.js`, then ask the UI layer to reload so the user sees the result.

---

## The shared ReAct loop (`editor-loop.js` → `runEditorLoop`)

```
messages = [system: <level's prompt>, user: <level's intro + task>]

for step in 0..MAX_STEPS(14):
  reply  = await chat(messages, settings)          // LLM call (llm.js)
  parsed = extractJson(reply)                       // reuse agent.js's parser

  if parsed.final  → onEvent("final"); return
  if parsed.tool   → onEvent("thinking"), onEvent("tool_start")
                    → tools[parsed.tool](args)       // level-specific tool map
                    → onEvent("tool_end")
                    → append truncated result (8000 chars) to messages
```

Each level file builds its `tools` map as plain closures over the target system:

- **Level 2** (`runSystemEditor`): `list_components` / `read_component` /
  `write_component` → direct calls into `system-store.js` (IndexedDB read/write, no
  message passing needed — the service worker has direct DB access).
- **Level 1** (`runScriptEditor`): `read_script` / `write_script` → the same
  `getComponent`/`writeComponent` calls, but with the `kind` frozen to the one the
  caller designated.
- Both: `reload_home` → invokes the injected `onReloadHome()`, which `background.js`
  wires to `broadcastReload(systemId)`; every successful write also invokes the injected
  `onComponentWritten(kind)`, wired to a `system.updated` broadcast (see the components
  viewer below).

This mirrors `agent.js`'s loop almost exactly (same `MAX_STEPS`, same JSON contract,
same event vocabulary: `thinking` / `tool_start` / `tool_end` / `final` / `error`), just
with a different tool surface and per-level system prompts.

---

## How the loop actually re-prompts the LLM (`messages` accumulation)

There is no server-side "session" or streaming conversation with the LLM — every provider
in `llm.js` (`onnx` / `openai` / `ollama` / `anthropic`) is a stateless
request/response call. "Looping the LLM" means `runEditorLoop` keeps one growing
JavaScript array, `messages`, and **resends the entire array from scratch on every
`chat()` call** (`editor-loop.js`). The array is the only memory the loop has; there
is no role/type other than `system` / `user` / `assistant` — tool results are appended as
plain `user` messages, exactly like `agent.js` does. Everything below applies identically
to both levels; only the seed messages and the tool map differ.

### Turn-by-turn mechanics

1. **Seed**: `messages` starts as `[{role:"system", content: <level's prompt>},
   {role:"user", content: <level's intro>}]` — for Level 2 the intro lists all available
   kinds; for Level 1 it names the single editable script and states that everything else
   is locked.
2. **Ask**: `chat(messages, settings)` serializes the *whole* array into one
   completion request and returns the assistant's raw text `reply`.
3. **Parse**: `extractJson(reply)` (shared with `agent.js`) strips markdown
   fences if present and parses the first `{...}` blob.
   - **If parsing fails entirely** (`parsed` is `null`): the loop treats the raw
     text itself as the final answer and returns immediately — it does **not** push
     anything to `messages` and does **not** retry. A single unparsable reply ends the run.
4. **Record the reply**: once JSON parses successfully, the raw `reply` string is
   pushed onto `messages` as `{role:"assistant", content: reply}` — *before* checking
   whether it's a valid tool call or a final answer. This is what makes the LLM's own past
   turns part of the context it sees on the next call.
5. **Branch on the parsed shape**:
   - **`final` present**: emit the `final` event and `return` — loop ends, no
     further `chat()` calls.
   - **Neither `tool` nor `final`**: push a corrective
     `{role:"user", content:'Missing "tool" or "final". Reply with a single valid JSON object.'}`
     message and `continue` — this consumes one of the 14 steps but re-prompts the LLM
     with an explicit nudge on the next iteration.
   - **`tool` present**: emit `thinking`/`tool_start`, look the name up in the
     level's `tools` map (an unknown name — including a Level 1 attempt to call
     `write_component` — throws and becomes an error result), run it, emit `tool_end`,
     then push `{role:"user", content:"Tool result:\n" + truncate(JSON-or-string(result), 8000)}`
     onto `messages`. The `try/catch` around the tool call means a thrown error becomes
     `"Error: <message>"` fed back as the tool result — the loop never crashes on a bad
     tool call, it just hands the LLM the error text to react to on its next turn.
6. **Repeat**: the `for` loop goes back to step 2 with `messages` now longer — the next
   `chat()` call re-sends the system prompt, the original task, *and every prior
   assistant reply + tool result* verbatim. This full-history replay is what lets the LLM
   "remember" what it already read/wrote without any server-side state.
7. **Step budget**: after `MAX_STEPS` (14) iterations without a `final`, the loop exits
   and returns a fixed fallback string — no 15th `chat()` call is made.

### Growth pattern

Each tool-call step appends exactly **2** entries to `messages` (one `assistant`, one
`user` tool-result); a final step appends **1** (`assistant` only, then returns); a
missing-tool/final step also appends **2** (`assistant` + corrective `user`). So after `N`
tool-call turns followed by a finishing turn, `messages.length = 2 + 2N + 1`, and that
entire array is what gets re-sent on turn `N+1`.

### Worked example — task: "make the plotter background pink"

| Step | `chat()` sees (roles only, growing)                                    | Reply parsed as                          | Effect on `messages` before next call |
|------|--------------------------------------------------------------------------|-------------------------------------------|----------------------------------------|
| 0    | `system, user(task)`                                                     | `tool: list_components`                    | + assistant, + user(tool result: kind/byte list) |
| 1    | `system, user, assistant, user`                                          | `tool: read_component({kind:"css"})`       | + assistant, + user(tool result: current CSS text) |
| 2    | `system, user, assistant, user, assistant, user`                         | `tool: write_component({kind:"css", content:"…pink…"})` | + assistant, + user(tool result: `{ok:true, bytes:…}`) |
| 3    | (8 messages so far)                                                       | `tool: reload_home`                        | + assistant, + user(tool result: `{ok:true}`) |
| 4    | (10 messages so far)                                                      | `final: "Updated the background to pink."` | + assistant only → loop returns        |

Five `chat()` calls total, each one a fresh, complete replay of everything before it —
that's the entirety of the "loop" the LLM is participating in from its own point of view
it never sees anything but "here is the whole transcript so far, produce the next JSON
object."

### Every LLM turn is streamed to the UI as it happens

Because `onEvent` fires synchronously inside each loop iteration (not just at the end),
`background.js`'s port listener forwards `thinking` / `tool_start` / `tool_end` events to
`sidepanel.js` in real time (`editor-loop.js` → `port.postMessage(event)` →
`sidepanel.js`'s `editorPort.onMessage` → `addTraceEvent(...)`), so the side panel's trace
pane fills in one row per loop turn while the editor is still mid-loop, well before
the eventual `final`/`done`.

---

## How it's wired to the Chrome extension surfaces

```
┌─────────────────────┐   port "system-editor"   ┌──────────────────────────┐
│ sidepanel.html       │  {run, task, systemId}   │ background.js            │
│ (side panel doc)     │ ───────────────────────► │ (service worker)         │
│                       │ ◄─────────────────────── │  system.level (from IDB) │
│ • level badge (read-  │  thinking/tool/final/done│   2 → runSystemEditor     │
│   only, per system)   │                          │   1 → runScriptEditor     │
│ • #editor-form submit │                          │  ├─ editor-loop.js        │
│ • renders trace       │                          │  ├─ chat() → llm.js       │
│ • <iframe             │                          │  └─ system-store.js (IDB)│
│    #system-home-frame>│                          └───────────┬──────────────┘
│    src=system-host.html                                      │ on write / reload_home
└──────────┬────────────┘                                      │
           │ on "done": reloadHomeFrame()          chrome.runtime.sendMessage
           │ (re-navigates iframe, cache-busted)    {type:"system.updated", kind}
           ▼                                        {type:"system.reload"}
                                                            │
                              ┌──────────────────────────────┤
                              ▼                              ▼
                   system-components.html          system-host.html (below)
                   (per-kind tabs viewer,
                    marks changed tabs)
┌─────────────────────┐   postMessage (payload)    ┌──────────────────────────┐
│ system-host.html     │ ──────────────────────────►│ sandbox.html (iframe)    │
│ • own IndexedDB read  │                            │ • relaxed-CSP sandbox    │
│   (system-store.js)   │ ◄──────────────────────────│ • new Function(tools/ui) │
│ • listens for          │   postMessage (api call)   │ • executes LLM-authored │
│   "system.reload"       │                            │   html/css/ui/tools     │
│   broadcast              ▼                                                     │
└──────────┬────────────┘                                                        │
           │ chrome.runtime.sendMessage({type:"tabBridge", op, ...})             │
           ▼                                                                     │
┌─────────────────────────────────────────────────────────────────────────┐     │
│ background.js — tabBridge handler (tab-bridge.js)                        │◄────┘
│ chrome.tabs.*, chrome.scripting.executeScript, tools.js read_page/click… │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐  (only if settings.provider === "onnx")
│ offscreen.html        │◄── chrome.runtime.sendMessage({target:"onnx-engine",…})
│ • owns a Worker         from llm.js's chat() call inside runSystemEditor's loop
│   (ort-worker.js)      → runs local ONNX/transformers.js inference
│ • forwards result back  → resolved chat() reply becomes the next LLM turn
└─────────────────────┘
```

### 1. `sidepanel.html` → `background.js`: long-lived port, not one-shot messages

`sidepanel.js` opens `chrome.runtime.connect({ name: "system-editor" })` and posts
`{ type: "run", task, systemId }`. `background.js`'s `chrome.runtime.onConnect` listener
(matching `port.name === "system-editor"`) owns the *entire* editor run: it loads
settings, calls `runSystemEditor(...)`, and streams every `onEvent` back over the same
port (`port.postMessage(event)`). The port stays open for the whole multi-step LLM loop;
`sidepanel.js` renders each event into `#trace` and disables the editor/run buttons until
`done`/`error`.

This is the same pattern used for the classic browser-automation port (`"agent"`), just a
second named port sharing the same service worker.

### 2. `background.js` is the only place the editor loop runs

Unlike the sandboxed home UI, the editors run with full service-worker
privileges — it imports `system-store.js` directly and mutates IndexedDB in-process. It
never needs `tabBridge` for its own tool calls (only sandboxed home-UI code does, since
`sandbox.html` has no `chrome.*` access at all).

### 3. Propagating an edit to the live UI: three independent refresh paths

When component writes happen and/or the LLM calls `reload_home`:

- **Write broadcast** — every successful `write_component`/`write_script` fires the
  injected `onComponentWritten(kind)`, which `background.js` wires to
  `chrome.runtime.sendMessage({type:"system.updated", systemId, kind})`. The components
  viewer (`system-components.html`, see §7) listens for this to refresh and mark the
  changed tab — it fires per write, so the user can watch edits land mid-run.
- **Reload broadcast** — `reload_home` fires `chrome.runtime.sendMessage({type:
  "system.reload", systemId})`. Any open `system-host.html` document with a matching
  `systemId` (it registered its own `chrome.runtime.onMessage` listener) re-reads
  components straight from IndexedDB and `postMessage`s a fresh `{type:"load", html,
  css, ui, tools}` payload into its `sandbox.html` iframe.
- **Side-panel path** — independently, when `sidepanel.js` receives the port's `"done"`
  event, it calls `reloadHomeFrame()`, which re-points `#system-home-frame`'s `src` to
  `system-host.html?id=…&t=<timestamp>` (cache-busted), forcing a full reload of the host
  document (and, transitively, a fresh `sandbox.html`).

Multiple paths can fire for the same edit (mid-run `reload_home` calls hit the broadcast
path; the final `done` hits the side-panel path), which is redundant but harmless since
`loadComponents()` is idempotent.

### 4. `system-host.html` never talks to the service worker for reads

`system-host.js` imports `system-store.js` and queries IndexedDB **directly** — the
service worker is not a data proxy for component reads. `background.js` only re-enters
the picture for: (a) running the LLM loop itself, and (b) brokering `tabBridge` calls
that the sandboxed home UI's tool/ui code makes through `system-host.js` →
`chrome.runtime.sendMessage({type:"tabBridge", op, ...})` → `tab-bridge.js`.

### 5. `sandbox.html` is where LLM-authored code actually executes

`sandbox.html` is declared under `"sandbox":{"pages":[...]}` in `manifest.json`, giving
it an opaque origin and no access to `chrome.*` APIs — the safe place to `new
Function(...)` the `tools`/`ui` components the editor just wrote. It talks to its parent
(`system-host.html`) only via `postMessage`, and any privileged action (tab access) is
proxied host → background → `tab-bridge.js` → back down the same chain.

### 6. `offscreen.html` is only involved when the provider is local ONNX

`chat()` (called from inside `runSystemEditor`'s loop, running in the service worker) is
provider-agnostic. If `settings.provider === "onnx"`, `llm.js` calls
`ensureOffscreenDocument()` (creates `offscreen.html` via `chrome.offscreen.createDocument`
if not already running — service workers cannot run WASM/Atomics directly) and then
`chrome.runtime.sendMessage({target:"onnx-engine", type:"chat.completions", request})`.
`offscreen.js` picks this up, forwards it to a Dedicated Worker (`ort-worker.js`, since
`Atomics.wait` is illegal on the offscreen document's main thread), and relays the
inference result back — which becomes the next assistant turn in the editor's message
history. For any other provider (OpenAI/Ollama/Anthropic), `llm.js` just `fetch()`s
directly from the service worker and `offscreen.html` is never created.

### 7. `system-components.html` — the per-system components viewer

Each agent system has a read-only viewer page,
[`system-components.html`](../browser-agent/system-components.html) (opened via the
**Components** link next to the system selector in the side panel, URL
`system-components.html?id=<systemId>`). It renders **one tab per component kind**
(`agent` / `tools` / `html` / `css` / `ui`), each showing the kind's byte size in the tab
and the full content plus its `updatedAt` timestamp in the pane.

Like `system-host.html`, it imports `system-store.js` and reads IndexedDB directly — no
service-worker proxying. It tracks modifications live via the broadcasts from §3:

- On `{type:"system.updated", systemId, kind}` (fired on **every** editor write, level 1
  or 2) it refreshes and puts an orange **dot** on the changed kind's tab if it isn't the
  one currently being viewed — clicking the tab clears the dot. This lets the user watch
  which components an editor run is touching, write by write, while the run is still in
  progress.
- On `{type:"system.reload", systemId}` it simply refreshes.
- A manual **Refresh** button covers edits made while the page's extension process was
  not listening.

---

## Summary

The system editor is one shared ReAct loop (`editor-loop.js`, same shape as `agent.js`)
whose "world" is IndexedDB component text instead of browser tabs, instantiated at two
access levels: `system-editor-l2.js` (Level 2, full control over all five components) and
`system-editor-l1.js` (Level 1, mechanically confined to one designated script — the
locked components aren't even reachable through its tool map). The interesting part isn't
the loop itself — it's the surrounding wiring: the service worker is the only privileged,
long-running compute context (owns the LLM loop, the IndexedDB writes, the tab bridge, and
the optional ONNX offscreen relay, and resolving each system's immutable level from its
IndexedDB record); `sidepanel.html` is a thin remote control over a `chrome.runtime` port
that displays — but cannot change — the system's level;
`system-host.html` is an independent IndexedDB reader that re-renders on a
`system.reload` broadcast; `system-components.html` is a per-kind tabbed viewer that
tracks each write via `system.updated` broadcasts; and `sandbox.html` is the sandboxed
execution target for whatever html/css/ui/tools code the editor just wrote.
