// Transformers.js multi-task engine: device probing, task-keyed model registry,
// pipeline cache, run() for any supported task, and OpenAI-shaped chat for
// text-generation. Intended to run inside ort-worker.js (Dedicated Worker).

import { applyIndexedDbCache, clearModelCache, deleteModelFromCache, listCachedFiles } from "./model-cache.js";

const VENDOR_DIR = "vendor/transformers/";
// transformers.js ≥4 uses asyncify for WebGPU (exports webgpuInit).
// Older jsep builds export jsepInit instead — loading them for WebGPU yields:
// "Ae(...).webgpuInit is not a function".
const ASYNCIFY_WASM = "ort-wasm-simd-threaded.asyncify.wasm";
const ASYNCIFY_MJS = "ort-wasm-simd-threaded.asyncify.mjs";
const CPU_WASM = "ort-wasm-simd-threaded.wasm";
const CPU_MJS = "ort-wasm-simd-threaded.mjs";

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
  { id: "onnx-community/Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B", approxSizeMB: 1000, tier: "fast", task: "text-generation", pipeline_tag: "text-generation", modality: "llm" },
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
];

/** Hugging Face pipeline_tag display names (Hub model-card taxonomy). */
export const PIPELINE_TAG_LABELS = {
  "text-generation": "Text Generation",
  "image-text-to-text": "Image-Text-to-Text",
  "any-to-any": "Any-to-Any",
  "image-to-text": "Image-to-Text",
  "image-classification": "Image Classification",
  "automatic-speech-recognition": "Automatic Speech Recognition",
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
const LLM_TASKS = [TEXT_GENERATION, IMAGE_TEXT_TO_TEXT];

let device = null; // "webgpu" | "wasm", probed once and cached
let dtype = null;
/** @type {Map<string, { pipeline: object, task: string, modelId: string }>} */
const loaded = new Map();
let busy = false;
let queue = Promise.resolve();

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
  if (entry?.dtype) return entry.dtype;
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

  const sessionDevice = sessionDeviceForModel(modelId, preferred);
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
      entry = { kind: "gemma4", model, processor, pipeline: null, task, modelId };
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
      entry = { kind: "ministral", model, processor, pipeline: null, task, modelId };
    } else {
      const pipelineOpts = {
        device: sessionDevice,
        progress_callback,
      };
      if (task === TEXT_GENERATION) pipelineOpts.dtype = modelDtype;
      const pipe = await pipeline(task, modelId, pipelineOpts);
      entry = { kind: "pipeline", pipeline: pipe, task, modelId };
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
      if (isOomError(message)) {
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
  const maxNewTokens = options.max_new_tokens ?? options.max_tokens ?? 512;
  const temperature = options.temperature ?? 0.2;
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    temperature,
    do_sample: temperature > 0,
    top_p: options.top_p ?? DEFAULT_TOP_P,
  });
  const promptLen = inputs.input_ids.dims.at(-1);
  const decoded = processor.batch_decode(outputs.slice(null, [promptLen, null]), {
    skip_special_tokens: true,
  });
  return [{ generated_text: decoded?.[0] ?? "", prompt }];
}

async function invokeGemma4(entry, input, options) {
  const { model, processor } = entry;
  const { load_image } = await loadTransformers();
  const rawMessages = Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
  const { messages, imageSources } = toGemmaMessages(rawMessages);

  const templateOpts = {
    enable_thinking: false,
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
  const maxNewTokens = options.max_new_tokens ?? options.max_tokens ?? 512;
  const temperature = options.temperature ?? 0.2;
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    temperature,
    do_sample: temperature > 0,
    top_p: options.top_p ?? DEFAULT_TOP_P,
  });
  const promptLen = inputs.input_ids.dims.at(-1);
  const decoded = processor.batch_decode(outputs.slice(null, [promptLen, null]), {
    skip_special_tokens: true,
  });
  return [{ generated_text: decoded?.[0] ?? "", prompt }];
}

async function invokeEntry(entry, task, input, options) {
  if (entry?.kind === "gemma4") return invokeGemma4(entry, input, options);
  if (entry?.kind === "ministral") return invokeMinistral(entry, input, options);
  return invokePipeline(entry.pipeline, task, input, options);
}

/** Render the chat-template string the tokenizer would feed the model (for Dialogue raw view). */
function renderChatPrompt(pipe, input, tools) {
  try {
    const tokenizer = pipe?.tokenizer;
    if (tokenizer?.apply_chat_template && Array.isArray(input)) {
      const opts = { tokenize: false, add_generation_prompt: true };
      if (tools?.length) opts.tools = tools;
      return tokenizer.apply_chat_template(input, opts);
    }
  } catch (err) {
    console.warn("[onnx] could not render chat prompt:", err);
  }
  return typeof input === "string" ? input : null;
}

async function invokePipeline(pipe, task, input, options) {
  if (task === TEXT_GENERATION || task === IMAGE_TEXT_TO_TEXT) {
    const maxNewTokens = options.max_new_tokens ?? options.max_tokens ?? 512;
    const temperature = options.temperature ?? 0.2;
    const tools = options?.tools?.length ? options.tools : undefined;
    const prompt = renderChatPrompt(pipe, input, tools);
    // Prefer chat-template path when tools are present so declarations are injected.
    let raw;
    if (tools && pipe?.tokenizer?.apply_chat_template && Array.isArray(input) && typeof prompt === "string") {
      raw = await pipe(prompt, {
        max_new_tokens: maxNewTokens,
        temperature,
        do_sample: temperature > 0,
        top_p: options.top_p ?? DEFAULT_TOP_P,
        return_full_text: false,
      });
    } else {
      raw = await pipe(input, {
        max_new_tokens: maxNewTokens,
        temperature,
        do_sample: temperature > 0,
        top_p: options.top_p ?? DEFAULT_TOP_P,
        return_full_text: false,
      });
    }
    if (prompt != null && Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
      raw[0].prompt = prompt;
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
  // image-to-text and other VisionEncoderDecoder-style pipelines
  return pipe(input, options);
}

function normalizeOutput(task, raw, options) {
  if (task === TEXT_GENERATION || task === IMAGE_TEXT_TO_TEXT) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    const text = first?.generated_text ?? "";
    const content = typeof text === "string" ? text : text?.at?.(-1)?.content ?? String(text);
    return { text: content, prompt: typeof first?.prompt === "string" ? first.prompt : null };
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
  return raw;
}

async function runChatCompletions(request) {
  const modelId = request.model;
  if (!modelId) return errorResponse("No model specified.", "model_not_loaded");

  const task = registryEntry(modelId)?.task || TEXT_GENERATION;
  const result = await runInference({
    task,
    model: modelId,
    input: request.messages,
    options: {
      max_new_tokens: request.max_tokens ?? 512,
      temperature: request.temperature ?? 0.2,
      ...(Array.isArray(request.tools) && request.tools.length ? { tools: request.tools } : {}),
    },
  });

  if (result.error) return result;

  const content = result.output?.text ?? "";
  const finishReason = content.length > 0 ? "stop" : "length";
  const response = toResponse(result.model, content, finishReason, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  // Chat-template string actually tokenized for the local model (Dialogue "Prompt" raw mode).
  if (typeof result.output?.prompt === "string") response.prompt = result.output.prompt;
  return response;
}

async function handleLoadFailure(task, modelId, err) {
  const message = String(err?.message || err);
  console.error(`[onnx] failed to load ${task} ${modelId}:`, message);
  if (isOomError(message) && device === "webgpu") {
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
  if (isOomError(message)) {
    await unload({ task, model: modelId });
    return errorResponse(`Ran out of memory running "${task}". The model was unloaded — try again or free other models.`, "oom");
  }
  return errorResponse(`Local ${task} failed: ${message}`, "engine_error");
}

function isOomError(message) {
  return /out of memory|oom|allocation failed/i.test(message);
}

function nextSmallerModel(modelId) {
  const llm = llmRegistry();
  const idx = llm.findIndex((m) => m.id === modelId);
  if (idx <= 0) return null;
  return llm[idx - 1].id;
}
