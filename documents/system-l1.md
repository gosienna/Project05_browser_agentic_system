# Level 1 Agent System — Activation & Run Flow

A Level 1 agent system (e.g. Curve Plotter) has two distinct activations:

1. **Runtime** — the system’s home UI executes in a sandbox.
2. **Editor** — `system-editor-l1.js` runs as a meta-agent that may edit only the granted script kinds (`editableKinds`).

`system-editor-l1.js` is **not** the system’s runtime. It only edits components; the live system always runs via host → sandbox.

---

## Runtime: how a Level 1 system runs

```
sidepanel.js
  select system → currentSystemId
  applyCurrentSystem() → reloadHomeFrame()
       │
       ▼
  #system-home-frame  src = system-host.html?id=<systemId>
       │
       ▼
  system-host.js
  • read html / css / ui / tools from IndexedDB (system-store.js)
  • postMessage { type: "load", … } into sandbox iframe
       │
       ▼
  sandbox.js  (sandbox.html — relaxed CSP, no chrome.*)
  • mount css + html
  • new Function(tools) → self.__agentTools
  • new Function(ui) with (api, tools) in scope
```

Notes:

- Selecting a Level 1 system in the side panel is enough to “activate” it — the home iframe loads and the `ui` script runs.
- The browser-automation form (`agent` port) is shown only for the built-in Browser Agent, not for typical Level 1 systems.
- Sandbox runtime errors are caught locally (`console.error` + a red `<pre>` in the page). They are **not** forwarded to the L1 editor LLM.

---

## Editor: how `system-editor-l1.js` is activated

Triggered only from **Edit components (LLM)** in the side panel.

```
sidepanel.js  — editor form submit
  runEditorTask(task)
  chrome.runtime.connect({ name: "system-editor" })
  postMessage { type: "run", task, systemId }
       │
       ▼
background.js  — port "system-editor"
  getSystem(systemId) from IndexedDB
  if system.level === 1 → runScriptEditor(...)
  else                  → runSystemEditor(...)   // L2
       │
       ▼
system-editor-l1.js  — runScriptEditor
  tools: list_scripts / read_script / write_script / reload_home
  (kinds frozen to system.editableKinds)
       │
       ▼
editor-loop.js  — runEditorLoop
  ReAct loop → chat() via llm.js (ONNX / Ollama / API)
  events stream back on the same port → side panel trace
```

Important:

- The side panel does **not** choose L1 vs L2. That is fixed on the system record at creation (`level`, `editableKinds`).
- The port payload carries only `{ type, task, systemId }`. `background.js` looks up `system.level` and dispatches.

---

## After an edit

| Trigger | What happens |
|---------|----------------|
| `write_script` | IndexedDB write + `system.updated` broadcast (components viewer refreshes) |
| `reload_home` | `system.reload` broadcast → open `system-host` re-reads IDB and reloads the sandbox |
| editor `done` | side panel cache-busts `#system-home-frame` again |

`reload_home` returns `{ ok: true }` only. It does not wait for the sandbox or return runtime/console errors to the LLM. The only errors the editor LLM sees are **tool-call failures** (e.g. locked kind, missing `content`) caught in `editor-loop.js`.

---

## Level stamp (immutable)

| Field | Role |
|-------|------|
| `level: 1` | Selects `runScriptEditor` in `background.js` |
| `editableKinds` | Script kinds the L1 tools may read/write (legacy: singular `editableKind`) |

Set once via `createSystem(name, { level, editableKinds })`. The side panel can later tweak L1 `editableKinds` / custom persona via `updateSystemEditorConfig`, but cannot escalate to Level 2.
