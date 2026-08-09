// WebLLM chat engine: MLCEngine lifecycle and OpenAI-shaped chat.completions.
// Runs inside webllm-worker.js (Dedicated Worker).

import { resolveMaxTokens } from "./agent-config.js";
import { estimateChatTokens, trimChatMessagesForContext } from "./context-trim.js";
import { isQwen3ThinkingModel } from "./reasoning-content.js";
import { enrichWebllmRegistryEntry, isWebllmToolModel } from "./webllm-models.js";

const VENDOR_DIR = "vendor/webllm/";

/** Default when onboarding or no model is picked. */
export const DEFAULT_WEBLLM_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

/** @typedef {{ id: string, label: string, approxSizeMB: number, tier: string, contextWindow: number, quant?: string, lowResource?: boolean, supportsThinking?: boolean, supportsTools?: boolean, supportsVision?: boolean, io?: string }} RegistryEntry */

/** Populated from prebuiltAppConfig on first engine access. */
/** @type {RegistryEntry[]|null} */
let modelRegistryCache = null;

let webllmModule = null;
/** @type {import("@mlc-ai/web-llm").MLCEngine | null} */
let engine = null;
let loadedModelId = null;
let loadedEmbedModelId = null;
/** @type {"webgpu"|"unavailable"|null} */
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

async function loadWebLLM() {
  if (!webllmModule) {
    webllmModule = await import(vendorUrl("webllm.min.js"));
  }
  return webllmModule;
}

function appConfig(webllm) {
  return { ...webllm.prebuiltAppConfig, cacheBackend: "indexeddb" };
}

/** @type {RegistryEntry[]|null} */
let embedRegistryCache = null;

/** Embedding-only builds are not chat models. */
function isEmbedModelRecord(m) {
  return m?.model_type === "embedding" || (/embed/i.test(m?.model_id || "") && m?.model_type !== "vlm");
}

function isChatModel(modelId) {
  return !/embed/i.test(modelId);
}

function buildEmbedRegistry(webllm) {
  return webllm.prebuiltAppConfig.model_list
    .filter((m) => isEmbedModelRecord(m))
    .map((m) => ({
      id: m.model_id,
      label: humanizeModelId(m.model_id),
      approxSizeMB: Math.round(m.vram_required_MB),
      tier: tierForVram(m.vram_required_MB),
    }))
    .sort((a, b) => a.approxSizeMB - b.approxSizeMB || a.id.localeCompare(b.id));
}

export async function getEmbedModelRegistry() {
  if (embedRegistryCache) return embedRegistryCache;
  const webllm = await loadWebLLM();
  embedRegistryCache = buildEmbedRegistry(webllm);
  console.log(`[webllm] embed registry: ${embedRegistryCache.length} models`);
  return embedRegistryCache;
}

export const DEFAULT_WEBLLM_EMBED_MODEL = "snowflake-arctic-embed-s-q0f32-MLC-b4";

function tierForVram(vramMB) {
  if (vramMB < 2000) return "fast";
  if (vramMB < 5500) return "default";
  return "max";
}

function quantLabel(modelId) {
  const m = modelId.match(/-(q4f16_1|q4f32_1|q0f16|q0f32|q3f16_1)(?:-1k)?-MLC$/);
  return m ? m[1] : "";
}

function humanizeModelId(modelId) {
  const base = modelId
    .replace(/-(q4f16_1|q4f32_1|q0f16|q0f32|q3f16_1)(?:-1k)?-MLC$/, "")
    .replace(/-/g, " ");
  const quant = quantLabel(modelId);
  const shortCtx = /-1k-MLC$/.test(modelId) ? " · 1k ctx" : "";
  return quant ? `${base} (${quant})${shortCtx}` : base;
}

function buildRegistry(webllm) {
  const functionCallingModelIds = webllm.functionCallingModelIds || [];
  return webllm.prebuiltAppConfig.model_list
    .filter((m) => isChatModel(m.model_id))
    .map((m) =>
      enrichWebllmRegistryEntry(
        {
          id: m.model_id,
          label: humanizeModelId(m.model_id),
          approxSizeMB: Math.round(m.vram_required_MB),
          tier: tierForVram(m.vram_required_MB),
          contextWindow: m.overrides?.context_window_size ?? 4096,
          quant: quantLabel(m.model_id),
          lowResource: !!m.low_resource_required,
        },
        { functionCallingModelIds }
      )
    )
    .sort((a, b) => a.approxSizeMB - b.approxSizeMB || a.id.localeCompare(b.id));
}

export async function getModelRegistry() {
  if (modelRegistryCache) return modelRegistryCache;
  const webllm = await loadWebLLM();
  modelRegistryCache = buildRegistry(webllm);
  console.log(`[webllm] registry: ${modelRegistryCache.length} chat models from prebuiltAppConfig`);
  return modelRegistryCache;
}

async function registryEntry(modelId) {
  const registry = await getModelRegistry();
  return registry.find((m) => m.id === modelId) || null;
}

async function isKnownModel(modelId) {
  if (!modelId || !isChatModel(modelId)) return false;
  const webllm = await loadWebLLM();
  return webllm.prebuiltAppConfig.model_list.some((m) => m.model_id === modelId);
}

/** @deprecated Use getModelRegistry() — kept for imports that expect MODEL_REGISTRY. */
export const MODEL_REGISTRY = [];

export async function modelsForTask() {
  return getModelRegistry();
}

async function probeDevice() {
  if (device) return device;
  if (!navigator.gpu) {
    device = "unavailable";
    return device;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    device = adapter ? "webgpu" : "unavailable";
  } catch {
    device = "unavailable";
  }
  return device;
}

function broadcastProgress(event) {
  chrome.runtime.sendMessage({ target: "webllm-progress", ...event }).catch(() => {});
}

function markDownloaded(modelId) {
  chrome.runtime.sendMessage({ target: "webllm-model-ready", model: modelId }).catch(() => {});
}

function requestPeerUnload(peer, msg) {
  self.postMessage({ type: "engine.unloadPeer", peer, msg });
}

async function ensureEngine() {
  const probed = await probeDevice();
  if (probed === "unavailable") {
    throw new Error("WebGPU is required for WebLLM. Use Chrome/Edge 113+ or Safari 18+ with WebGPU enabled.");
  }
  if (engine) return engine;

  const webllm = await loadWebLLM();
  const { MLCEngine } = webllm;
  engine = new MLCEngine({ appConfig: appConfig(webllm) });
  engine.setInitProgressCallback((report) => {
    const pct = typeof report.progress === "number" ? Math.round(report.progress * 100) : 0;
    broadcastProgress({
      file: report.text || "loading",
      status: "downloading",
      progress: report.progress,
      loaded: pct,
      total: 100,
      model: loadedModelId,
    });
  });
  return engine;
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

export async function status() {
  const probed = await probeDevice();
  const registry = await getModelRegistry();
  let cachedModels = [];
  try {
    const webllm = await loadWebLLM();
    const cfg = appConfig(webllm);
    cachedModels = (
      await Promise.all(registry.map(async (m) => ((await webllm.hasModelInCache(m.id, cfg)) ? m.id : null)))
    ).filter(Boolean);
  } catch {
    // vendor may not be loaded yet
  }

  return {
    device: probed,
    loadedModel: loadedModelId,
    loadedEmbedModel: loadedEmbedModelId,
    loaded: [
      ...(loadedModelId ? [{ task: "text-generation", model: loadedModelId }] : []),
      ...(loadedEmbedModelId ? [{ task: "feature-extraction", model: loadedEmbedModelId }] : []),
    ],
    busy,
    registry,
    cacheBackend: "indexeddb",
    cachedModels,
  };
}

export async function unload() {
  if (engine) {
    try {
      await engine.unload();
    } catch (err) {
      console.warn("[webllm] unload:", err);
    }
  }
  loadedModelId = null;
  loadedEmbedModelId = null;
  return status();
}

/**
 * MLCEngine.reload() always unloads everything before loading the given set
 * (see vendor bundle), so the chat model and the embedding model must be
 * reloaded together as one array — otherwise loading one silently evicts the
 * other even though `loadedModelId`/`loadedEmbedModelId` still claim it's resident.
 */
async function reloadModelSet({ chatModelId, embedModelId } = {}) {
  const eng = await ensureEngine();
  const targetChat = chatModelId !== undefined ? chatModelId : loadedModelId;
  const targetEmbed = embedModelId !== undefined ? embedModelId : loadedEmbedModelId;
  const ids = [...new Set([targetChat, targetEmbed].filter(Boolean))];
  if (!ids.length) {
    await eng.unload();
    loadedModelId = null;
    loadedEmbedModelId = null;
    return;
  }
  try {
    await eng.reload(ids);
  } catch (err) {
    // reload() unloads everything before loading the new set, so a failure
    // partway through leaves actual engine state unknown — don't let stale
    // tracking vars claim a model is resident when it may not be.
    loadedModelId = null;
    loadedEmbedModelId = null;
    throw err;
  }
  loadedModelId = targetChat || null;
  loadedEmbedModelId = targetEmbed || null;
}

export async function clearCache() {
  const webllm = await loadWebLLM();
  const cfg = appConfig(webllm);
  const registry = await getModelRegistry();
  for (const m of registry) {
    try {
      if (await webllm.hasModelInCache(m.id, cfg)) {
        await webllm.deleteModelInCache(m.id, cfg);
      }
    } catch (err) {
      console.warn(`[webllm] clearCache ${m.id}:`, err);
    }
  }
  return status();
}

export async function deleteModel(modelId) {
  if (!modelId) {
    return { error: { message: "engine.deleteModel requires a model id", type: "engine_error", code: null } };
  }
  if (loadedModelId === modelId) await reloadModelSet({ chatModelId: null });
  if (loadedEmbedModelId === modelId) await reloadModelSet({ embedModelId: null });
  const webllm = await loadWebLLM();
  try {
    await webllm.deleteModelInCache(modelId, appConfig(webllm));
  } catch (err) {
    return { error: { message: String(err?.message || err), type: "engine_error", code: null } };
  }
  return status();
}

export async function loadModel(modelId) {
  if (!modelId) throw new Error("No model specified.");
  if (!(await isKnownModel(modelId))) {
    throw new Error(`Unknown WebLLM model "${modelId}". Pick a model from Settings.`);
  }

  if (loadedModelId === modelId) return status();

  requestPeerUnload("onnx-engine", { type: "engine.unloadLlm" });

  console.log(`[webllm] loading ${modelId} on WebGPU`);
  try {
    await reloadModelSet({ chatModelId: modelId });
  } catch (err) {
    loadedModelId = null;
    throw err;
  }

  markDownloaded(modelId);
  broadcastProgress({ status: "ready", model: modelId, file: modelId, progress: 1, loaded: 100, total: 100 });
  console.log(`[webllm] ${modelId} ready`);
  return status();
}

export async function getContextEstimate(modelId) {
  const entry = await registryEntry(modelId);
  if (!entry) {
    return { modelId, error: { message: `Unknown model "${modelId}"`, type: "engine_error" } };
  }
  return {
    modelId,
    trainedMaxContext: entry.contextWindow,
    effectiveMaxContext: entry.contextWindow,
    bindingConstraint: null,
    device: "webgpu",
    caveats: [
      "Context window from the MLC prebuiltAppConfig entry.",
      "WebGPU required; no WASM/CPU fallback for WebLLM chat.",
      "Vision/audio tools still use the ONNX engine.",
    ],
  };
}

async function ensureLoaded(modelId) {
  if (!modelId) return errorResponse("No model specified.", "model_not_loaded");
  if (loadedModelId !== modelId) {
    try {
      await loadModel(modelId);
    } catch (err) {
      return errorResponse(String(err?.message || err), "download_failed");
    }
  }
  if (!engine || loadedModelId !== modelId) {
    return errorResponse(`Failed to load model "${modelId}".`, "model_not_loaded");
  }
  return null;
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
    const entry = await registryEntry(modelId);
    const contextLimit = entry?.contextWindow ?? 4096;
    const tools =
      Array.isArray(request.tools) && request.tools.length && isWebllmToolModel(modelId)
        ? request.tools
        : undefined;

    const trim = trimChatMessagesForContext(request.messages, tools, contextLimit, maxTokens);
    if (trim.trimmed) {
      console.warn(
        `[webllm] trimmed prompt for ${modelId}: dropped ${trim.droppedTurns} older turn(s); ` +
          `~${trim.estimatedTokens}/${trim.budget} tokens (context ${contextLimit})`
      );
    }

    const body = {
      model: modelId,
      messages: trim.messages,
      stream: false,
      temperature: request.temperature ?? 0.2,
      max_tokens: maxTokens,
    };
    if (tools?.length) body.tools = tools;
    if (isQwen3ThinkingModel(modelId)) {
      body.extra_body = { enable_thinking: request.thinkingEnabled !== false };
    }

    const completion = await engine.chat.completions.create(body);
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
    console.error(`[webllm] chat failed for ${modelId}:`, message);
    if (/context window|ContextWindowSizeExceeded/i.test(message)) {
      const entry = await registryEntry(modelId);
      const contextLimit = entry?.contextWindow ?? 4096;
      const est = estimateChatTokens(request.messages, request.tools);
      return errorResponse(
        `Prompt is too long for WebLLM (~${est.toLocaleString()} tokens estimated; ` +
          `model limit ${contextLimit.toLocaleString()}). Start a new chat, unpin RAG documents, ` +
          "or switch to the ONNX/Ollama provider for larger context.",
        "context_exceeded"
      );
    }
    if (/device lost|out of memory|oom/i.test(message)) {
      loadedModelId = null;
      try {
        await engine?.unload();
      } catch {
        /* best-effort */
      }
      return errorResponse(
        `${message} Try a smaller model, unload other GPU apps, or switch to the ONNX provider.`,
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

async function isKnownEmbedModel(modelId) {
  if (!modelId) return false;
  const registry = await getEmbedModelRegistry();
  return registry.some((m) => m.id === modelId);
}

async function ensureEmbedLoaded(modelId) {
  if (!modelId) return errorResponse("No embedding model specified.", "model_not_loaded");
  if (!(await isKnownEmbedModel(modelId))) {
    return errorResponse(`Unknown WebLLM embedding model "${modelId}".`, "model_not_loaded");
  }
  if (loadedEmbedModelId !== modelId) {
    try {
      await reloadModelSet({ embedModelId: modelId });
      markDownloaded(modelId);
    } catch (err) {
      loadedEmbedModelId = null;
      return errorResponse(String(err?.message || err), "download_failed");
    }
  }
  if (!engine) return errorResponse("WebLLM engine not ready.", "engine_error");
  return null;
}

async function runCreateEmbeddings(request) {
  const modelId = request?.model;
  const loadErr = await ensureEmbedLoaded(modelId);
  if (loadErr) return loadErr;

  const input = request?.input;
  if (input == null || (Array.isArray(input) && input.length === 0)) {
    return errorResponse("No input provided for embeddings.", "engine_error");
  }

  busy = true;
  try {
    const res = await engine.embeddings.create({ model: modelId, input });
    const data = res?.data || [];
    return {
      model: modelId,
      embeddings: data.map((d) => ({ embedding: d.embedding, index: d.index })),
      dims: data[0]?.embedding?.length ?? 0,
    };
  } catch (err) {
    return errorResponse(String(err?.message || err), "engine_error");
  } finally {
    busy = false;
  }
}

export function createEmbeddings(request) {
  return enqueue(() => runCreateEmbeddings(request));
}
