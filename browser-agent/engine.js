// Transformers.js multi-task engine: device probing, task-keyed model registry,
// pipeline cache, run() for any supported task, and OpenAI-shaped chat for
// text-generation. Intended to run inside ort-worker.js (Dedicated Worker).

import { resolveMaxTokens } from "./agent-config.js";
import { applyIndexedDbCache, clearModelCache, deleteModelFromCache, listCachedFiles } from "./model-cache.js";
import { isQwen3ThinkingModel } from "./reasoning-content.js";

const VENDOR_DIR = "vendor/transformers/";
// transformers.js ≥4 uses asyncify for WebGPU (exports webgpuInit).
// Older jsep builds export jsepInit instead — loading them for WebGPU yields:
// "Ae(...).webgpuInit is not a function".
const ASYNCIFY_WASM = "ort-wasm-simd-threaded.asyncify.wasm";
const ASYNCIFY_MJS = "ort-wasm-simd-threaded.asyncify.mjs";
const CPU_WASM = "ort-wasm-simd-threaded.wasm";
const CPU_MJS = "ort-wasm-simd-threaded.mjs";

// Context-length estimate heuristics (see getContextEstimate below).
// KV cache dtype isn't an explicit config field in transformers.js; this proxies
// it off the execution device (fp16 on WebGPU, fp32 on wasm/CPU).
const KV_BYTES_PER_ELEMENT = { webgpu: 2, wasm: 4 };
// navigator.deviceMemory is a bucketed/capped total-RAM hint, not a free-RAM
// reading, and is shared with the rest of the system/browser — assume half.
const ASSUMED_FREE_MEMORY_FRACTION = 0.5;
// ORT + Transformers.js run inside a wasm32 module with a 4GB linear-memory cap.
const WASM_MAX_HEAP_BYTES = 4 * 1024 ** 3;
// Headroom for ORT runtime, activations, and JS↔wasm buffers inside the same heap.
const WASM_HEAP_RESERVE_BYTES = 768 * 1024 * 1024;
// Browsers rarely allow allocating the full 4GB before other heap uses.
const WASM_USABLE_HEAP_FRACTION = 0.85;

let transformersModule = null;
/** @type {"asyncify"|"cpu"|null} */
let ortFlavor = null;

function vendorUrl(file) {
  const path = VENDOR_DIR + file;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  // Module workers sometimes lack chrome.*; resolve against extension origin.
  return new URL(path, self.location.href).href;
}

/**
 * Point ORT at the bundled binaries and (re)assert MV3-safe flags.
 * Call just before model load so values stick past Transformers' backend setup.
 *
 * This engine is expected to run inside ort-worker.js (a Dedicated Worker).
 * There Atomics.wait is legal, so ORT's nested `proxy` worker must stay OFF.
 */
async function configureOrt(preferredDevice) {
  const { env } = await loadTransformers();
  const wasm = env.backends.onnx.wasm;

  // Match transformers.js v4 defaults: asyncify for WebGPU, cpu build otherwise.
  const flavor = preferredDevice === "webgpu" ? "asyncify" : "cpu";
  if (ortFlavor && ortFlavor !== flavor) {
    throw new Error(
      `ORT already started as "${ortFlavor}" but this model wants "${flavor}". ` +
        `Reload the extension (or Unload all models) before switching WebGPU ↔ CPU.`
    );
  }

  const mjs = vendorUrl(flavor === "asyncify" ? ASYNCIFY_MJS : CPU_MJS);
  const wasmFile = vendorUrl(flavor === "asyncify" ? ASYNCIFY_WASM : CPU_WASM);
  wasm.wasmPaths = { mjs, wasm: wasmFile };

  wasm.numThreads = 1;
  // Already inside a Dedicated Worker — nested ORT proxy Workers are unnecessary
  // and often Aborted/CSP-blocked under MV3.
  wasm.proxy = false;

  // Drop a previously preloaded binary if the flavor changed (fresh worker).
  if (wasm._baFlavor && wasm._baFlavor !== flavor) {
    wasm.wasmBinary = undefined;
  }
  if (!wasm.wasmBinary) {
    const res = await fetch(wasmFile);
    if (!res.ok) throw new Error(`Failed to fetch ORT wasm (${res.status}): ${wasmFile}`);
    wasm.wasmBinary = await res.arrayBuffer();
    wasm._baFlavor = flavor;
  }

  const inWorker =
    typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
  console.log(
    `[onnx] ORT configured device=${preferredDevice} flavor=${flavor} proxy=${wasm.proxy} ` +
      `numThreads=${wasm.numThreads} inWorker=${inWorker} crossOriginIsolated=${globalThis.crossOriginIsolated === true}`
  );
  if (!inWorker) {
    console.warn(
      "[onnx] Engine is not running in a Dedicated Worker — threaded ORT will likely Aborted(). " +
        "Expected host: ort-worker.js via offscreen.js."
    );
  }
  return env;
}

function markOrtFlavor(preferredDevice) {
  ortFlavor = preferredDevice === "webgpu" ? "asyncify" : "cpu";
}

async function loadTransformers() {
  if (!transformersModule) {
    transformersModule = await import(vendorUrl("transformers.min.js"));
    const wasm = transformersModule.env.backends.onnx.wasm;
    // Override CDN default — prefer asyncify so the first WebGPU init is correct.
    wasm.wasmPaths = {
      mjs: vendorUrl(ASYNCIFY_MJS),
      wasm: vendorUrl(ASYNCIFY_WASM),
    };
    wasm.numThreads = 1;
    wasm.proxy = false;
    transformersModule.env.allowRemoteModels = true;
    transformersModule.env.allowLocalModels = false;
    // Persist HF weight blobs in IndexedDB (not Cache Storage).
    applyIndexedDbCache(transformersModule.env);

    const coi = globalThis.crossOriginIsolated === true;
    const sab = typeof SharedArrayBuffer !== "undefined";
    console.log(`[onnx] crossOriginIsolated=${coi} SharedArrayBuffer=${sab}`);
  }
  return transformersModule;
}

/** @typedef {"text-generation"|"image-text-to-text"|"image-to-text"|"image-classification"|"automatic-speech-recognition"} EngineTask */
/** @typedef {"llm"|"vision"|"audio"} Modality */

/**
 * Multi-task registry. LLM entries keep the previous chat path; vision/audio
 * defaults power agent tools (describe_image, classify_image, transcribe_audio).
 * Models are Xenova / onnx-community ONNX builds verified on the HF Hub.
 */
export const MODEL_REGISTRY = [
  // LLM — ordered smallest → largest for OOM downshift
  // pipeline_tag matches Hugging Face model-card metadata (display + Hub taxonomy).
  { id: "onnx-community/Llama-3.2-1B-Instruct-ONNX", label: "Llama 3.2 1B", approxSizeMB: 700, tier: "fast", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },
  // Pinned to CPU EP (wasm) + q8: WebGPU's KV-cache carry-over corrupts this model's
  // output within the first few generated tokens (confirmed: identical tokenizer +
  // model.generate() call is clean on plain onnxruntime-node; only onnxruntime-web's
  // WebGPU path degenerates). q8 is upstream's own CPU default dtype.
  { id: "onnx-community/Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B", approxSizeMB: 1580, dtype: "q8", forceCpu: true, tier: "fast", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },
  { id: "onnx-community/Llama-3.2-3B-Instruct-ONNX", label: "Llama 3.2 3B", approxSizeMB: 1800, tier: "default", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },
  {
    id: "mistralai/Ministral-3-3B-Instruct-2512-ONNX",
    label: "Ministral 3 3B Instruct (VLM)",
    approxSizeMB: 2800,
    tier: "default",
    task: "image-text-to-text",
    pipeline_tag: "image-text-to-text",
    modality: "llm",
    loader: "ministral",
  },
  {
    id: "onnx-community/gemma-4-E2B-it-ONNX",
    label: "Gemma 4 E2B (VLM)",
    approxSizeMB: 2200,
    tier: "default",
    task: "image-text-to-text",
    pipeline_tag: "any-to-any",
    modality: "llm",
    loader: "gemma4",
  },
  { id: "onnx-community/Phi-3.5-mini-instruct-onnx-web", label: "Phi 3.5 mini (3.8B)", approxSizeMB: 2200, tier: "max", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },
  {
    id: "onnx-community/gemma-4-E4B-it-ONNX",
    label: "Gemma 4 E4B (VLM)",
    approxSizeMB: 4200,
    tier: "max",
    task: "image-text-to-text",
    pipeline_tag: "any-to-any",
    modality: "llm",
    loader: "gemma4",
  },
  { id: "onnx-community/Qwen3-4B-Instruct-2507-ONNX", label: "Qwen 3 4B Instruct", approxSizeMB: 2600, tier: "max", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },
  { id: "onnx-community/Qwen3-4B-ONNX", label: "Qwen 3 4B", approxSizeMB: 2600, tier: "max", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },

  // Captioning / OCR (image-to-text)
  { id: "Xenova/vit-gpt2-image-captioning", label: "ViT-GPT2 captioning", approxSizeMB: 250, tier: "default", task: "image-to-text", pipeline_tag: "image-to-text", modality: "vision" },
  { id: "Xenova/trocr-small-printed", label: "TrOCR small (printed)", approxSizeMB: 60, tier: "fast", task: "image-to-text", pipeline_tag: "image-to-text", modality: "vision" },
  { id: "Xenova/trocr-small-handwritten", label: "TrOCR small (handwritten)", approxSizeMB: 60, tier: "fast", task: "image-to-text", pipeline_tag: "image-to-text", modality: "vision" },
  { id: "Xenova/trocr-base-printed", label: "TrOCR base (printed)", approxSizeMB: 330, tier: "max", task: "image-to-text", pipeline_tag: "image-to-text", modality: "vision" },
  { id: "Xenova/nougat-small", label: "Nougat small (docs→MD)", approxSizeMB: 500, tier: "max", task: "image-to-text", pipeline_tag: "image-to-text", modality: "vision" },

  // Image classification
  { id: "Xenova/vit-base-patch16-224", label: "ViT base (ImageNet)", approxSizeMB: 90, tier: "default", task: "image-classification", pipeline_tag: "image-classification", modality: "vision" },
  { id: "onnx-community/mobilenetv4_conv_small.e2400_r224_in1k", label: "MobileNetV4 small", approxSizeMB: 15, tier: "fast", task: "image-classification", pipeline_tag: "image-classification", modality: "vision" },
  { id: "Xenova/mobilevit-small", label: "MobileViT small", approxSizeMB: 20, tier: "fast", task: "image-classification", pipeline_tag: "image-classification", modality: "vision" },
  { id: "Xenova/resnet-50", label: "ResNet-50", approxSizeMB: 100, tier: "default", task: "image-classification", pipeline_tag: "image-classification", modality: "vision" },
  { id: "Xenova/convnext-tiny-224", label: "ConvNeXt tiny", approxSizeMB: 110, tier: "default", task: "image-classification", pipeline_tag: "image-classification", modality: "vision" },

  // Speech recognition
  { id: "Xenova/whisper-tiny.en", label: "Whisper tiny.en", approxSizeMB: 80, tier: "fast", task: "automatic-speech-recognition", pipeline_tag: "automatic-speech-recognition", modality: "audio" },
  { id: "onnx-community/whisper-tiny.en", label: "Whisper tiny.en (onnx-community)", approxSizeMB: 80, tier: "fast", task: "automatic-speech-recognition", pipeline_tag: "automatic-speech-recognition", modality: "audio" },
  { id: "Xenova/whisper-base.en", label: "Whisper base.en", approxSizeMB: 150, tier: "default", task: "automatic-speech-recognition", pipeline_tag: "automatic-speech-recognition", modality: "audio" },
  { id: "Xenova/whisper-tiny", label: "Whisper tiny (multilingual)", approxSizeMB: 80, tier: "fast", task: "automatic-speech-recognition", pipeline_tag: "automatic-speech-recognition", modality: "audio" },
  { id: "Xenova/whisper-small.en", label: "Whisper small.en", approxSizeMB: 500, tier: "max", task: "automatic-speech-recognition", pipeline_tag: "automatic-speech-recognition", modality: "audio" },
  { id: "onnx-community/moonshine-tiny-ONNX", label: "Moonshine tiny", approxSizeMB: 50, tier: "fast", task: "automatic-speech-recognition", pipeline_tag: "automatic-speech-recognition", modality: "audio" },

  // Text embeddings (RAG)
  { id: "Xenova/all-MiniLM-L6-v2", label: "MiniLM L6 embeddings", approxSizeMB: 25, tier: "fast", task: "feature-extraction", pipeline_tag: "feature-extraction", modality: "embedding" },
  { id: "Xenova/bge-small-en-v1.5", label: "BGE small embeddings", approxSizeMB: 35, tier: "default", task: "feature-extraction", pipeline_tag: "feature-extraction", modality: "embedding" },
];

/** Hugging Face pipeline_tag display names (Hub model-card taxonomy). */
export const PIPELINE_TAG_LABELS = {
  "text-generation": "Text Generation",
  "image-text-to-text": "Image-Text-to-Text",
  "any-to-any": "Any-to-Any",
  "image-to-text": "Image-to-Text",
  "image-classification": "Image Classification",
  "automatic-speech-recognition": "Automatic Speech Recognition",
  "feature-extraction": "Feature Extraction",
};

export function pipelineTagLabel(tagOrEntry) {
  const tag =
    typeof tagOrEntry === "string"
      ? tagOrEntry
      : tagOrEntry?.pipeline_tag || tagOrEntry?.task || "text-generation";
  return PIPELINE_TAG_LABELS[tag] || tag.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
const DEFAULT_TOP_P = 0.9;
const TEXT_GENERATION = "text-generation";
const IMAGE_TEXT_TO_TEXT = "image-text-to-text";
const FEATURE_EXTRACTION = "feature-extraction";
const LLM_TASKS = [TEXT_GENERATION, IMAGE_TEXT_TO_TEXT];

let device = null; // "webgpu" | "wasm", probed once and cached
let dtype = null;
/** @type {Map<string, { pipeline: object, task: string, modelId: string }>} */
const loaded = new Map();
let busy = false;
let queue = Promise.resolve();

/** @type {Map<string, object>} successful getContextEstimate() results only. */
const contextEstimateCache = new Map();

function slotKey(task, modelId) {
  return `${task}::${modelId}`;
}

function registryEntry(modelId) {
  return MODEL_REGISTRY.find((m) => m.id === modelId) || null;
}

function isGemma4Model(modelId) {
  return registryEntry(modelId)?.loader === "gemma4" || /gemma-4/i.test(modelId || "");
}

function isMinistralModel(modelId) {
  return registryEntry(modelId)?.loader === "ministral" || /ministral/i.test(modelId || "");
}

function isLlmTask(task) {
  return LLM_TASKS.includes(task);
}

function llmRegistry() {
  return MODEL_REGISTRY.filter((m) => m.modality === "llm");
}

function dtypeForModel(modelId, device) {
  const entry = registryEntry(modelId);
  if (entry?.dtype) {
    // Per-device override (e.g. { webgpu: "q4f16", wasm: "q8" }) vs. a flat string
    // applied to both devices.
    return typeof entry.dtype === "object" ? entry.dtype[device] ?? entry.dtype.default : entry.dtype;
  }
  if (device === "webgpu") return "q4f16";
  return "q4";
}

/** WebGPU GatherBlockQuantized only accepts 4- or 8-bit weights (ORT). */
function isWebGpuBlockedQuant(dtypeName) {
  return /^(q2|q2f16|q3|q3f16)$/i.test(String(dtypeName || ""));
}

/**
 * Pick the ORT *runtime* flavor (wasm binary) vs the session device (EP).
 * q2f16 mobile weights must use the CPU EP even when WebGPU runtime is loaded.
 */
function sessionDeviceForModel(modelId, preferredDevice) {
  if (preferredDevice === "webgpu" && registryEntry(modelId)?.forceCpu) {
    console.warn(`[onnx] ${modelId} is pinned to CPU EP (WebGPU KV-cache corruption); using CPU EP`);
    return "wasm";
  }
  const dt = dtypeForModel(modelId, preferredDevice);
  if (preferredDevice === "webgpu" && isWebGpuBlockedQuant(dt)) {
    console.warn(
      `[onnx] ${dt} is not supported by WebGPU GatherBlockQuantized (bits must be 4 or 8); using CPU EP for ${modelId}`
    );
    return "wasm";
  }
  return preferredDevice;
}

/**
 * Pull an image URL / data URL / RawImage-like value from an OpenAI- or HF-style content part.
 * @returns {string|object|null}
 */
function extractImageSource(part) {
  if (part == null) return null;
  if (typeof part === "string") return part;
  if (typeof part !== "object") return null;
  if (part.type === "image_url") {
    const u = part.image_url;
    return typeof u === "string" ? u : u?.url ?? null;
  }
  if (part.type === "image") {
    return part.image ?? part.url ?? part.source ?? null;
  }
  return null;
}

/**
 * Normalize chat messages for VLM chat templates (Gemma 4, Ministral) and
 * collect image sources. Template parts use `{ type: "image" }` placeholders;
 * pixels are loaded separately and passed to the processor (Transformers.js API).
 * @returns {{ messages: object[], imageSources: (string|object)[] }}
 */
function toGemmaMessages(messages) {
  const imageSources = [];
  const normalized = (messages || []).map((m) => {
    const role = m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user";
    // Gemma's chat template applies `| trim` to the leading system message
    // without an `is string` guard, so system content must stay a plain string.
    if (role === "system") {
      const text = Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "string" ? p : String(p?.text ?? ""))).join("\n")
        : String(m.content ?? "");
      return { role, content: text };
    }
    if (!Array.isArray(m.content)) {
      return { role, content: [{ type: "text", text: String(m.content ?? "") }] };
    }
    const content = [];
    for (const part of m.content) {
      if (part?.type === "image" || part?.type === "image_url") {
        const src = extractImageSource(part);
        if (src == null) {
          throw new Error(
            'Gemma 4 image parts need a source (e.g. { type: "image", image: url } or { type: "image_url", image_url: { url } }).'
          );
        }
        content.push({ type: "image" });
        imageSources.push(src);
        continue;
      }
      if (part?.type === "audio") {
        // Image multimodal path only for now — keep text if present, skip audio blobs.
        if (part.text) content.push({ type: "text", text: String(part.text) });
        continue;
      }
      if (part?.type === "text" || part?.text != null) {
        content.push({ type: "text", text: String(part.text ?? "") });
        continue;
      }
      content.push({ type: "text", text: String(part ?? "") });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    return { role, content };
  });
  return { messages: normalized, imageSources };
}

export function defaultModelForTask(task) {
  return MODEL_REGISTRY.find((m) => m.task === task)?.id || null;
}

export function modelsForTask(task) {
  if (!task || task === TEXT_GENERATION) return llmRegistry();
  return MODEL_REGISTRY.filter((m) => m.task === task);
}

function findLoadedForTask(task) {
  for (const entry of loaded.values()) {
    if (entry.task === task) return entry;
  }
  return null;
}

function llmLoadedModelId() {
  for (const task of LLM_TASKS) {
    const loadedModel = findLoadedForTask(task)?.modelId;
    if (loadedModel) return loadedModel;
  }
  return null;
}

/** Trained max context length. `max_position_embeddings` is a plain top-level
 * config field (not covered by normalized_config's text_config recursion), so
 * composite VLM configs (Gemma4, Ministral, ...) need the nested fallback. */
function readMaxContext(config) {
  return config?.max_position_embeddings ?? config?.text_config?.max_position_embeddings ?? null;
}

/** KV-cache bytes/token = 2 (K and V) * layers * kv_heads * head_dim * bytesPerElement. */
function kvCacheBytesPerToken(config, bytesPerElement) {
  const n = config?.normalized_config || {};
  const numLayers = n.num_layers;
  const numKvHeads = n.num_heads;
  const headDim = n.dim_kv ?? (config?.hidden_size && config?.num_attention_heads
    ? config.hidden_size / config.num_attention_heads
    : null);
  if (!numLayers || !numKvHeads || !headDim) return null;
  return 2 * numLayers * numKvHeads * headDim * bytesPerElement;
}

/** KV tokens that fit in the wasm32 4GB heap after weights + runtime reserve (CPU EP path). */
function estimateWasmMemoryLimitedTokens(config, approxWeightsMB) {
  const bytesPerToken = kvCacheBytesPerToken(config, KV_BYTES_PER_ELEMENT.wasm);
  if (!bytesPerToken) return null;
  const weightsBytes = (approxWeightsMB || 0) * 1024 * 1024;
  const budgetBytes =
    WASM_MAX_HEAP_BYTES * WASM_USABLE_HEAP_FRACTION - WASM_HEAP_RESERVE_BYTES - weightsBytes;
  if (budgetBytes <= 0) return 0;
  return Math.floor(budgetBytes / bytesPerToken);
}

/** KV tokens from navigator.deviceMemory minus approximate weights (GPU / system RAM hint). */
function estimateDeviceMemoryLimitedTokens(config, probedDevice, deviceMemoryGB, approxWeightsMB) {
  const bytesPerToken = kvCacheBytesPerToken(config, KV_BYTES_PER_ELEMENT[probedDevice] ?? KV_BYTES_PER_ELEMENT.wasm);
  if (!bytesPerToken || deviceMemoryGB == null) return null;
  const budgetBytes =
    deviceMemoryGB * 1024 ** 3 * ASSUMED_FREE_MEMORY_FRACTION - (approxWeightsMB || 0) * 1024 * 1024;
  if (budgetBytes <= 0) return 0;
  return Math.floor(budgetBytes / bytesPerToken);
}

function contextBindingConstraint(trainedMaxContext, deviceLimited, wasmLimited, effectiveMaxContext) {
  if (effectiveMaxContext == null || trainedMaxContext == null || effectiveMaxContext >= trainedMaxContext) {
    return null;
  }
  const candidates = [
    ["wasm", wasmLimited],
    ["device-memory", deviceLimited],
  ];
  for (const [kind, limit] of candidates) {
    if (limit != null && limit === effectiveMaxContext) return kind;
  }
  return "memory";
}

/**
 * Estimate a model's usable context: its trained max (from config.json, fetched
 * without downloading weights) combined with a rough memory-constrained max
 * derived from the KV-cache-per-token cost and navigator.deviceMemory — the
 * only memory signal available inside this Dedicated Worker. Never throws.
 */
export async function getContextEstimate(modelId) {
  if (!modelId) return { modelId, error: { message: "No model specified.", type: "engine_error" } };
  if (contextEstimateCache.has(modelId)) return contextEstimateCache.get(modelId);

  let config;
  try {
    const { AutoConfig } = await loadTransformers();
    if (!AutoConfig) throw new Error("AutoConfig unavailable in this transformers.js build.");
    config = await AutoConfig.from_pretrained(modelId);
  } catch (err) {
    return { modelId, error: { message: `Could not read model config: ${err?.message || err}`, type: "engine_error" } };
  }

  const { device: probedDevice } = await probeDevice();
  const trainedMaxContext = readMaxContext(config);
  const deviceMemoryGB = typeof navigator !== "undefined" && navigator.deviceMemory ? navigator.deviceMemory : null;
  const approxWeightsMB = registryEntry(modelId)?.approxSizeMB ?? null;

  const memoryLimitedTokens = estimateDeviceMemoryLimitedTokens(
    config,
    probedDevice,
    deviceMemoryGB,
    approxWeightsMB
  );
  const wasmMemoryLimitedTokens = estimateWasmMemoryLimitedTokens(config, approxWeightsMB);

  const candidates = [trainedMaxContext, memoryLimitedTokens, wasmMemoryLimitedTokens].filter(
    (v) => v != null
  );
  const effectiveMaxContext = candidates.length ? Math.min(...candidates) : null;
  const bindingConstraint = contextBindingConstraint(
    trainedMaxContext,
    memoryLimitedTokens,
    wasmMemoryLimitedTokens,
    effectiveMaxContext
  );

  const caveats = [
    "KV cache dtype is assumed from the execution device (fp16 on WebGPU, fp32 on CPU/wasm), not read from an explicit model field.",
    "Device memory is a bucketed browser hint capped at 8GB and shared with the rest of the system — not a live free-RAM reading.",
    `WASM linear memory is capped at 4GB per engine instance; ~${Math.round(WASM_HEAP_RESERVE_BYTES / (1024 * 1024))}MB is reserved for runtime overhead inside that heap.`,
    "VLM image tokens and other apps using the GPU (e.g. Ollama) are not included — usable context may be lower in practice.",
  ];
  if (bindingConstraint === "wasm") {
    caveats.push(
      "Usable context is limited by the WASM 4GB heap (weights + KV cache on CPU), not the model's trained max length."
    );
  }

  const result = {
    modelId,
    trainedMaxContext,
    memoryLimitedTokens,
    wasmMemoryLimitedTokens,
    effectiveMaxContext,
    bindingConstraint,
    device: probedDevice,
    deviceMemoryGB,
    assumedFreeFraction: ASSUMED_FREE_MEMORY_FRACTION,
    approxWeightsMB,
    wasmHeapReserveMB: Math.round(WASM_HEAP_RESERVE_BYTES / (1024 * 1024)),
    caveats,
  };
  contextEstimateCache.set(modelId, result);
  return result;
}

async function probeDevice() {
  if (device) return { device, dtype };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        device = "webgpu";
        dtype = "q4f16";
        return { device, dtype };
      }
    }
  } catch (err) {
    console.warn("[onnx] WebGPU probe failed, falling back to wasm:", err);
  }
  device = "wasm";
  dtype = "q4";
  return { device, dtype };
}

function broadcastProgress(event) {
  chrome.runtime.sendMessage({ target: "onnx-progress", ...event }).catch(() => {});
}

// Offscreen documents can only use chrome.runtime — chrome.storage is
// undefined here, so persisting the "downloaded" flag is delegated to the
// background service worker via this broadcast.
function markDownloaded(modelId) {
  chrome.runtime.sendMessage({ target: "onnx-model-ready", model: modelId }).catch(() => {});
}

export async function status() {
  let cachedFiles = [];
  try {
    cachedFiles = await listCachedFiles();
  } catch {
    // cache may not be open yet
  }
  const loadedList = [...loaded.values()].map(({ task, modelId }) => ({ task, model: modelId }));
  return {
    device,
    dtype,
    // Back-compat for Settings UI (LLM picker).
    loadedModel: llmLoadedModelId(),
    loaded: loadedList,
    busy,
    registry: MODEL_REGISTRY,
    cacheBackend: "indexeddb",
    cachedFiles,
  };
}

/** Drop all IndexedDB-cached weight files (in-memory pipelines untouched). */
export async function clearCache() {
  await clearModelCache();
  return status();
}

/** Unload one model (if loaded) and delete its cached weight files. */
export async function deleteModel(modelId) {
  if (!modelId) return { error: { message: "engine.deleteModel requires a model id", type: "engine_error", code: null } };
  await unload({ model: modelId });
  const removed = await deleteModelFromCache(modelId);
  return { ...(await status()), removed };
}

function requestPeerUnload(peer, msg) {
  self.postMessage({ type: "engine.unloadPeer", peer, msg });
}

async function disposeEntry(entry) {
  try {
    if (entry?.model?.dispose) await entry.model.dispose();
    else if (entry?.pipeline?.dispose) await entry.pipeline.dispose();
  } catch {
    // best-effort
  }
}

/**
 * @param {{ task?: string, model?: string }|string|undefined} opts
 *   Back-compat: unload() / unload(modelId) unloads all or a single LLM model.
 */
export async function unload(opts) {
  if (typeof opts === "string") {
    opts = { model: opts, task: TEXT_GENERATION };
  }
  const task = opts?.task;
  const model = opts?.model;

  if (!task && !model) {
    for (const [key, entry] of [...loaded.entries()]) {
      await disposeEntry(entry);
      loaded.delete(key);
    }
    return status();
  }

  for (const [key, entry] of [...loaded.entries()]) {
    if (task && entry.task !== task) continue;
    if (model && entry.modelId !== model) continue;
    await disposeEntry(entry);
    loaded.delete(key);
  }
  return status();
}

/** Unload chat LLM pipelines only (keep vision/audio for agent tools). */
export async function unloadLlm() {
  for (const llmTask of LLM_TASKS) {
    await unload({ task: llmTask });
  }
  return status();
}

async function unloadOthersExcept(keepTask, keepModelId) {
  for (const [key, entry] of [...loaded.entries()]) {
    if (entry.task === keepTask && entry.modelId === keepModelId) continue;
    console.warn(`[onnx] unloading ${entry.task}:${entry.modelId} to free memory`);
    await disposeEntry(entry);
    loaded.delete(key);
  }
}

/**
 * Load (or reuse) a pipeline for a task.
 * @param {string|{ task?: string, model: string }} modelOrOpts
 *   Back-compat: loadModel(modelId) loads text-generation.
 */
export async function loadModel(modelOrOpts) {
  const opts =
    typeof modelOrOpts === "string"
      ? { model: modelOrOpts }
      : modelOrOpts || {};

  const modelId = opts.model;
  if (!modelId) throw new Error("No model specified.");
  const forceCpuEp = opts.forceCpuEp === true;

  // Registry task is authoritative (e.g. Gemma 4 → image-text-to-text).
  const task = opts.task || registryEntry(modelId)?.task || TEXT_GENERATION;
  const key = slotKey(task, modelId);
  if (loaded.has(key)) return status();

  // Same task, different model → dispose the previous one for that task.
  const sameTask = findLoadedForTask(task);
  if (sameTask && sameTask.modelId !== modelId) {
    await unload({ task });
  }
  // Only one LLM pipeline at a time (text or vision-language).
  if (isLlmTask(task)) {
    requestPeerUnload("webllm-engine", { type: "engine.unload" });
    for (const llmTask of LLM_TASKS) {
      if (llmTask === task) continue;
      await unload({ task: llmTask });
    }
  }

  const { pipeline, AutoProcessor, Gemma4ForConditionalGeneration, AutoModelForImageTextToText } =
    await loadTransformers();
  const { device: preferred } = await probeDevice();
  // Keep WebGPU/asyncify runtime when available so other models stay on GPU;
  // individual sessions may still use CPU EP (e.g. q2f16 mobile).
  await configureOrt(preferred === "webgpu" ? "webgpu" : "wasm");

  const sessionDevice = forceCpuEp ? "wasm" : sessionDeviceForModel(modelId, preferred);
  const modelDtype = dtypeForModel(modelId, sessionDevice);
  const progress_callback = (event) => {
    broadcastProgress({
      file: event.file,
      status: event.status,
      progress: event.progress,
      loaded: event.loaded,
      total: event.total,
      model: modelId,
      task,
    });
  };

  console.log(
    `[onnx] loading ${task} ${modelId} on ${sessionDevice} (${modelDtype})` +
      `${isGemma4Model(modelId) ? " [gemma4]" : ""}` +
      `${isMinistralModel(modelId) ? " [ministral]" : ""}` +
      `${forceCpuEp ? " [cpu-fallback]" : ""}` +
      `${sessionDevice !== preferred ? ` (runtime=${preferred})` : ""}`
  );

  let entry;
  try {
    if (isGemma4Model(modelId)) {
      if (!Gemma4ForConditionalGeneration || !AutoProcessor) {
        throw new Error("Gemma4 support missing — rebuild vendor/transformers (need @huggingface/transformers ≥ 4.2).");
      }
      const processor = await AutoProcessor.from_pretrained(modelId, { progress_callback });
      const model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
        device: sessionDevice,
        dtype: modelDtype,
        progress_callback,
      });
      entry = { kind: "gemma4", model, processor, pipeline: null, task, modelId, forceCpuEp };
    } else if (isMinistralModel(modelId)) {
      if (!AutoModelForImageTextToText || !AutoProcessor) {
        throw new Error("Ministral support missing — rebuild vendor/transformers (need @huggingface/transformers ≥ 4.2).");
      }
      const processor = await AutoProcessor.from_pretrained(modelId, { progress_callback });
      const model = await AutoModelForImageTextToText.from_pretrained(modelId, {
        device: sessionDevice,
        dtype: modelDtype,
        progress_callback,
      });
      entry = { kind: "ministral", model, processor, pipeline: null, task, modelId, forceCpuEp };
    } else {
      const pipelineOpts = {
        device: sessionDevice,
        progress_callback,
      };
      if (task === TEXT_GENERATION) pipelineOpts.dtype = modelDtype;
      const pipe = await pipeline(task, modelId, pipelineOpts);
      entry = { kind: "pipeline", pipeline: pipe, task, modelId, forceCpuEp, sessionDevice, modelDtype };
    }
  } catch (err) {
    const message = String(err?.message || err);
    if (/webgpuInit is not a function/i.test(message)) {
      throw new Error(
        `WebGPU backend failed (${message}). Reload the extension so ORT can start with the asyncify WASM build, then try again.`
      );
    }
    if (/bits.must be 4 or 8|GatherBlockQuantized/i.test(message)) {
      throw new Error(
        `"${modelId}" uses a quantization WebGPU cannot run (need 4- or 8-bit). ` +
          `Use Gemma 4 E2B/E4B (q4f16) on GPU, or reload and retry — mobile QAT now forces CPU.`
      );
    }
    throw err;
  }

  loaded.set(key, entry);
  markOrtFlavor(preferred === "webgpu" ? "webgpu" : "wasm");
  markDownloaded(modelId);
  console.log(`[onnx] ${task} ${modelId} ready`);
  return status();
}

function toResponse(modelId, text, finishReason, usage) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage,
  };
}

function errorResponse(message, type) {
  return { error: { message, type, code: null } };
}

/** FIFO-serialize concurrent requests (chat + media tools may collide). */
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Run any registered task. Returns `{ task, model, output }` or `{ error }`.
 * @param {{ task: string, model?: string, input: unknown, options?: object }} request
 */
export function run(request) {
  return enqueue(() => runInference(request));
}

export function chatCompletions(request) {
  return enqueue(() => runChatCompletions(request));
}

export function renderChatPromptOnly(request) {
  return enqueue(() => runRenderChatPromptOnly(request));
}

async function ensureLoaded(task, modelId) {
  const key = slotKey(task, modelId);
  if (loaded.has(key)) return loaded.get(key);

  try {
    await loadModel({ task, model: modelId });
    return loaded.get(key);
  } catch (err) {
    return await handleLoadFailure(task, modelId, err);
  }
}

async function runInference(request) {
  const task = request?.task;
  if (!task) return errorResponse("No task specified.", "engine_error");

  const modelId = request.model || defaultModelForTask(task);
  if (!modelId) return errorResponse(`No model available for task "${task}".`, "model_not_loaded");
  if (request.input === undefined || request.input === null) {
    return errorResponse("No input provided.", "engine_error");
  }

  busy = true;
  try {
    const entryOrErr = await ensureLoaded(task, modelId);
    if (entryOrErr?.error) return entryOrErr;
    const entry = entryOrErr;
    if (!entry?.pipeline && !entry?.model) {
      return errorResponse(`Failed to load model "${modelId}".`, "download_failed");
    }

    const options = request.options || {};
    let raw;
    try {
      raw = await invokeEntry(entry, task, request.input, options);
    } catch (err) {
      const message = String(err?.message || err);
      if (isGpuResourceError(message)) {
        const alreadyCpu = entry?.forceCpuEp === true;
        if (!alreadyCpu && device === "webgpu") {
          console.warn(`[onnx] GPU error during ${task}, unloading and retrying once on CPU EP`);
          await unloadOthersExcept(task, modelId);
          await unload({ task, model: modelId });
          try {
            await loadModel({ task, model: modelId, forceCpuEp: true });
            const reloaded = loaded.get(slotKey(task, modelId));
            if (!reloaded?.pipeline && !reloaded?.model) {
              return errorResponse(`Failed to reload "${modelId}" on CPU after a GPU error.`, "oom");
            }
            raw = await invokeEntry(reloaded, task, request.input, options);
          } catch (err2) {
            return await handleGenerationFailure(task, modelId, err2);
          }
        } else if (!alreadyCpu) {
          console.warn(`[onnx] OOM during ${task}, unloading other pipelines and retrying once`);
          await unloadOthersExcept(task, modelId);
          const reloaded = await ensureLoaded(task, modelId);
          if (reloaded?.error) return reloaded;
          if (!reloaded?.pipeline && !reloaded?.model) {
            return errorResponse(`Failed to reload model "${modelId}" after OOM.`, "oom");
          }
          try {
            raw = await invokeEntry(reloaded, task, request.input, options);
          } catch (err2) {
            return await handleGenerationFailure(task, modelId, err2);
          }
        } else {
          return await handleGenerationFailure(task, modelId, err);
        }
      } else {
        return await handleGenerationFailure(task, modelId, err);
      }
    }

    return { task, model: modelId, output: normalizeOutput(task, raw, options) };
  } finally {
    busy = false;
  }
}

async function invokeMinistral(entry, input, options) {
  const { model, processor } = entry;
  const { load_image } = await loadTransformers();
  const rawMessages = Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
  const { messages, imageSources } = toGemmaMessages(rawMessages);
  const templateOpts = { add_generation_prompt: true };
  if (options?.tools?.length) templateOpts.tools = options.tools;
  const prompt = processor.apply_chat_template(messages, templateOpts);

  let images = null;
  if (imageSources.length === 1) {
    images = await load_image(imageSources[0]);
  } else if (imageSources.length > 1) {
    images = await Promise.all(imageSources.map((src) => load_image(src)));
  }

  const inputs = await processor(prompt, images, { add_special_tokens: false });
  const maxNewTokens = resolveMaxTokens(options.max_new_tokens ?? options.max_tokens);
  const temperature = options.temperature ?? 0.2;
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    temperature,
    do_sample: temperature > 0,
    top_p: options.top_p ?? DEFAULT_TOP_P,
  });
  const promptLen = inputs.input_ids.dims.at(-1);
  const completionLen = Math.max(0, outputs.dims.at(-1) - promptLen);
  const decoded = processor.batch_decode(outputs.slice(null, [promptLen, null]), {
    skip_special_tokens: true,
  });
  return [{ generated_text: decoded?.[0] ?? "", prompt, usage: { prompt_tokens: promptLen, completion_tokens: completionLen } }];
}

async function invokeGemma4(entry, input, options) {
  const { model, processor } = entry;
  const { load_image } = await loadTransformers();
  const rawMessages = Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
  const { messages, imageSources } = toGemmaMessages(rawMessages);

  const templateOpts = {
    enable_thinking: options.enable_thinking !== false,
    add_generation_prompt: true,
  };
  if (options?.tools?.length) templateOpts.tools = options.tools;
  const prompt = processor.apply_chat_template(messages, templateOpts);

  let images = null;
  if (imageSources.length === 1) {
    images = await load_image(imageSources[0]);
  } else if (imageSources.length > 1) {
    images = await Promise.all(imageSources.map((src) => load_image(src)));
  }

  // Transformers.js: processor(text, images?, audio?, opts) — pass null when unused.
  const inputs = await processor(prompt, images, null, { add_special_tokens: false });
  const maxNewTokens = resolveMaxTokens(options.max_new_tokens ?? options.max_tokens);
  const temperature = options.temperature ?? 0.2;
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    temperature,
    do_sample: temperature > 0,
    top_p: options.top_p ?? DEFAULT_TOP_P,
  });
  const promptLen = inputs.input_ids.dims.at(-1);
  const completionLen = Math.max(0, outputs.dims.at(-1) - promptLen);
  const decoded = processor.batch_decode(outputs.slice(null, [promptLen, null]), {
    skip_special_tokens: true,
  });
  return [{ generated_text: decoded?.[0] ?? "", prompt, usage: { prompt_tokens: promptLen, completion_tokens: completionLen } }];
}

async function invokeEntry(entry, task, input, options) {
  if (entry?.kind === "gemma4") return invokeGemma4(entry, input, options);
  if (entry?.kind === "ministral") return invokeMinistral(entry, input, options);
  if (task === TEXT_GENERATION) return invokeTextLlm(entry.pipeline, input, options, entry);
  return invokePipeline(entry.pipeline, task, input, options);
}

/** Some HF chat templates accept enable_thinking (Qwen3 family). */
function templateThinkingExtra(modelId, thinkingEnabled) {
  if (!isQwen3ThinkingModel(modelId) && !/qwen3/i.test(modelId || "")) return {};
  return { enable_thinking: thinkingEnabled };
}

/** Render the chat-template string the tokenizer would feed the model (for Dialogue raw view). */
function renderChatPrompt(pipe, input, tools, templateExtra = {}) {
  try {
    const tokenizer = pipe?.tokenizer;
    if (tokenizer?.apply_chat_template && Array.isArray(input)) {
      const opts = { tokenize: false, add_generation_prompt: true, ...templateExtra };
      if (tools?.length) opts.tools = tools;
      return tokenizer.apply_chat_template(input, opts);
    }
  } catch (err) {
    console.warn("[onnx] could not render chat prompt:", err);
  }
  return typeof input === "string" ? input : null;
}

/** Approximate token count for the plain pipeline path — retokenizes text with
 * no forward pass. Prompt/completion are tokenized separately (not one combined
 * sequence), so this can be off by a token or two vs. what was actually fed
 * to the model; still real numbers, not the hardcoded zeros this replaces. */
function tokenizeUsage(tokenizer, prompt, generatedText) {
  if (!tokenizer) return null;
  try {
    const promptTokens = typeof prompt === "string" ? tokenizer(prompt).input_ids.dims.at(-1) : null;
    const completionTokens =
      typeof generatedText === "string" ? tokenizer(generatedText).input_ids.dims.at(-1) : null;
    if (promptTokens == null && completionTokens == null) return null;
    return { prompt_tokens: promptTokens ?? 0, completion_tokens: completionTokens ?? 0 };
  } catch (err) {
    console.warn("[onnx] token count failed:", err);
    return null;
  }
}

/**
 * Text LLMs loaded as a pipeline entry. Uses model.generate directly so completion
 * is sliced by token index (like Gemma 4). TextGenerationPipeline strips the prompt
 * by decoded string length, which corrupts Qwen/Llama outputs that use chat tokens.
 */
async function invokeTextLlm(pipe, input, options, entry) {
  const { model, tokenizer } = pipe;
  if (!model || !tokenizer) {
    throw new Error("Text-generation pipeline is missing model or tokenizer");
  }

  const maxNewTokens = resolveMaxTokens(options.max_new_tokens ?? options.max_tokens);
  const temperature = options.temperature ?? 0.2;
  const tools = options?.tools?.length ? options.tools : undefined;
  const templateExtra = templateThinkingExtra(entry?.id ?? entry?.model, options.enable_thinking !== false);
  const prompt = renderChatPrompt(pipe, input, tools, templateExtra);
  const promptText =
    typeof prompt === "string" ? prompt : typeof input === "string" ? input : null;
  if (!promptText) {
    throw new Error("Could not render chat prompt for text-generation input");
  }

  const inputs = tokenizer(promptText, { add_special_tokens: false });
  // TEMP diagnostics for the Qwen hang investigation — remove once root-caused.
  const diagStart = Date.now();
  let diagStepCount = 0;
  const diagStreamer = {
    put(ids) {
      diagStepCount++;
      const flat = Array.isArray(ids) ? ids.flat(2) : ids;
      console.log(`[onnx][diag] +${Date.now() - diagStart}ms step=${diagStepCount} ids=${flat.map(String).join(",")}`);
    },
    end() {
      console.log(`[onnx][diag] stream end after ${Date.now() - diagStart}ms, ${diagStepCount} put() calls`);
    },
  };
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    temperature,
    do_sample: temperature > 0,
    streamer: diagStreamer,
    top_p: options.top_p ?? DEFAULT_TOP_P,
  });
  const promptLen = inputs.input_ids.dims.at(-1);
  const completionLen = Math.max(0, outputs.dims.at(-1) - promptLen);
  const completionSlice = outputs.slice(null, [promptLen, null]);
  const decoded = tokenizer.batch_decode(completionSlice, {
    skip_special_tokens: true,
  });
  // TEMP diagnostics for the Qwen garbling investigation — remove once root-caused.
  try {
    const ids = Array.from(completionSlice.data ?? completionSlice.ort_tensor?.data ?? []);
    const eos = model.generation_config?.eos_token_id;
    console.log(
      `[onnx][diag] device=${entry?.sessionDevice} dtype=${entry?.modelDtype} vocab_size=${model.config?.vocab_size} ` +
        `promptLen=${promptLen} completionLen=${completionLen} eos_token_id=${JSON.stringify(eos)}`
    );
    console.log(`[onnx][diag] first 40 completion ids: ${ids.slice(0, 40).join(",")}`);
    console.log(`[onnx][diag] last 20 completion ids: ${ids.slice(-20).join(",")}`);
    console.log(`[onnx][diag] raw decoded (no skip_special_tokens): ${JSON.stringify(tokenizer.batch_decode(completionSlice, { skip_special_tokens: false })?.[0]?.slice(0, 400))}`);
  } catch (diagErr) {
    console.warn("[onnx][diag] failed:", diagErr);
  }
  return [
    {
      generated_text: decoded?.[0] ?? "",
      prompt: promptText,
      usage: { prompt_tokens: promptLen, completion_tokens: completionLen },
    },
  ];
}

async function invokePipeline(pipe, task, input, options) {
  if (task === IMAGE_TEXT_TO_TEXT) {
    const maxNewTokens = resolveMaxTokens(options.max_new_tokens ?? options.max_tokens);
    const temperature = options.temperature ?? 0.2;
    const tools = options?.tools?.length ? options.tools : undefined;
    const prompt = renderChatPrompt(pipe, input, tools);
    const pipeInput =
      pipe?.tokenizer?.apply_chat_template && Array.isArray(input) && typeof prompt === "string"
        ? prompt
        : input;
    const raw = await pipe(pipeInput, {
      max_new_tokens: maxNewTokens,
      temperature,
      do_sample: temperature > 0,
      top_p: options.top_p ?? DEFAULT_TOP_P,
      return_full_text: false,
    });
    if (prompt != null && Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
      raw[0].prompt = prompt;
      raw[0].usage = tokenizeUsage(pipe?.tokenizer, prompt, raw[0].generated_text);
    }
    return raw;
  }
  if (task === "image-classification") {
    const topk = options.topK ?? options.topk ?? 5;
    return pipe(input, { topk });
  }
  if (task === "automatic-speech-recognition") {
    return pipe(input, options);
  }
  if (task === FEATURE_EXTRACTION) {
    return pipe(input, { pooling: "mean", normalize: true });
  }
  // image-to-text and other VisionEncoderDecoder-style pipelines
  return pipe(input, options);
}

function extractGeneratedText(generated) {
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    for (let i = generated.length - 1; i >= 0; i--) {
      const m = generated[i];
      if (m?.role === "assistant" && typeof m.content === "string") return m.content;
    }
    const last = generated.at(-1);
    if (typeof last?.content === "string") return last.content;
  }
  return generated != null ? String(generated) : "";
}

function normalizeOutput(task, raw, options) {
  if (task === TEXT_GENERATION || task === IMAGE_TEXT_TO_TEXT) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    const content = extractGeneratedText(first?.generated_text ?? "");
    return {
      text: content,
      prompt: typeof first?.prompt === "string" ? first.prompt : null,
      usage: first?.usage ?? null,
    };
  }
  if (task === "image-to-text") {
    const first = Array.isArray(raw) ? raw[0] : raw;
    const caption = first?.generated_text ?? (typeof first === "string" ? first : JSON.stringify(first));
    return { caption };
  }
  if (task === "image-classification") {
    const list = Array.isArray(raw) ? raw : [raw];
    const topK = options.topK ?? options.topk ?? 5;
    return {
      labels: list.slice(0, topK).map((r) => ({
        label: r?.label ?? String(r),
        score: typeof r?.score === "number" ? r.score : null,
      })),
    };
  }
  if (task === "automatic-speech-recognition") {
    const text = typeof raw === "string" ? raw : raw?.text ?? "";
    return { text };
  }
  if (task === FEATURE_EXTRACTION) {
    const tensor = raw?.data != null ? raw : Array.isArray(raw) ? raw[0] : raw;
    let vec = [];
    if (tensor?.data) vec = Array.from(tensor.data);
    else if (Array.isArray(tensor)) vec = tensor.flat();
    else if (tensor?.tolist) vec = tensor.tolist().flat();
    return { embedding: vec, dims: vec.length };
  }
  return raw;
}

async function runRenderChatPromptOnly(request) {
  const modelId = request?.model;
  if (!modelId) return { prompt: null };

  const messages = request.messages;
  if (!Array.isArray(messages)) return { prompt: null };

  const task = registryEntry(modelId)?.task || TEXT_GENERATION;
  const tools = Array.isArray(request.tools) && request.tools.length ? request.tools : undefined;

  const entryOrErr = await ensureLoaded(task, modelId);
  if (entryOrErr?.error) {
    console.warn("[onnx] render prompt:", entryOrErr.error?.message);
    return { prompt: null };
  }

  const prompt = renderPromptFromEntry(entryOrErr, messages, tools, request);
  return { prompt: typeof prompt === "string" ? prompt : null };
}

function renderPromptFromEntry(entry, messages, tools, request) {
  const toolsOpt = tools?.length ? tools : undefined;
  const thinkingEnabled = request?.thinkingEnabled !== false;
  if (entry?.kind === "gemma4" || entry?.kind === "ministral") {
    const { processor } = entry;
    if (!processor?.apply_chat_template) return null;
    const rawMessages = Array.isArray(messages) ? messages : [];
    const { messages: gemmaMsgs } = toGemmaMessages(rawMessages);
    const templateOpts = { add_generation_prompt: true };
    if (toolsOpt) templateOpts.tools = toolsOpt;
    if (entry.kind === "gemma4") templateOpts.enable_thinking = thinkingEnabled;
    try {
      return processor.apply_chat_template(gemmaMsgs, templateOpts);
    } catch (err) {
      console.warn("[onnx] could not render chat prompt:", err);
      return null;
    }
  }
  const modelId = request?.model ?? entry?.id;
  const templateExtra = templateThinkingExtra(modelId, thinkingEnabled);
  return renderChatPrompt(entry?.pipeline, messages, toolsOpt, templateExtra);
}

async function runChatCompletions(request) {
  const modelId = request.model;
  if (!modelId) return errorResponse("No model specified.", "model_not_loaded");

  const task = registryEntry(modelId)?.task || TEXT_GENERATION;
  const thinkingEnabled = request.thinkingEnabled !== false;
  const result = await runInference({
    task,
    model: modelId,
    input: request.messages,
    options: {
      max_new_tokens: resolveMaxTokens(request.max_tokens),
      temperature: request.temperature ?? 0.2,
      enable_thinking: thinkingEnabled,
      ...(Array.isArray(request.tools) && request.tools.length ? { tools: request.tools } : {}),
    },
  });

  if (result.error) return result;

  const content = result.output?.text ?? "";
  const finishReason = content.length > 0 ? "stop" : "length";
  const usage = result.output?.usage;
  const response = toResponse(result.model, content, finishReason, {
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    total_tokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
  });
  // Chat-template string actually tokenized for the local model (Dialogue "Prompt" raw mode).
  if (typeof result.output?.prompt === "string") response.prompt = result.output.prompt;
  return response;
}

async function handleLoadFailure(task, modelId, err) {
  const message = String(err?.message || err);
  console.error(`[onnx] failed to load ${task} ${modelId}:`, message);
  if (isGpuResourceError(message) && device === "webgpu") {
    if (isLlmTask(task)) {
      const smaller = nextSmallerModel(modelId);
      if (smaller) {
        console.warn(`[onnx] OOM loading ${modelId}, retrying once on smaller model ${smaller}`);
        await unload({ task });
        try {
          const smallerTask = registryEntry(smaller)?.task || task;
          await loadModel({ task: smallerTask, model: smaller });
          return errorResponse(
            `"${modelId}" ran out of GPU memory, so I loaded "${smaller}" instead. Retry your request.`,
            "oom"
          );
        } catch (err2) {
          return errorResponse(`Out of memory loading "${modelId}", and the smaller fallback also failed: ${err2.message}`, "oom");
        }
      }
    } else {
      await unloadOthersExcept(task, modelId);
      try {
        await loadModel({ task, model: modelId });
        return errorResponse(
          `Ran out of GPU memory loading "${modelId}". Other pipelines were unloaded — retry your request.`,
          "oom"
        );
      } catch (err2) {
        return errorResponse(`Out of memory loading "${modelId}": ${err2.message}`, "oom");
      }
    }
  }
  if (/bits.must be 4 or 8|GatherBlockQuantized/i.test(message)) {
    return errorResponse(
      `Failed to load "${modelId}": WebGPU only supports 4/8-bit weights. Mobile QAT (q2f16) must run on CPU — reload the extension and try again, or pick Gemma 4 E2B/E4B (non-mobile) for GPU.`,
      "engine_error"
    );
  }
  if (/webgpuInit is not a function|no available backend/i.test(message)) {
    return errorResponse(
      `Failed to load "${modelId}": WebGPU/ORT runtime mismatch. Reload the extension from chrome://extensions ` +
        `(needed after upgrading Transformers.js), then download again.`,
      "engine_error"
    );
  }
  if (/Aborted\s*\(/i.test(message)) {
    return errorResponse(
      `ORT WASM aborted while loading "${modelId}". Weights may already be in IndexedDB — the failure is runtime init. ` +
        `Reload the extension and confirm the worker console shows inWorker=true (chrome://inspect/#other → ort-worker).`,
      "engine_error"
    );
  }
  return errorResponse(`Failed to load model "${modelId}": ${message}`, "download_failed");
}

async function handleGenerationFailure(task, modelId, err) {
  const message = String(err?.message || err);
  console.error(`[onnx] ${task} failed for ${modelId}:`, message);
  if (isGpuResourceError(message)) {
    await unload({ task, model: modelId });
    return errorResponse(
      `Ran out of GPU/CPU memory running "${task}". ${gpuErrorHint()}`,
      "oom"
    );
  }
  return errorResponse(`Local ${task} failed: ${message}`, "engine_error");
}

function isOomError(message) {
  return /out of memory|oom|allocation failed/i.test(message);
}

/** WebGPU OOM often surfaces as mapAsync / invalid-buffer errors after an earlier GPU fault. */
function isGpuResourceError(message) {
  return (
    isOomError(message) ||
    /mapAsync|BufferManager::Download|Invalid Buffer|previous error/i.test(message) ||
    /webgpu.*buffer|GPUBuffer/i.test(message)
  );
}

function gpuErrorHint() {
  return (
    "Close other GPU-heavy apps (e.g. `ollama stop` if a large model is loaded), unload other ONNX models, " +
    "use a smaller VLM (Gemma 4 E2B / Ministral 3B), or reduce max_tokens. Reload the extension if errors persist."
  );
}

function nextSmallerModel(modelId) {
  const llm = llmRegistry();
  const idx = llm.findIndex((m) => m.id === modelId);
  if (idx <= 0) return null;
  return llm[idx - 1].id;
}
