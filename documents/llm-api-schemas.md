# LLM API Schemas — ONNX, WebLLM, Ollama, OpenAI, NVIDIA NIM, Gemini

Reference for how each LLM backend is called in this extension. All chat paths converge on a single **internal OpenAI Chat Completions shape** in [`llm.js`](../browser-agent/llm.js); each provider adapter translates to its own wire format.

For chat-template rendering details (ONNX vs Ollama), see [chat-input-processing.md](./chat-input-processing.md). For reasoning display, see [model-reasoning-display.md](./model-reasoning-display.md).

---

## Unified internal protocol

Every provider is consumed through `chatCompletions(request, settings)`:

```js
// Request (extension-internal)
{
  model?: string,
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool",
    content: string | object[],  // multimodal parts on ONNX VLMs
    tool_calls?: object[],
    tool_call_id?: string,
    tool_name?: string,
  }>,
  tools?: Array<{ type: "function", function: { name, description?, parameters? } }>,
  temperature?: number,   // default 0.2
  max_tokens?: number,    // from settings.maxTokens when omitted
  stream?: boolean,       // always false in practice
  thinkingEnabled?: boolean,  // injected from settings.enableThinking; never sent raw to HTTP APIs
}

// Success response (OpenAI chat.completion)
{
  id: string,
  object: "chat.completion",
  created: number,
  model: string,
  choices: [{
    index: 0,
    message: { role: "assistant", content: string, tool_calls?: object[], reasoning?: string },
    finish_reason: "stop" | "length" | "tool_calls",
    rawMessage?: object,  // pre-normalization copy
  }],
  usage: { prompt_tokens, completion_tokens, total_tokens },
  prompt?: string,        // rendered chat template (ONNX, Ollama debug)
  context_trimmed?: object, // WebLLM only when history was trimmed
}

// Error response
{ error: { message: string, type: string, code: null } }
```

`finalizeChatCompletion()` in [`reasoning-content.js`](../browser-agent/reasoning-content.js) normalizes assistant `reasoning` / `thinking` / embedded `` blocks across providers.

### Routing

| `settings.provider` | Handler | Model setting key |
|---------------------|---------|-------------------|
| `onnx` | `onnxChatCompletions` → offscreen `onnx-engine` | `settings.onnxModel` |
| `webllm` | `webllmChatCompletions` → offscreen `webllm-engine` | `settings.webllmModel` |
| `ollama` | `ollamaChatCompletions` → HTTP to local Ollama | `settings.model` |
| `openai` | `openaiChatCompletions` → OpenAI Chat Completions HTTP | `settings.model` |
| `openai-compatible` | `openaiChatCompletions` → custom `/v1` endpoint | `settings.model` |
| `nvidia-nim` | `openaiChatCompletions` → NVIDIA NIM HTTP | `settings.model` |
| `anthropic` | `anthropicChatCompletions` → Anthropic Messages HTTP | `settings.model` |
| `gemini` | `geminiChatCompletions` → Google generateContent HTTP | `settings.model` |

API keys are stored per provider in `settings.apiKeys` (`openai`, `anthropic`, `nvidia-nim`, `gemini`, `openai-compatible`). `resolveApiKey(settings, provider)` in [`llm-providers.js`](../browser-agent/llm-providers.js) reads the matching slot. A legacy single `settings.apiKey` is migrated into that map on load.

---

## 1. ONNX Runtime (local)

**Stack:** Transformers.js on ONNX Runtime Web (WASM / WebGPU) inside a Dedicated Worker (`ort-worker.js` → [`engine.js`](../browser-agent/engine.js)).

**Not a raw ORT tensor API.** Inference uses Hugging Face `pipeline()` / `model.generate()` / `tokenizer.apply_chat_template()`.

### Extension IPC

Messages use `target: "onnx-engine"` via the offscreen document ([`offscreen.js`](../browser-agent/offscreen.js)).

| `type` | `request` / fields | Returns |
|--------|-------------------|---------|
| `chat.completions` | OpenAI-shaped chat request + `model` | `chat.completion` (+ optional `prompt`) |
| `chat.renderPrompt` | `{ model, messages, tools?, thinkingEnabled? }` | `{ prompt: string \| null }` |
| `engine.run` | See multimodal schema below | `{ task, model, output }` or `{ error }` |
| `engine.load` | `model` (+ optional `task`) | `status()` |
| `engine.unload` | optional `{ task, model }` | `status()` |
| `engine.unloadLlm` | — | `status()` |
| `engine.status` | — | device, loaded models, registry, cache |
| `engine.models` | `task: "*"` for full registry | `{ models: [...] }` |
| `engine.contextEstimate` | `model` | context window estimate |
| `engine.clearCache` | — | `status()` |
| `engine.deleteModel` | `model` | `status()` + `removed` |

Side panel / Settings relay: `{ type: "onnx.relay", engineType, model?, task?, request? }` in [`background.js`](../browser-agent/background.js).

### Chat completions

**Internal → engine mapping** (`runChatCompletions`):

```js
{
  task: "text-generation" | "image-text-to-text",  // from MODEL_REGISTRY
  model: request.model,
  input: request.messages,
  options: {
    max_new_tokens: resolveMaxTokens(request.max_tokens),
    temperature: request.temperature ?? 0.2,
    enable_thinking: request.thinkingEnabled !== false,  // Qwen3, Gemma 4
    tools?: request.tools,
  }
}
```

**Thinking:** `enable_thinking` passed to chat template for Qwen3 and Gemma 4 VLMs.

**Response extras:** `prompt` — the Jinja-rendered string actually tokenized (Dialogue raw “Prompt” tab).

### Multimodal — `engine.run`

```js
// Request
{
  task: "text-generation" | "image-text-to-text" | "image-to-text"
      | "image-classification" | "automatic-speech-recognition" | "feature-extraction",
  model?: string,
  input: unknown,
  options?: { max_tokens?, temperature?, tools?, topK?, ... }
}

// Response output shapes (normalized)
// text-generation / image-text-to-text → { text, prompt?, usage? }
// image-to-text                        → { caption }
// image-classification                 → { labels: [{ label, score }] }
// automatic-speech-recognition         → { text }
// feature-extraction (RAG)             → { embedding: number[], dims }
```

Used by agent tools (`describe_image`, `classify_image`, `transcribe_audio`) and RAG embeddings when `ragEmbedProvider` is `onnx`.

### Execution

| Aspect | Detail |
|--------|--------|
| Device | WebGPU when available, else WASM CPU |
| Quantization | `q4f16` on WebGPU, `q4` on WASM (per-model overrides in registry) |
| Cache | IndexedDB (HF weight blobs) |
| Host | Offscreen document + `ort-worker.js` Dedicated Worker |

---

## 2. WebLLM (local)

**Stack:** MLC `MLCEngine` from `@mlc-ai/web-llm` in `webllm-worker.js` → [`webllm-engine.js`](../browser-agent/webllm-engine.js). **WebGPU required** — no CPU fallback.

### Extension IPC

Messages use `target: "webllm-engine"`.

| `type` | `request` / fields | Returns |
|--------|-------------------|---------|
| `chat.completions` | OpenAI-shaped chat request + `model` | `chat.completion` (+ optional `context_trimmed`) |
| `embeddings.create` | `{ model, input: string \| string[] }` | `{ model, embeddings: [{ embedding, index }], dims }` |
| `engine.load` | `model` | `status()` |
| `engine.unload` | — | `status()` |
| `engine.status` | — | device, loaded chat/embed models, registry |
| `engine.models` | — | `{ models: [...] }` (chat) |
| `engine.embedModels` | — | `{ models: [...] }` (embedding-only builds) |
| `engine.contextEstimate` | `model` | context from `prebuiltAppConfig` |
| `engine.clearCache` / `engine.deleteModel` | `model` for delete | `status()` |

Relay: `{ type: "webllm.relay", engineType, model?, request? }`.

### Chat completions

WebLLM exposes an **OpenAI-compatible** client internally:

```js
// Sent to MLCEngine (after context trimming)
{
  model: string,
  messages: [...],       // may be trimmed to fit contextWindow
  stream: false,
  temperature: number,
  max_tokens: number,
  tools?: object[],      // only for models in functionCallingModelIds
  extra_body?: { enable_thinking: boolean }  // Qwen3 only
}
```

`engine.chat.completions.create(body)` — response is re-wrapped into standard `chat.completion` shape.

**Tool gating:** `stripUnsupportedNativeTools()` in [`webllm-models.js`](../browser-agent/webllm-models.js) removes `tools` for models that do not support function calling.

**Context trimming:** `trimChatMessagesForContext()` may drop older turns; response can include `context_trimmed: { droppedTurns, estimatedTokens, contextLimit }`.

### Embeddings (RAG)

```js
engine.embeddings.create({ model, input })
```

Default embed model: `snowflake-arctic-embed-s-q0f32-MLC-b4`.

### Execution

| Aspect | Detail |
|--------|--------|
| Device | WebGPU only |
| Models | `prebuiltAppConfig.model_list` (MLC prebuilt) |
| Cache | IndexedDB via WebLLM cache backend |
| Prompt preview | Not supported (`renderChatPromptPreview` returns `{ prompt: null }`) |

---

## 3. Ollama (local server)

**Stack:** HTTP to a running Ollama daemon. Default base URL: `http://127.0.0.1:11434` (`settings.baseUrl`).

### Chat completions — dual API

Primary path tries OpenAI-compatible shim; falls back to native Ollama API.

#### Primary: `POST {baseUrl}/v1/chat/completions`

```js
{
  model: string,
  messages: [...],
  tools?: object[],
  temperature?: number,
  max_tokens?: number,
  stream: false,
  think: boolean,  // from thinkingEnabled (default true)
}
```

Response: native OpenAI `chat.completion` JSON (passed through).

#### Fallback: `POST {baseUrl}/api/chat`

```js
{
  model: string,
  messages: [{ role, content?, tool_calls?, tool_call_id?, tool_name? }],
  stream: false,
  think: boolean,
  options: { temperature, num_predict },  // num_predict ← max_tokens
  tools?: object[],
}
```

Response is translated to OpenAI shape in `ollamaChatCompletionFromNative()`:

- `message.thinking` / `message.reasoning` / `message.reasoning_content` → `message.reasoning`
- `finish_reason`: `tool_calls` | `stop` | `length`
- `usage` from `prompt_eval_count` / `eval_count`

### Prompt preview (no inference)

`POST {baseUrl}/api/chat` with `_debug_render_only: true` plus the native chat body.

Response field: `debug_info.rendered_template` or `_debug_info.rendered_template` → `response.prompt`.

### Embeddings (RAG)

`POST {baseUrl}/api/embed` (not legacy `/api/embeddings`):

```js
{ model: string, input: string | string[] }
// → { embeddings: number[][] }
```

Default model: `nomic-embed-text` (`settings.ragOllamaEmbedModel`).

### Model management

| Endpoint | Method | Body | Purpose |
|----------|--------|------|---------|
| `/api/tags` | GET | — | List installed models |
| `/api/pull` | POST | `{ model, stream: true }` | Pull model (NDJSON progress) |
| `/api/delete` | POST | `{ name }` | Delete local model |
| `/api/show` | POST | `{ model }` | Model metadata / template |

Implemented in [`ollama-models.js`](../browser-agent/ollama-models.js). CORS may require `OLLAMA_ORIGINS="*"` or extension DNR rules.

### Thinking

| Setting | Wire field |
|---------|------------|
| `settings.enableThinking !== false` | `think: true` on both `/v1/chat/completions` and `/api/chat` |

---

## 4. OpenAI (remote)

**Stack:** OpenAI Chat Completions REST API. Default base URL: `https://api.openai.com/v1` (`settings.baseUrl`, overridable) ([`llm-providers.js`](../browser-agent/llm-providers.js), [`openai-models.js`](../browser-agent/openai-models.js)).

Uses `openaiChatCompletions` — the internal OpenAI chat request is sent **as-is** (no provider-specific translation).

### Chat completions

`POST {baseUrl}/chat/completions`

```js
// Headers
{
  "Content-Type": "application/json",
  "Authorization": "Bearer <sk-…>"   // required
}

// Body (OpenAI chat.completions)
{
  model: string,           // e.g. "gpt-5.6-terra"
  messages: [...],
  tools?: object[],
  temperature?: number,    // default 0.2
  max_tokens?: number,     // from settings.maxTokens when omitted
  stream: false,
}
```

**Response:** native OpenAI `chat.completion` JSON (passed through). `finalizeChatCompletion()` may still normalize embedded reasoning blocks in `message.content`.

**Timeout:** 180 s (`REMOTE_LLM_FETCH_TIMEOUT_MS`).

### Thinking

The Settings “Enable model reasoning” toggle is **disabled** for OpenAI. Reasoning models on the OpenAI API use `reasoning_effort`; this extension does **not** send that field. Curated catalog entries mark GPT-5.6 models as `thinking: true` for display only.

### Auth & settings

| Setting | Value |
|---------|-------|
| `settings.provider` | `"openai"` |
| `settings.apiKeys.openai` | OpenAI API key (`sk-…`) |
| `settings.model` | Model id (default `gpt-5.6-terra`) |
| `settings.baseUrl` | Optional; defaults to `https://api.openai.com/v1` |

Curated flagship catalog: [`openai-models.js`](../browser-agent/openai-models.js) (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`). Alias `gpt-5.6` resolves to `gpt-5.6-sol` via `resolveOpenAiModel()`.

No local model load/unload. No prompt-preview API. RAG embeddings use `POST /v1/embeddings` when `ragEmbedProvider` is `openai` or `auto` with OpenAI chat (default model: `text-embedding-3-small`).

### OpenAI-compatible / custom

`settings.provider === "openai-compatible"` uses the **same** `openaiChatCompletions` handler:

| Aspect | Detail |
|--------|--------|
| Base URL | **Required** — user-supplied (e.g. `http://localhost:8080/v1`, Azure OpenAI, LiteLLM proxy) |
| API key | Optional — sent as `Authorization: Bearer …` when `settings.apiKeys["openai-compatible"]` is set |
| Body | Same OpenAI `chat.completions` shape |
| Thinking toggle | Disabled — no `thinkingEnabled` mapping for custom endpoints |

`buildOpenAiCompatibleBody()` only injects NIM-specific `chat_template_kwargs` when the provider or base URL is NVIDIA NIM; OpenAI and openai-compatible requests are unchanged.

---

## 5. NVIDIA NIM (remote)

**Stack:** OpenAI-compatible HTTPS API. Fixed endpoint: `https://integrate.api.nvidia.com/v1` ([`llm-providers.js`](../browser-agent/llm-providers.js)).

Uses the same code path as `openai` and `openai-compatible` providers (`openaiChatCompletions`). See [§4 OpenAI](#4-openai-remote) for the shared wire format; NIM adds `chat_template_kwargs` for thinking on select model families (below).

### Chat completions

`POST https://integrate.api.nvidia.com/v1/chat/completions`

```js
// Headers
{
  "Content-Type": "application/json",
  "Authorization": "Bearer <nvapi-…>"   // required
}

// Body (OpenAI chat.completions)
{
  model: string,           // e.g. "z-ai/glm-5.2"
  messages: [...],
  tools?: object[],
  temperature?: number,
  max_tokens?: number,
  stream?: false,
  chat_template_kwargs?: { ... }  // NIM-specific thinking (see below)
}
```

**Timeout:** 180 s (`REMOTE_LLM_FETCH_TIMEOUT_MS`). Large models (GLM-5.2, Nemotron 550B) may need the full window.

### Thinking (NIM-specific)

`buildOpenAiCompatibleBody()` maps `thinkingEnabled` → `chat_template_kwargs` for supported models:

| Model family | `chat_template_kwargs` |
|--------------|------------------------|
| GLM (`glm`, `z-ai/`) | `{ enable_thinking, clear_thinking: false }` |
| Qwen3 | `{ enable_thinking }` |
| DeepSeek | `{ enable_thinking, thinking }` |

Other NIM models ignore thinking control. Curated model list: [`nvidia-nim-models.js`](../browser-agent/nvidia-nim-models.js).

### Auth & settings

| Setting | Value |
|---------|-------|
| `settings.provider` | `"nvidia-nim"` |
| `settings.apiKeys["nvidia-nim"]` | NVIDIA API key (`nvapi-…`) |
| `settings.model` | NIM model id (default `z-ai/glm-5.2`) |
| `settings.baseUrl` | Overridden to integrate endpoint |

No local model load/unload. No prompt-preview API. RAG embeddings use OpenAI-compatible `POST /v1/embeddings` when `ragEmbedProvider` is `nvidia-nim` or `auto` with NIM chat.

---

## 6. Google Gemini (remote)

**Stack:** Google AI `generateContent` REST API. Fixed endpoint: `https://generativelanguage.googleapis.com/v1beta` ([`llm-providers.js`](../browser-agent/llm-providers.js), [`gemini-models.js`](../browser-agent/gemini-models.js)).

Uses a dedicated adapter (`geminiChatCompletions`) that translates the internal OpenAI chat shape to Gemini `contents` / `systemInstruction` and back via `toGeminiContents()` / `geminiChatCompletionFromBody()`.

### Chat completions

`POST {baseUrl}/models/{model}:generateContent`

```js
// Headers
{
  "Content-Type": "application/json",
  "x-goog-api-key": "<AIza…>"   // required (not Authorization: Bearer)
}

// Body (Gemini generateContent — model id is in the URL path, not the JSON body)
{
  contents: [{ role: "user" | "model", parts: [...] }],
  systemInstruction?: { parts: [{ text: string }] },
  tools?: [{ functionDeclarations: [...] }],   // from toGeminiTools()
  toolConfig?: { functionCallingConfig: { mode: "AUTO" } },
  generationConfig: {
    temperature?: number,
    maxOutputTokens?: number,
    thinkingConfig?: { includeThoughts: boolean, thinkingBudget: number },
  },
}
```

**Message mapping:**

| Internal role | Gemini wire |
|---------------|-------------|
| `system` | `systemInstruction.parts[].text` (concatenated) |
| `user` | `contents[]` with `role: "user"`, `parts: [{ text }]` |
| `assistant` | `contents[]` with `role: "model"`; text + `functionCall` parts for tool calls |
| `tool` | `contents[]` with `role: "user"`, `parts: [{ functionResponse }]` |

**Response translation** (`geminiChatCompletionFromBody`):

- Text parts → `message.content`
- Parts with `thought: true` → `message.reasoning`
- `functionCall` parts → `message.tool_calls` (OpenAI shape)
- `finishReason: "MAX_TOKENS"` → `finish_reason: "length"`
- `usageMetadata` → `usage.prompt_tokens` / `completion_tokens` / `total_tokens`

**Timeout:** 180 s (`REMOTE_LLM_FETCH_TIMEOUT_MS`).

### Thinking (Gemini-specific)

`buildGeminiGenerationConfig()` maps `thinkingEnabled` → `generationConfig.thinkingConfig` when `geminiModelSupportsThinking(model)` is true (curated entries + heuristic `/gemini-(2\.5|3)/`):

| Setting | `thinkingConfig` |
|---------|------------------|
| `enableThinking !== false` | `{ includeThoughts: true, thinkingBudget: -1 }` (dynamic thinking) |
| `enableThinking === false` | `{ includeThoughts: false, thinkingBudget: 0 }` |

Thought text is returned in response parts with `thought: true` and normalized to `message.reasoning`. Older Gemini models omit `thinkingConfig`.

### Model catalog & migration

| Source | API | Purpose |
|--------|-----|---------|
| Curated list | — | [`GEMINI_MODELS`](../browser-agent/gemini-models.js) in Settings (pricing, I/O, thinking flags) |
| Live discovery | `GET {baseUrl}/models?key=…&pageSize=100` | `fetchGeminiModelsFromApi()` — merges models that support `generateContent` |
| Deprecation map | — | `DEPRECATED_GEMINI_MODELS` + `resolveGeminiModel()` remap retired ids (e.g. `gemini-2.5-flash-lite` → `gemini-3.5-flash-lite`) |

Default model: `gemini-3.5-flash-lite` (`DEFAULT_GEMINI_MODEL`).

### Auth & settings

| Setting | Value |
|---------|-------|
| `settings.provider` | `"gemini"` |
| `settings.apiKeys.gemini` | Google AI API key (`AIza…` from [Google AI Studio](https://aistudio.google.com/apikey)) |
| `settings.model` | Gemini model id (resolved via `resolveGeminiModel()`) |
| `settings.baseUrl` | Overridden to `GEMINI_API_BASE_URL` |

No local model load/unload. No prompt-preview API. RAG embeddings use `batchEmbedContents` when `ragEmbedProvider` is `gemini` or `auto` with Gemini chat (default model: `text-embedding-004`).

---

## Comparison

| | ONNX | WebLLM | Ollama | OpenAI | NVIDIA NIM | Gemini |
|---|------|--------|--------|--------|------------|--------|
| **Location** | Browser (offscreen) | Browser (offscreen) | Local HTTP server | Cloud HTTPS | Cloud HTTPS | Cloud HTTPS |
| **Wire API** | Extension IPC → Transformers.js | Extension IPC → MLC OpenAI client | `/v1/chat/completions` or `/api/chat` | `/v1/chat/completions` | `/v1/chat/completions` | `/v1beta/models/{model}:generateContent` |
| **Internal chat schema** | OpenAI | OpenAI | OpenAI (translated on fallback) | OpenAI (passthrough) | OpenAI (+ NIM kwargs) | OpenAI (translated) |
| **Auth** | None | None | None (CORS) | `Bearer sk-…` | `Bearer nvapi-…` | `x-goog-api-key` |
| **Streaming** | No | No | No | No | No | No |
| **Tools** | Yes (template + generate) | Yes (subset of models) | Yes | Yes | Yes | Yes (`functionDeclarations`) |
| **Thinking flag** | `enable_thinking` (Qwen3, Gemma 4) | `extra_body.enable_thinking` (Qwen3) | `think` | Not sent (`reasoning_effort` unsupported) | `chat_template_kwargs` | `thinkingConfig` |
| **Prompt preview** | `chat.renderPrompt` | No | `_debug_render_only` | No | No | No |
| **Embeddings** | `engine.run` feature-extraction | `embeddings.create` | `POST /api/embed` | `POST /v1/embeddings` (RAG) | `POST /v1/embeddings` (RAG) | `batchEmbedContents` (RAG) |
| **Multimodal chat** | Gemma 4, Ministral VLMs | Vision models in MLC list | Model-dependent | Catalog lists image input; text-only wire path today | Nemotron VL (remote) | Catalog lists image/video/audio/PDF; text-only wire path today |
| **Device** | WebGPU or WASM | WebGPU only | Server GPU/CPU | OpenAI cloud | NVIDIA cloud | Google cloud |

`openai-compatible` matches the **OpenAI** column except base URL is user-supplied and the API key is optional.

---

## Related code

| File | Role |
|------|------|
| [`llm.js`](../browser-agent/llm.js) | Unified `chatCompletions`, provider adapters |
| [`llm-providers.js`](../browser-agent/llm-providers.js) | Provider ids, base URLs, thinking hints, per-provider API keys |
| [`engine.js`](../browser-agent/engine.js) | ONNX / Transformers.js engine |
| [`ort-worker.js`](../browser-agent/ort-worker.js) | ONNX worker message dispatch |
| [`webllm-engine.js`](../browser-agent/webllm-engine.js) | WebLLM / MLCEngine |
| [`webllm-worker.js`](../browser-agent/webllm-worker.js) | WebLLM worker message dispatch |
| [`ollama-models.js`](../browser-agent/ollama-models.js) | Ollama HTTP helpers (pull, tags, embed) |
| [`embed-models.js`](../browser-agent/embed-models.js) | Curated remote embedding model lists |
| [`openai-models.js`](../browser-agent/openai-models.js) | Curated OpenAI flagship model list |
| [`nvidia-nim-models.js`](../browser-agent/nvidia-nim-models.js) | Curated NIM model list |
| [`gemini-models.js`](../browser-agent/gemini-models.js) | Curated Gemini model list, live `models.list`, deprecation migration |
| [`reasoning-content.js`](../browser-agent/reasoning-content.js) | Cross-provider reasoning normalization |
| [`tools/schema.js`](../browser-agent/dialogue/tools/schema.js) | OpenAI tool schema utilities |

## Related docs

- [chat-input-processing.md](./chat-input-processing.md) — chat template rendering (ONNX vs Ollama)
- [model-reasoning-display.md](./model-reasoning-display.md) — thinking/reasoning per provider
- [llm-context-limits.md](./llm-context-limits.md) — context window handling
- [rag.md](./rag.md) — embedding provider selection
