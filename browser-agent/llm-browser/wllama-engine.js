// Wllama chat engine: GGUF via llama.cpp WASM. OpenAI-shaped chat.completions.
// Runs inside wllama-worker.js (Dedicated Worker). Wllama spawns its own nested wasm worker.

import { resolveMaxTokens, resolveWllamaContextLimit } from "../llm-config.js";
import { estimateChatTokens, trimChatMessagesForContext } from "./context-trim.js";
import {
  DEFAULT_WLLAMA_MODEL,
  isWllamaToolModel,
  isWllamaVisionModel,
  resolveWllamaModelEntry,
  WLLAMA_MODEL_REGISTRY,
} from "./wllama-models.js";

const VENDOR_DIR = "llm-browser/vendor/wllama/";

export { DEFAULT_WLLAMA_MODEL };

let wllamaModule = null;
/** @type {import("@wllama/wllama").Wllama | null} */
let wllama = null;
let loadedModelId = null;
/** n_ctx used for the currently loaded GGUF (llama.cpp KV cache). */
let loadedNCtx = null;
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
        const hit = registry.find(
          (r) =>
            hay.includes(r.file) ||
            (r.mmprojFile && hay.includes(r.mmprojFile)) ||
            hay.includes(r.repo)
        );
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
    nCtx: loadedNCtx,
    loaded: loadedModelId
      ? [
          {
            task: isWllamaVisionModel(loadedModelId) ? "image-text-to-text" : "text-generation",
            model: loadedModelId,
          },
        ]
      : [],
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
  loadedNCtx = null;
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
    loadedNCtx = null;
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
      if (
        hay.includes(entry.file) ||
        (entry.mmprojFile && hay.includes(entry.mmprojFile)) ||
        hay.includes(entry.repo)
      ) {
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

function loadParamsForEntry(entry, probed, nCtx) {
  const n_ctx = resolveWllamaContextLimit(nCtx);
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
    if (entry.mmprojFile) params.mmproj_offload = true;
  } else {
    params.n_gpu_layers = 0;
    if (entry.mmprojFile) params.mmproj_offload = false;
  }
  return params;
}

function hfResolveUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

function isMissingCacheError(err) {
  return /Model file not found/i.test(String(err?.message || err));
}

function loadedModelHasImageInput(inst = wllama) {
  try {
    return !!inst?.supportInputModality?.("image");
  } catch {
    return false;
  }
}

function logLoadedModalities(inst, entry) {
  let info = null;
  try {
    info = inst?.getLoadedContextInfo?.() || null;
  } catch {
    info = null;
  }
  console.log(
    `[wllama] ${entry.id} modalities: has_image_input=${!!info?.has_image_input} ` +
      `has_audio_input=${!!info?.has_audio_input} media_marker=${info?.media_marker || "(none)"}`
  );
}

async function loadGgufIntoEngine(inst, entry, probed, { useCache = true, nCtx } = {}) {
  const params = { ...loadParamsForEntry(entry, probed, nCtx), useCache };
  /** @type {{ url: string, mmprojUrl?: string }} */
  const source = { url: hfResolveUrl(entry.repo, entry.file) };
  if (entry.mmprojFile) {
    source.mmprojUrl = hfResolveUrl(entry.repo, entry.mmprojFile);
  }
  // Prefer direct URL load — avoids HF tree-API + cache key mismatches on large GGUFs.
  await inst.loadModelFromUrl(source, params);
  logLoadedModalities(inst, entry);
  // Cached text-only GGUF can match by URL and skip the mmproj download.
  if (entry.mmprojFile && !loadedModelHasImageInput(inst)) {
    throw new Error("VISION_MMPROJ_MISSING");
  }
}

async function purgeCachedGgufs(inst, entry) {
  const urls = [hfResolveUrl(entry.repo, entry.file)];
  if (entry.mmprojFile) urls.push(hfResolveUrl(entry.repo, entry.mmprojFile));
  for (const url of urls) {
    try {
      await inst.cacheManager.delete(url);
    } catch (delErr) {
      console.warn("[wllama] cache delete:", delErr);
    }
  }
}

export async function loadModel(modelId, options = {}) {
  if (!modelId) throw new Error("No model specified.");
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) {
    throw new Error(`Unknown wllama model "${modelId}". Use repo::file.gguf or pick from Settings.`);
  }
  const nCtx = resolveWllamaContextLimit(options.nCtx);

  if (
    loadedModelId === modelId &&
    wllama?.isModelLoaded?.() &&
    loadedNCtx === nCtx &&
    (!entry.mmprojFile || loadedModelHasImageInput())
  ) {
    return status();
  }

  requestPeerUnload("onnx-engine", { type: "engine.unloadLlm" });
  requestPeerUnload("webllm-engine", { type: "engine.unload" });

  // Switching models or n_ctx: tear down previous instance (single context).
  if (wllama?.isModelLoaded?.()) {
    try {
      await wllama.exit();
    } catch (err) {
      console.warn("[wllama] exit before reload:", err);
    }
    wllama = null;
    loadedModelId = null;
    loadedNCtx = null;
  }

  const probed = await probeDevice();
  const inst = await ensureInstance();
  const mmprojNote = entry.mmprojFile ? ` + ${entry.mmprojFile}` : "";
  console.log(`[wllama] loading ${entry.repo}/${entry.file}${mmprojNote} on ${probed} n_ctx=${nCtx}`);

  try {
    try {
      await loadGgufIntoEngine(inst, entry, probed, { useCache: true, nCtx });
    } catch (err) {
      const missingMmproj = /VISION_MMPROJ_MISSING/.test(String(err?.message || err));
      if (!isMissingCacheError(err) && !missingMmproj) throw err;
      // Stale/partial IndexedDB cache, or a text-only cache entry from before mmproj was added.
      console.warn("[wllama] cache miss after download; purging and retrying:", err?.message || err);
      await purgeCachedGgufs(inst, entry);
      try {
        await inst.exit();
      } catch {
        /* best-effort */
      }
      wllama = null;
      const retry = await ensureInstance();
      await loadGgufIntoEngine(retry, entry, probed, { useCache: false, nCtx });
    }
  } catch (err) {
    loadedModelId = null;
    loadedNCtx = null;
    try {
      await (wllama || inst)?.exit?.();
    } catch {
      /* best-effort */
    }
    wllama = null;
    const msg = String(err?.message || err);
    if (/VISION_MMPROJ_MISSING/.test(msg)) {
      throw new Error(
        `Vision projector (mmproj) did not load for ${entry.id}. Clear wllama cache in Settings and reload the model.`
      );
    }
    if (isMissingCacheError(err) || /Failed to fetch|HTTP 40[34]/i.test(msg)) {
      throw new Error(
        `${msg} — Clear wllama cache in Settings and retry. Multi-GB GGUFs need a stable network; ` +
          `prefer Qwen3 0.6B/1.7B if downloads keep failing.`
      );
    }
    throw err;
  }

  loadedModelId = entry.id;
  loadedNCtx = nCtx;
  markDownloaded(entry.id);
  broadcastProgress({
    status: "ready",
    model: entry.id,
    file: entry.file,
    progress: 1,
    loaded: 100,
    total: 100,
  });
  console.log(`[wllama] ${entry.id} ready (n_ctx=${nCtx}, multithread=${wllama?.isMultithread?.()})`);
  return status();
}

export async function getContextEstimate(modelId, options = {}) {
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) {
    return { modelId, error: { message: `Unknown model "${modelId}"`, type: "engine_error" } };
  }
  const nCtx = resolveWllamaContextLimit(options.nCtx ?? loadedNCtx);
  const trainedMaxContext = entry.contextWindow || nCtx;
  const probed = await probeDevice();
  return {
    modelId,
    // Designed model max from the registry (may exceed MAX_WLLAMA_CONTEXT_LIMIT).
    trainedMaxContext,
    // Runtime KV-cache size from Settings → wllama n_ctx (clamped by MAX_WLLAMA_CONTEXT_LIMIT).
    effectiveMaxContext: nCtx,
    bindingConstraint: nCtx < trainedMaxContext ? "n_ctx_setting" : null,
    device: probed,
    nCtx,
    caveats: [
      `Model designed context is ${trainedMaxContext.toLocaleString()} tokens; runtime n_ctx is ${nCtx.toLocaleString()} (Settings → wllama context limit).`,
      "Wllama uses Memory64 WASM (not the ONNX wasm32 4GB heap cap).",
      "WebGPU offload used when available; otherwise CPU/WASM.",
      "Larger n_ctx uses more RAM/VRAM; reload the model after changing the setting.",
      isWllamaVisionModel(entry)
        ? "This GGUF loads with an mmproj projector (image+text → text). MCP vision/audio tools still use ONNX."
        : "Vision/audio tools still use the ONNX engine.",
    ],
  };
}

async function ensureLoaded(modelId, nCtx) {
  if (!modelId) return errorResponse("No model specified.", "model_not_loaded");
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) {
    return errorResponse(`Unknown wllama model "${modelId}".`, "model_not_loaded");
  }
  const resolvedNCtx = resolveWllamaContextLimit(nCtx);
  const needsVision = Boolean(entry.mmprojFile);
  if (
    loadedModelId !== modelId ||
    !wllama?.isModelLoaded?.() ||
    loadedNCtx !== resolvedNCtx ||
    (needsVision && !loadedModelHasImageInput())
  ) {
    try {
      await loadModel(modelId, { nCtx: resolvedNCtx });
    } catch (err) {
      return errorResponse(String(err?.message || err), "download_failed");
    }
  }
  if (!wllama || loadedModelId !== modelId) {
    return errorResponse(`Failed to load model "${modelId}".`, "model_not_loaded");
  }
  return null;
}

function copyMessageMeta(m) {
  const out = { role: m.role };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

function isImagePart(part) {
  if (part == null || typeof part !== "object") return false;
  if (part.type === "image" || part.type === "image_url" || part.type === "input_image") return true;
  if (part.image_url || part.image || part.url) return true;
  return part.data instanceof ArrayBuffer || part.data instanceof Uint8Array;
}

function looksLikeMultimodalPart(part) {
  if (part == null) return false;
  if (typeof part === "string") return true;
  if (typeof part !== "object") return false;
  if (part.type === "text" || part.text != null) return true;
  return isImagePart(part);
}

/**
 * Detect OpenAI-style multimodal content parts. Important: do NOT treat an
 * arbitrary JSON object string as parts — tool results like
 * `{"kind":"script","content":"..."}` would be parsed, fail the text/image
 * checks, and collapse to "" before llama.cpp (UI/raw still show the real JSON).
 */
function messageContentParts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.some(looksLikeMultimodalPart)) return parsed;
      } catch {
        /* plain text */
      }
    }
  }
  return null;
}

function countImageParts(messages) {
  let n = 0;
  for (const m of messages || []) {
    const parts = messageContentParts(m?.content);
    if (!parts) continue;
    for (const part of parts) {
      if (isImagePart(part)) n += 1;
    }
  }
  return n;
}

function extractImageSource(part) {
  if (part == null || typeof part !== "object") return null;
  if (part.data instanceof Uint8Array) {
    return part.data.buffer.slice(part.data.byteOffset, part.data.byteOffset + part.data.byteLength);
  }
  if (part.data instanceof ArrayBuffer) return part.data;
  if (part.type === "image_url" || part.image_url) {
    const u = part.image_url;
    return typeof u === "string" ? u : u?.url ?? null;
  }
  if (typeof part.url === "string") return part.url;
  if (typeof part.image === "string") return part.image;
  if (typeof part.source === "string") return part.source;
  return part.data ?? null;
}

function copyBytes(src) {
  if (src instanceof Uint8Array) return src.slice();
  if (src instanceof ArrayBuffer) return new Uint8Array(src).slice();
  throw new Error("Image bytes are empty");
}

function decodeDataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid image data URL");
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(header)) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

async function decodeImageSource(src) {
  if (src instanceof ArrayBuffer || src instanceof Uint8Array) return copyBytes(src);
  if (typeof src !== "string" || !src.trim()) {
    throw new Error("Image part is missing a URL or buffer");
  }
  const value = src.trim();
  if (value.startsWith("data:")) return decodeDataUrlToBytes(value);
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value);
    if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
    return copyBytes(await res.arrayBuffer());
  }
  throw new Error("Unsupported image source — use a data URL or http(s) URL");
}

const WLLAMA_IMAGE_MAX_EDGE = 1280;

function isJpegBytes(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** llama.cpp/stb_image is picky; JPEG is the safe common format. */
async function toWllamaImageBytes(src) {
  const original = await decodeImageSource(src);
  if (!original.byteLength) throw new Error("Decoded image is empty");
  try {
    const blob = new Blob([original]);
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, WLLAMA_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("OffscreenCanvas 2d unavailable");
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const bytes = copyBytes(await jpeg.arrayBuffer());
    if (bytes.byteLength) return bytes;
  } catch (err) {
    console.warn("[wllama] JPEG re-encode failed, using original bytes:", err?.message || err);
  }
  if (isJpegBytes(original) || original.byteLength) return original;
  throw new Error("Could not decode attached image");
}

/**
 * OpenAI image_url / image parts → wllama `{ type: "image", data: ArrayBuffer }`.
 * Never leave image_url in the payload: vendor treats any non-text part as media
 * and pushes `c.data` (undefined) into llama.cpp as an empty file.
 */
async function toWllamaMessages(messages) {
  const out = [];
  const imageSizes = [];
  for (const m of messages || []) {
    const next = copyMessageMeta(m);
    const parts = messageContentParts(m.content);
    if (!parts) {
      next.content = m.content ?? "";
      out.push(next);
      continue;
    }
    const content = [];
    for (const part of parts) {
      if (isImagePart(part)) {
        const bytes = await toWllamaImageBytes(extractImageSource(part));
        imageSizes.push(bytes.byteLength);
        content.push({ type: "image", data: bytes.buffer });
        continue;
      }
      if (typeof part === "string") {
        content.push({ type: "text", text: part });
        continue;
      }
      if (part?.type === "text" || part?.text != null) {
        content.push({ type: "text", text: String(part.text ?? "") });
        continue;
      }
      // Unknown object in a parts array — keep payload rather than dropping to "".
      try {
        content.push({ type: "text", text: JSON.stringify(part) });
      } catch {
        content.push({ type: "text", text: String(part) });
      }
    }
    if (content.some((p) => p.type === "image")) {
      if (!content.some((p) => p.type === "text")) content.push({ type: "text", text: "Describe this image." });
      next.content = content;
    } else {
      const text = content.map((p) => p.text).join("\n");
      next.content = text || (typeof m.content === "string" ? m.content : "");
    }
    out.push(next);
  }
  return { messages: out, imageSizes };
}

async function runChatCompletions(request) {
  const modelId = request?.model;
  const nCtx = resolveWllamaContextLimit(request?.n_ctx);
  const loadErr = await ensureLoaded(modelId, nCtx);
  if (loadErr) return loadErr;

  if (!Array.isArray(request?.messages)) {
    return errorResponse("messages must be an array.", "engine_error");
  }

  busy = true;
  try {
    const maxTokens = resolveMaxTokens(request.max_tokens);
    const contextLimit = loadedNCtx ?? nCtx;
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

    const imageCount = countImageParts(trim.messages);
    if (imageCount && !loadedModelHasImageInput()) {
      return errorResponse(
        isWllamaVisionModel(modelId)
          ? "This VLM did not enable image input (mmproj missing or failed to load). Clear wllama cache in Settings, then reload the model."
          : "This wllama model is text-only. Pick a vision GGUF (text+image→text) to attach images.",
        "unsupported_modality"
      );
    }

    let messages;
    try {
      const converted = await toWllamaMessages(trim.messages);
      messages = converted.messages;
      if (converted.imageSizes.length) {
        console.log(
          `[wllama] forwarding ${converted.imageSizes.length} image(s) ` +
            `(${converted.imageSizes.join(", ")} bytes) has_image_input=${loadedModelHasImageInput()}`
        );
      } else if (imageCount) {
        return errorResponse("Attached image(s) were dropped before reaching llama.cpp.", "engine_error");
      }
    } catch (err) {
      return errorResponse(String(err?.message || err), "engine_error");
    }

    /** @type {Record<string, unknown>} */
    const body = {
      messages,
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
      const contextLimit = loadedNCtx ?? resolveWllamaContextLimit(request?.n_ctx);
      const est = estimateChatTokens(request.messages, request.tools);
      return errorResponse(
        `Prompt is too long for wllama (~${est.toLocaleString()} tokens estimated; ` +
          `n_ctx ${contextLimit.toLocaleString()}). Start a new chat or raise the wllama context limit in Settings.`,
        "context_exceeded"
      );
    }
    if (/out of memory|oom|Failed to allocate/i.test(message)) {
      loadedModelId = null;
      loadedNCtx = null;
      try {
        await wllama?.exit();
      } catch {
        /* best-effort */
      }
      wllama = null;
      return errorResponse(
        `${message} Try a smaller GGUF, a lower context limit (n_ctx), unload other models, or enable WebGPU.`,
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
