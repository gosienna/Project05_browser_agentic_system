# Implementation Plan: In-Browser ONNX LLM Engine for Browser Agent

> **Instructions for the implementing agent (Claude Code):** This plan extends an existing Chrome MV3 extension ("Browser Agent") with an in-browser LLM engine built on **Transformers.js + ONNX Runtime Web**, exposed internally through an **OpenAI-compatible `chat.completions` interface**. Work through the phases in order. Each phase has acceptance criteria — do not move on until they pass. The existing codebase layout is described in §1.

---

## 0. Goals & non-goals

**Goals**
1. Add a new LLM provider, `onnx`, that runs models fully in-browser (WebGPU preferred, WASM/CPU fallback) with **zero external installs**.
2. All engines — ONNX, Ollama, OpenAI, Anthropic, custom — are consumed through **one internal protocol: the OpenAI `chat.completions` request/response format**. The ONNX engine is a "virtual server" answering over `chrome.runtime` messaging instead of HTTP.
3. The existing agent loop (`agent.js`) must work **unchanged** apart from small-model hardening (§6).
4. Model download UX: explicit, progress-visible, cached permanently, never blocks other providers.

**Non-goals (do not build)**
- No custom Python/Node servers.
- No provider-native tool calling — the agent keeps its plain-JSON tool protocol.

(WebLLM in-browser chat provider was added later; see `webllm-engine.js` and Settings → Built-in (WebLLM, WebGPU).)

---

## 1. Existing codebase (baseline)

```
browser-agent/
├── manifest.json        MV3; permissions: storage, tabs, scripting, activeTab,
│                        sidePanel, alarms, notifications; host_permissions: <all_urls>
├── background.js        service worker (module): port "agent" for live runs,
│                        one-shot messages (settings/trackers), chrome.alarms trackers
├── agent.js             ReAct loop; model replies one JSON object per step:
│                        {"thought","tool","args"} or {"thought","final"}; MAX_STEPS=14
├── tools.js             read_page, get_links, list_tabs, open_tab, navigate, click,
│                        type_text, scroll, fetch_url, wait — via chrome.scripting
├── llm.js               chat(messages, settings) -> string; providers: anthropic,
│                        openai, ollama, openai-compatible
├── sidepanel.html/css/js  UI: Agent chat w/ live trace, Trackers, Settings
└── icons/
```

Key existing contracts to preserve:
- `chat(messages, settings) -> Promise<string>` in `llm.js` (messages = OpenAI-style `[{role, content}]`).
- Side panel ↔ background: long-lived port named `"agent"` streaming events `{type: thinking|tool_start|tool_end|final|done|error}`.
- Settings stored in `chrome.storage.local` under key `settings`.

---

## 2. Target architecture

```
Side panel UI ──port──▶ background.js (agent loop, tools, trackers)
                              │
                        llm.js: chatCompletions(request, settings)
                              │
              ┌───────────────┴────────────────┐
              │ provider === "onnx"            │ other providers
              ▼                                ▼
   chrome.runtime message              fetch() to real HTTP endpoint
   { target:"onnx-engine", ... }       (Ollama/OpenAI/Anthropic/custom)
              │
              ▼
   offscreen.html + offscreen.js  ← persistent document, owns WebGPU context
   ├── engine.js: Transformers.js pipeline, model cache, device detection
   └── answers in OpenAI chat.completion / chat.completion.chunk shapes
```

**Why offscreen document:** the MV3 service worker cannot reliably use WebGPU and is killed after ~30s idle, which would evict loaded weights. Offscreen documents persist and may hold the GPU context. Create lazily via `chrome.offscreen.createDocument({ url, reasons: ["WORKERS"], justification: "Run local AI inference" })`; guard against "already exists" errors.

---

## 3. Internal protocol: OpenAI chat.completions everywhere

### 3.1 Request (subset we support)
```jsonc
{
  "model": "onnx-community/Qwen2.5-1.5B-Instruct",   // or provider-specific id
  "messages": [{"role": "system|user|assistant", "content": "..."}],
  "temperature": 0.2,
  "max_tokens": 1024,
  "stream": false            // true supported for onnx + openai-compatible
}
```

### 3.2 Non-streaming response
```jsonc
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "<model id>",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop" | "length"
  }],
  "usage": {"prompt_tokens": n, "completion_tokens": n, "total_tokens": n}  // best-effort
}
```

### 3.3 Streaming
Stream over a dedicated `chrome.runtime.connect` port named `"onnx-stream"`. Each event mirrors an OpenAI chunk:
```jsonc
{"object":"chat.completion.chunk","choices":[{"delta":{"content":"tok"},"index":0,"finish_reason":null}]}
// final chunk: finish_reason "stop", then {type:"done"} sentinel message
```

### 3.4 Error shape
```jsonc
{"error": {"message": "...", "type": "engine_error|model_not_loaded|oom|download_failed", "code": null}}
```

### 3.5 Refactor of `llm.js`
- New core: `chatCompletions(request, settings) -> response object`.
- Keep `chat(messages, settings) -> string` as a thin wrapper (build request, unwrap `choices[0].message.content`) so `agent.js`/`background.js` call sites keep working.
- Convert existing providers to produce/consume the shapes above internally:
  - `openai` / `openai-compatible`: passthrough (already this format).
  - `ollama`: translate to/from `/api/chat` (or just use Ollama's `/v1/chat/completions` shim — prefer this; it removes translation code. Keep native `/api/chat` fallback if `/v1` 404s).
  - `anthropic`: translate to/from `/v1/messages`.
  - `onnx`: `chrome.runtime.sendMessage({ target: "onnx-engine", type: "chat.completions", request })` after ensuring the offscreen document exists.

---

## 4. The ONNX engine (offscreen document)

### 4.1 New files
```
offscreen.html      minimal shell, loads offscreen.js as module
offscreen.js        message router: chat.completions, engine.status, engine.load,
                    engine.unload, engine.models
engine.js           Transformers.js integration (pipeline cache, device probe,
                    generation, streaming, memory handling)
vendor/transformers/   bundled @huggingface/transformers + ONNX Runtime .wasm files
```

### 4.2 Bundling (MV3 CSP: no remote code)
- Add a `package.json` + esbuild dev-dependency. Build step: `npm run build:vendor` → bundles `@huggingface/transformers` to `vendor/transformers/transformers.min.js` (ESM) and copies the `onnxruntime-web` `.wasm` binaries into `vendor/transformers/`.
- In `engine.js`: `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/")`.
- Model **weights** are data, not code — fetching them from the Hugging Face Hub at runtime is CSP-fine. Keep `env.allowRemoteModels = true`; weights are cached by the library (Cache Storage/IndexedDB) after first download.
- Add `vendor/transformers/*` to `web_accessible_resources` only if required by the wasm loader; prefer not exposing.

### 4.3 Device & dtype selection
```
probe order:
1. navigator.gpu && requestAdapter() succeeds → device "webgpu", dtype "q4f16"
2. else → device "wasm", dtype "q4" (set ort wasm numThreads = min(4, hardwareConcurrency))
Expose the chosen device in engine.status so the UI can show
"Running on GPU (WebGPU)" or "Running on CPU — responses will be slow".
On WebGPU allocation/OOM errors during load or generation: unload, retry once on
the next-smaller registry model, surface a clear error if that also fails.
```

### 4.4 Model registry (curate; store in `engine.js`)
| id (HF) | label | approx download | tier |
|---|---|---|---|
| `onnx-community/Llama-3.2-1B-Instruct` | Llama 3.2 1B | ~700 MB | fast |
| `onnx-community/Qwen2.5-1.5B-Instruct` | Qwen 2.5 1.5B | ~1 GB | fast, good JSON |
| `onnx-community/Llama-3.2-3B-Instruct` | Llama 3.2 3B | ~1.8 GB | default agent |
| `onnx-community/Qwen2.5-3B-Instruct` | Qwen 2.5 3B | ~2 GB | agent alt |
| `onnx-community/Phi-3.5-mini-instruct` | Phi 3.5 mini (3.8B) | ~2.2 GB | max |

> Verify exact repo ids and available dtypes at build time (`q4f16` for webgpu, `q4`/`q8` for wasm); adjust registry to what actually exists on the Hub under `onnx-community`.

### 4.5 Generation
- `pipeline("text-generation", modelId, { device, dtype, progress_callback })`, cached one instance at a time (loading a different model unloads the previous — call `dispose()` if available, else drop reference).
- **Chat formatting: pass the `messages` array directly to the pipeline.** Transformers.js v3+ applies the model's own chat template from `tokenizer_config.json`. Do NOT hand-write per-model prompt formats. Use `return_full_text: false`.
- Generation params: `max_new_tokens` from `max_tokens`, `temperature`, `do_sample: temperature > 0`, `top_p: 0.9`.
- Streaming: use `TextStreamer` with a `callback_function` that forwards deltas over the `onnx-stream` port in the chunk format of §3.3.
- Track a simple busy flag; queue concurrent requests FIFO (trackers + chat may collide).

### 4.6 Download progress
`progress_callback` events → broadcast `{target:"onnx-progress", file, progress, loaded, total, status}` via `chrome.runtime.sendMessage`; the side panel renders a progress bar. Persist "model X fully downloaded" flags in `chrome.storage.local` under `onnxModels` so the UI can show Downloaded/Not downloaded badges.

---

## 5. Background & manifest changes

### 5.1 `manifest.json`
- Add `"offscreen"` to `permissions`.
- No CSP changes should be needed if everything is bundled; if the wasm loader requires it, add `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`.

### 5.2 `background.js`
- Helper `ensureOffscreen()`: create offscreen doc if absent (handle race with a module-level promise).
- Route: any message with `target:"onnx-engine"` originates in background (from `llm.js` running inside the worker) — background talks to offscreen directly; the side panel never talks to the engine except for progress/status displays.
- Trackers: no change to logic; they call `chat()` which now routes through the shim. Add per-run timeout of 120 s for ONNX runs.

---

## 6. Agent hardening for small models (edits to `agent.js`)

1. **Compact system prompt variant.** When `settings.provider === "onnx"`, use a shorter system prompt: one-line tool list, plus TWO few-shot examples (one tool call, one final). Keep the full prompt for other providers.
2. **JSON retry.** If `extractJson()` returns null AND provider is onnx: push a corrective user turn — `Reply with ONLY one JSON object. Either {"tool":"...","args":{...}} or {"final":"..."}.` — and retry once per step (max 2 corrective retries per run) before treating text as final.
3. **Budgets when provider is onnx:** `MAX_STEPS = 8`; pass a hint into tools so `read_page` truncates at **6000 chars** and `fetch_url` at 6000 (make the truncation limits parameters of the tool layer rather than constants; default stays 14000/12000).
4. **Task routing (cheap heuristic).** In `background.js`, before starting the loop: if the task matches /^(summari[sz]e|tl;?dr|explain) this page/i → skip the agent loop; call `read_page` directly, then one single `chat()` with the page text. Faster and far more reliable on 1–3B models.

---

## 7. UI changes (side panel)

### 7.1 Settings tab
- Provider dropdown gains **"Built-in (ONNX, runs in your browser)"** as the FIRST option.
- When selected: hide Base URL & API key; show a **model picker** listing the registry with size + Downloaded/Not badge, a **Download / Load** button, a device line ("GPU (WebGPU)" / "CPU (slow)"), and an **Unload model** button.
- "Test connection" for onnx = send a 1-token chat.completions round trip.

### 7.2 First-run onboarding (new)
On first panel open (no `settings` in storage) show a chooser card:
1. **Built-in engine** — "No setup. Downloads a model (~0.7–2 GB) once." → provider onnx, default model Qwen2.5-1.5B, start download.
2. **Ollama** — probe `http://localhost:11434/api/tags` (1.5 s timeout); if reachable, show "Detected ✓" and list installed models.
3. **API key** — OpenAI / Anthropic / custom.

### 7.3 Status surfaces
- Download progress bar (from `onnx-progress` events) in Settings and as a slim bar in the chat view while active.
- Model badge in the composer already exists — show `onnx · <model> · gpu|cpu`.
- If a run starts while the model is still downloading: queue it and show "Waiting for model download (63%)…".

---

## 8. Phases & acceptance criteria

### Phase 1 — Shim + engine core
Build: §3 refactor of `llm.js`, offscreen doc, `engine.js` non-streaming, bundling, model registry, download progress, Settings UI for onnx.
**Accept when:**
- [ ] With provider=onnx and Qwen2.5-1.5B downloaded, "Summarize this page in 5 bullets" completes offline (network devtools shows no LLM API calls).
- [ ] Same build still works with provider=ollama and provider=openai (no regressions; `chat()` signature unchanged).
- [ ] Kill the service worker mid-idle (chrome://serviceworker-internals) → next request recreates offscreen/reuses loaded model without re-download.
- [ ] WebGPU machine reports device "webgpu"; forcing `device:"wasm"` still generates (slowly).

### Phase 2 — Agent hardening + streaming
Build: §6 items 1–3, §4.5 streaming, live token rendering in the trace/answer.
**Accept when:**
- [ ] A 3-step agent task (e.g. "open example.com and summarize it") succeeds ≥ 4/5 runs on the 1.5B model.
- [ ] Malformed-JSON reply triggers exactly one corrective retry, visible in console logs.
- [ ] Tokens stream into the UI for onnx provider.

### Phase 3 — Routing + polish
Build: §6 item 4, Ollama auto-detect banner ("Faster engine found — switch?"), tracker timeout, onboarding flow, unload/memory controls.
**Accept when:**
- [ ] "Summarize this page" bypasses the loop (single LLM call, verified in logs).
- [ ] Trackers run end-to-end on the onnx provider.
- [ ] Fresh-profile install walks through onboarding to a working first answer with no console errors.

### Phase 4 (optional, only if asked)
Embeddings pipeline (`Xenova/all-MiniLM-L6-v2`, WASM) in the same offscreen doc; `read_page` returns top-k relevant chunks for the current task instead of blind truncation.

---

## 9. Risks & mitigations
- **Small-model tool-use reliability** → routing (§6.4), retries (§6.2), recommend 3B as agent default when hardware allows; keep Ollama tier one click away.
- **VRAM OOM (3B q4f16 ≈ 3–4 GB with KV cache)** → auto-downshift path in §4.3.
- **HF Hub unreachable / download stalls** → surface `download_failed` with retry button; downloads resume from cache where the library supports it.
- **Concurrency (tracker fires mid-chat)** → FIFO queue in engine (§4.5).
- **Exact ONNX repo ids/dtypes drift** → registry is data; verify at build time and keep it easily editable.

## 10. Conventions for the implementer
- Vanilla JS ES modules throughout, matching existing style (no framework).
- No new runtime npm dependencies outside `vendor/` bundle; esbuild is dev-only.
- Every user-facing error must state the fix ("Model not downloaded — open Settings → Download").
- Keep all magic numbers (budgets, truncation, timeouts) as named constants at file tops.
- Log engine lifecycle events with a `[onnx]` prefix for debuggability.
