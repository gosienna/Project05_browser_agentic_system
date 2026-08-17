// Wllama chat engine: GGUF via llama.cpp WASM. OpenAI-shaped chat.completions.
// Runs inside wllama-worker.js (Dedicated Worker). Wllama spawns its own nested wasm worker.

import { resolveMaxTokens } from "./agent-config.js";
import { estimateChatTokens, trimChatMessagesForContext } from "./context-trim.js";
import {
  DEFAULT_WLLAMA_MODEL,
  isWllamaToolModel,
  resolveWllamaModelEntry,
  WLLAMA_MODEL_REGISTRY,
} from "./wllama-models.js";

const VENDOR_DIR = "vendor/wllama/";

export { DEFAULT_WLLAMA_MODEL };

let wllamaModule = null;
/** @type {import("@wllama/wllama").Wllama | null} */
let wllama = null;
let loadedModelId = null;
/** @type {"webgpu"|"wasm"|null} */
let device = null;
let busy = false;
let queue = Promise.resolve();

function vendorUrl(file) {
  const path = VENDOR_DIR + file;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(path, self.location.href).href;
}

async function loadWllamaModule() {
  if (!wllamaModule) {
    wllamaModule = await import(vendorUrl("wllama.min.js"));
  }
  return wllamaModule;
}

function broadcastProgress(event) {
  chrome.runtime.sendMessage({ target: "wllama-progress", ...event }).catch(() => {});
}

function markDownloaded(modelId) {
  chrome.runtime.sendMessage({ target: "wllama-model-ready", model: modelId }).catch(() => {});
}

function requestPeerUnload(peer, msg) {
  self.postMessage({ type: "engine.unloadPeer", peer, msg });
}

async function probeDevice() {
  if (device) return device;
  if (!navigator.gpu) {
    device = "wasm";
    return device;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    device = adapter ? "webgpu" : "wasm";
  } catch {
    device = "wasm";
  }
  return device;
}

async function ensureInstance() {
  if (wllama) return wllama;
  const mod = await loadWllamaModule();
  const { Wllama, LoggerWithoutDebug } = mod;
  wllama = new Wllama(
    { default: vendorUrl("wllama.wasm") },
    { logger: LoggerWithoutDebug, parallelDownloads: 4, allowOffline: true }
  );
  return wllama;
}

function errorResponse(message, type) {
  return { error: { message, type, code: null } };
}

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

export async function getModelRegistry() {
  return WLLAMA_MODEL_REGISTRY.slice();
}

export async function modelsForTask() {
  return getModelRegistry();
}

export async function status() {
  const probed = await probeDevice();
  const registry = await getModelRegistry();
  let cachedModels = [];
  try {
    const inst = await ensureInstance();
    const models = await inst.cacheManager.list();
    cachedModels = (models || [])
      .map((m) => {
        const hay = `${m?.name || ""} ${m?.metadata?.originalURL || ""}`;
        const hit = registry.find((r) => hay.includes(r.file) || hay.includes(r.repo));
        return hit?.id || null;
      })
      .filter(Boolean);
    // Also include currently loaded model.
    if (loadedModelId && !cachedModels.includes(loadedModelId)) cachedModels.push(loadedModelId);
  } catch {
    if (loadedModelId) cachedModels = [loadedModelId];
  }

  return {
    device: probed,
    loadedModel: loadedModelId,
    loaded: loadedModelId ? [{ task: "text-generation", model: loadedModelId }] : [],
    busy,
    registry,
    cacheBackend: "indexeddb",
    cachedModels: [...new Set(cachedModels)],
    multithread: wllama?.isModelLoaded?.() ? wllama.isMultithread() : null,
  };
}

export async function unload() {
  if (wllama) {
    try {
      await wllama.exit();
    } catch (err) {
      console.warn("[wllama] unload/exit:", err);
    }
    wllama = null;
  }
  loadedModelId = null;
  return status();
}

export async function clearCache() {
  try {
    const inst = await ensureInstance();
    await inst.cacheManager.clear();
  } catch (err) {
    console.warn("[wllama] clearCache:", err);
  }
  if (loadedModelId) {
    try {
      await wllama?.exit();
    } catch {
      /* best-effort */
    }
    wllama = null;
    loadedModelId = null;
  }
  return status();
}

export async function deleteModel(modelId) {
  if (!modelId) {
    return { error: { message: "engine.deleteModel requires a model id", type: "engine_error", code: null } };
  }
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) {
    return { error: { message: `Unknown wllama model "${modelId}"`, type: "engine_error", code: null } };
  }
  if (loadedModelId === modelId) {
    await unload();
  }
  try {
    const inst = await ensureInstance();
    const cached = await inst.cacheManager.list();
    for (const item of cached || []) {
      const hay = `${item?.name || ""} ${item?.metadata?.originalURL || ""}`;
      if (hay.includes(entry.file) || hay.includes(entry.repo)) {
        try {
          await inst.cacheManager.delete(item.name);
        } catch (err) {
          console.warn("[wllama] delete cache entry:", err);
        }
      }
    }
  } catch (err) {
    return { error: { message: String(err?.message || err), type: "engine_error", code: null } };
  }
  return status();
}

function loadParamsForEntry(entry, probed) {
  const n_ctx = Math.min(entry.contextWindow || 4096, 8192);
  /** @type {Record<string, unknown>} */
  const params = {
    n_ctx,
    jinja: true,
    progressCallback: ({ loaded, total }) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      broadcastProgress({
        file: entry.file,
        status: "downloading",
        progress: total ? loaded / total : 0,
        loaded: pct,
        total: 100,
        model: entry.id,
      });
    },
  };
  // Offload all layers when WebGPU is available; 0 forces CPU/WASM.
  if (probed === "webgpu") {
    params.n_gpu_layers = 999;
  } else {
    params.n_gpu_layers = 0;
  }
  return params;
}

function hfResolveUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

function isMissingCacheError(err) {
  return /Model file not found/i.test(String(err?.message || err));
}

async function loadGgufIntoEngine(inst, entry, probed, { useCache = true } = {}) {
  const params = { ...loadParamsForEntry(entry, probed), useCache };
  const url = hfResolveUrl(entry.repo, entry.file);
  // Prefer direct URL load — avoids HF tree-API + cache key mismatches on large GGUFs.
  await inst.loadModelFromUrl(url, params);
}

export async function loadModel(modelId) {
  if (!modelId) throw new Error("No model specified.");
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) {
    throw new Error(`Unknown wllama model "${modelId}". Use repo::file.gguf or pick from Settings.`);
  }

  if (loadedModelId === modelId && wllama?.isModelLoaded?.()) return status();

  requestPeerUnload("onnx-engine", { type: "engine.unloadLlm" });
  requestPeerUnload("webllm-engine", { type: "engine.unload" });

  // Switching models: tear down previous instance (single context).
  if (wllama?.isModelLoaded?.()) {
    try {
      await wllama.exit();
    } catch (err) {
      console.warn("[wllama] exit before reload:", err);
    }
    wllama = null;
    loadedModelId = null;
  }

  const probed = await probeDevice();
  const inst = await ensureInstance();
  console.log(`[wllama] loading ${entry.repo}/${entry.file} on ${probed}`);

  try {
    try {
      await loadGgufIntoEngine(inst, entry, probed, { useCache: true });
    } catch (err) {
      if (!isMissingCacheError(err)) throw err;
      // Stale/partial IndexedDB cache after an interrupted multi-GB download.
      console.warn("[wllama] cache miss after download; purging and retrying:", err?.message || err);
      try {
        await inst.cacheManager.delete(hfResolveUrl(entry.repo, entry.file));
      } catch (delErr) {
        console.warn("[wllama] cache delete:", delErr);
      }
      try {
        await inst.exit();
      } catch {
        /* best-effort */
      }
      wllama = null;
      const retry = await ensureInstance();
      await loadGgufIntoEngine(retry, entry, probed, { useCache: false });
    }
  } catch (err) {
    loadedModelId = null;
    try {
      await (wllama || inst)?.exit?.();
    } catch {
      /* best-effort */
    }
    wllama = null;
    const msg = String(err?.message || err);
    if (isMissingCacheError(err) || /Failed to fetch|HTTP 40[34]/i.test(msg)) {
      throw new Error(
        `${msg} — Clear wllama cache in Settings and retry. Multi-GB GGUFs need a stable network; ` +
          `prefer Qwen3 0.6B/1.7B if downloads keep failing.`
      );
    }
    throw err;
  }

  loadedModelId = entry.id;
  markDownloaded(entry.id);
  broadcastProgress({
    status: "ready",
    model: entry.id,
    file: entry.file,
    progress: 1,
    loaded: 100,
    total: 100,
  });
  console.log(`[wllama] ${entry.id} ready (multithread=${wllama?.isMultithread?.()})`);
  return status();
}

export async function getContextEstimate(modelId) {
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) {
    return { modelId, error: { message: `Unknown model "${modelId}"`, type: "engine_error" } };
  }
  const probed = await probeDevice();
  return {
    modelId,
    trainedMaxContext: entry.contextWindow,
    effectiveMaxContext: entry.contextWindow,
    bindingConstraint: null,
    device: probed,
    caveats: [
      "Context window from the curated wllama registry (or 4K default for custom GGUF).",
      "Wllama uses Memory64 WASM (not the ONNX wasm32 4GB heap cap).",
      "WebGPU offload used when available; otherwise CPU/WASM.",
      "Vision/audio tools still use the ONNX engine.",
    ],
  };
}

async function ensureLoaded(modelId) {
  if (!modelId) return errorResponse("No model specified.", "model_not_loaded");
  if (!resolveWllamaModelEntry(modelId)) {
    return errorResponse(`Unknown wllama model "${modelId}".`, "model_not_loaded");
  }
  if (loadedModelId !== modelId || !wllama?.isModelLoaded?.()) {
    try {
      await loadModel(modelId);
    } catch (err) {
      return errorResponse(String(err?.message || err), "download_failed");
    }
  }
  if (!wllama || loadedModelId !== modelId) {
    return errorResponse(`Failed to load model "${modelId}".`, "model_not_loaded");
  }
  return null;
}

function sanitizeMessages(messages) {
  return (messages || []).map((m) => {
    const out = { role: m.role, content: m.content ?? "" };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
  });
}

async function runChatCompletions(request) {
  const modelId = request?.model;
  const loadErr = await ensureLoaded(modelId);
  if (loadErr) return loadErr;

  if (!Array.isArray(request?.messages)) {
    return errorResponse("messages must be an array.", "engine_error");
  }

  busy = true;
  try {
    const maxTokens = resolveMaxTokens(request.max_tokens);
    const entry = resolveWllamaModelEntry(modelId);
    const contextLimit = entry?.contextWindow ?? 4096;
    const tools =
      Array.isArray(request.tools) && request.tools.length && isWllamaToolModel(modelId)
        ? request.tools
        : undefined;

    const trim = trimChatMessagesForContext(request.messages, tools, contextLimit, maxTokens);
    if (trim.trimmed) {
      console.warn(
        `[wllama] trimmed prompt for ${modelId}: dropped ${trim.droppedTurns} older turn(s); ` +
          `~${trim.estimatedTokens}/${trim.budget} tokens (context ${contextLimit})`
      );
    }

    /** @type {Record<string, unknown>} */
    const body = {
      messages: sanitizeMessages(trim.messages),
      stream: false,
      temperature: request.temperature ?? 0.2,
      max_tokens: maxTokens,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = request.tool_choice || "auto";
    }

    const completion = await wllama.createChatCompletion(body);
    const choice = completion.choices?.[0];
    const message = choice?.message ?? { role: "assistant", content: "" };
    return {
      id: completion.id || `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: completion.created ?? Math.floor(Date.now() / 1000),
      model: completion.model || modelId,
      choices: [
        {
          index: 0,
          message,
          finish_reason: choice?.finish_reason ?? "stop",
        },
      ],
      usage: completion.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      ...(trim.trimmed
        ? {
            context_trimmed: {
              droppedTurns: trim.droppedTurns,
              estimatedTokens: trim.estimatedTokens,
              contextLimit,
            },
          }
        : {}),
    };
  } catch (err) {
    const message = String(err?.message || err);
    console.error(`[wllama] chat failed for ${modelId}:`, message);
    const type = err?.type || "";
    if (type === "kv_cache_full" || /kv_cache_full|context.*(full|exceed)/i.test(message)) {
      const entry = resolveWllamaModelEntry(modelId);
      const contextLimit = entry?.contextWindow ?? 4096;
      const est = estimateChatTokens(request.messages, request.tools);
      return errorResponse(
        `Prompt is too long for wllama (~${est.toLocaleString()} tokens estimated; ` +
          `context ${contextLimit.toLocaleString()}). Start a new chat or pick a larger-context model.`,
        "context_exceeded"
      );
    }
    if (/out of memory|oom|Failed to allocate/i.test(message)) {
      loadedModelId = null;
      try {
        await wllama?.exit();
      } catch {
        /* best-effort */
      }
      wllama = null;
      return errorResponse(
        `${message} Try a smaller GGUF, unload other models, or enable WebGPU.`,
        "oom"
      );
    }
    return errorResponse(message, "engine_error");
  } finally {
    busy = false;
  }
}

export function chatCompletions(request) {
  return enqueue(() => runChatCompletions(request));
}
