# WebApp Architecture

## Overview

The WebApp tab is a multi-system workspace for building and editing small web UIs (home pages) that run in a sandboxed tab. LLM-driven edits happen through the **Dialogue dock** (same chat engine as the Dialogue tab), not a separate automation loop.

---

## Custom agent systems

Each **agent system** is stored in IndexedDB (`agent-systems`) via [`system-store.js`](../browser-agent/WebApp/system-store.js) with components:

| Kind | Role |
|------|------|
| `html` / `css` / `script` | Home page markup, styles, and script |

**Built-ins (seeded once):**

- **Curve Plotter** — demo home UI (cartesian plot of `y = x^2`) meant to be edited via the LLM.

A former **Browser Agent** builtin (`id: browser-agent`) and its `runAgent()` automation path have been removed. Existing installs delete that system on `ensureSeeded()` via `migrateRemoveBrowserAgent()`.

**Create:** `+` in the WebApp tab → empty home stub + starter components.

**Home runtime:** [`system-host.html`](../browser-agent/WebApp/system-host.html) embeds sandboxed [`sandbox.html`](../browser-agent/WebApp/sandbox.html) (relaxed CSP) so LLM/user JS can run. The host loads components from IndexedDB and `postMessage`s them into the sandbox.

**Tab access from sandbox:** the sandbox cannot call `chrome.*`. It uses an injected `api` (`listTabs`, `getActiveTab`, `executeInTab`, `readPage`, `click`, `typeText`, `scroll`, `navigate`, `captureTab`) bridged through the host → [`tab-bridge.js`](../browser-agent/tab-bridge.js) in the service worker. Any open tab (active or not) can be targeted by `tabId`.

**Edit components (LLM):** The WebApp tab docks the Dialogue chat on the right (same sessions as the Dialogue tab; RAG chrome is hidden). Component edits go through MCP tools `list_components` / `read_component` / `write_component` / `reload_home` on the selected system. Same `chatCompletions()` providers as Dialogue (ONNX / WebLLM / Ollama / API). A ReAct loop in [`system-editor.js`](../browser-agent/WebApp/system-editor.js) still exists on port `system-editor` but is unused from the side panel. The docked chat system prompt lives in [`WebApp/prompt.js`](../browser-agent/WebApp/prompt.js), separate from Dialogue's `MCP_TOOL_HINT`.

```
Side panel WebApp tab
  ├─ system select / + / Render → system-host.html → sandbox (separate tab)
  └─ Dialogue dock (right) → dialogue.send / dialogue.tool.run
       ├─ web search + browser MCP (no RAG)
       └─ WebApp component MCP → system-store.js
```

---

## Key modules

| Module | Role |
|--------|------|
| [`WebApp/ui.js`](../browser-agent/WebApp/ui.js) | System picker, component editor, Render |
| [`WebApp/prompt.js`](../browser-agent/WebApp/prompt.js) | Dock system messages + WebApp tool hint |
| [`WebApp/tools/`](../browser-agent/WebApp/tools/) | Component MCP handlers (`list` / `read` / `write` / `reload`) |
| [`WebApp/system-store.js`](../browser-agent/WebApp/system-store.js) | IndexedDB systems + components |
| [`WebApp/agent.js`](../browser-agent/WebApp/agent.js) | Shared `extractJson()` helper (used by editor-loop) |
| [`dialogue/ui.js`](../browser-agent/dialogue/ui.js) | Dialogue dock / Dialogue tab chat loop |

---

## Local engines

`onnx` runs Transformers.js in [`engine.js`](../browser-agent/engine.js) (WebGPU or WASM fallback). `webllm` runs MLC [`webllm-engine.js`](../browser-agent/webllm-engine.js) (WebGPU only). Vision/audio MCP tools (`describe_image`, etc.) always use ONNX even when chat provider is WebLLM. Switching between ONNX and WebLLM chat unloads the other engine's LLM weights to save GPU memory.

---

## Summary

WebApp is a **system + sandbox workspace**. Chat and tool use go through the Dialogue dock (MCP), which can edit `html` / `css` / `script` for the selected system and optionally use browser/search tools. There is no separate JSON ReAct `runAgent()` path.
