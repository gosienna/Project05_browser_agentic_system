// Transformers.js integration: device probing, model registry, pipeline
// cache, and OpenAI-shaped generation. Lives entirely inside the offscreen
// document (see plan §4). Phase 1: non-streaming only.

let transformersModule = null;
async function loadTransformers() {
  if (!transformersModule) {
    transformersModule = await import(chrome.runtime.getURL("vendor/transformers/transformers.min.js"));
    transformersModule.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
    transformersModule.env.allowRemoteModels = true;
    // Offscreen documents aren't reliably cross-origin-isolated, so
    // SharedArrayBuffer isn't guaranteed. The threaded wasm build spawns
    // worker threads unconditionally on init and aborts if that fails
    // ("Aborted()" from ort-wasm-simd-threaded[.jsep].mjs) — force
    // single-threaded mode so it never tries. This applies to both the
    // wasm and webgpu (jsep) backends, which share this binary.
    transformersModule.env.backends.onnx.wasm.numThreads = 1;
  }
  return transformersModule;
}

// Repo ids verified against the HF Hub API (many onnx-community models carry
// an "-ONNX" or "-onnx-web" suffix not obvious from the base model name).
export const MODEL_REGISTRY = [
  { id: "onnx-community/Llama-3.2-1B-Instruct-ONNX", label: "Llama 3.2 1B", approxSizeMB: 700, tier: "fast" },
  { id: "onnx-community/Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B", approxSizeMB: 1000, tier: "fast" },
  { id: "onnx-community/Llama-3.2-3B-Instruct-ONNX", label: "Llama 3.2 3B", approxSizeMB: 1800, tier: "default" },
  { id: "onnx-community/Phi-3.5-mini-instruct-onnx-web", label: "Phi 3.5 mini (3.8B)", approxSizeMB: 2200, tier: "max" },
];

const DEFAULT_TOP_P = 0.9;

let device = null; // "webgpu" | "wasm", probed once and cached
let dtype = null;
let currentModelId = null;
let currentPipeline = null;
let busy = false;
let queue = Promise.resolve();

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
  return {
    device,
    dtype,
    loadedModel: currentModelId,
    busy,
    registry: MODEL_REGISTRY,
  };
}

export async function unload() {
  if (currentPipeline?.dispose) {
    try {
      await currentPipeline.dispose();
    } catch {
      // best-effort
    }
  }
  currentPipeline = null;
  currentModelId = null;
  return status();
}

export async function loadModel(modelId) {
  if (currentModelId === modelId && currentPipeline) return status();

  const { pipeline } = await loadTransformers();
  const { device: d, dtype: dt } = await probeDevice();

  if (currentPipeline) await unload();

  console.log(`[onnx] loading ${modelId} on ${d} (${dt})`);
  currentPipeline = await pipeline("text-generation", modelId, {
    device: d,
    dtype: dt,
    progress_callback: (event) => {
      broadcastProgress({ file: event.file, status: event.status, progress: event.progress, loaded: event.loaded, total: event.total, model: modelId });
    },
  });
  currentModelId = modelId;
  markDownloaded(modelId);
  console.log(`[onnx] ${modelId} ready`);
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

/** FIFO-serialize concurrent requests (trackers + chat may collide). */
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

export function chatCompletions(request) {
  return enqueue(() => runChatCompletions(request));
}

async function runChatCompletions(request) {
  const modelId = request.model;
  if (!modelId) return errorResponse("No model specified.", "model_not_loaded");

  busy = true;
  try {
    if (currentModelId !== modelId) {
      await loadModel(modelId);
    }
  } catch (err) {
    busy = false;
    return await handleLoadFailure(modelId, err);
  }

  try {
    const maxNewTokens = request.max_tokens ?? 512;
    const temperature = request.temperature ?? 0.2;
    const output = await currentPipeline(request.messages, {
      max_new_tokens: maxNewTokens,
      temperature,
      do_sample: temperature > 0,
      top_p: DEFAULT_TOP_P,
      return_full_text: false,
    });

    const text = Array.isArray(output) ? output[0]?.generated_text ?? "" : output?.generated_text ?? "";
    const content = typeof text === "string" ? text : text?.at?.(-1)?.content ?? String(text);
    const finishReason = content.length > 0 ? "stop" : "length";

    return toResponse(modelId, content, finishReason, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  } catch (err) {
    return await handleGenerationFailure(modelId, err);
  } finally {
    busy = false;
  }
}

async function handleLoadFailure(modelId, err) {
  const message = String(err?.message || err);
  console.error(`[onnx] failed to load ${modelId}:`, message);
  if (isOomError(message) && device === "webgpu") {
    const smaller = nextSmallerModel(modelId);
    if (smaller) {
      console.warn(`[onnx] OOM loading ${modelId}, retrying once on smaller model ${smaller}`);
      await unload();
      try {
        await loadModel(smaller);
        return errorResponse(
          `"${modelId}" ran out of GPU memory, so I loaded "${smaller}" instead. Retry your request.`,
          "oom"
        );
      } catch (err2) {
        return errorResponse(`Out of memory loading "${modelId}", and the smaller fallback also failed: ${err2.message}`, "oom");
      }
    }
  }
  return errorResponse(`Failed to load model "${modelId}": ${message}`, "download_failed");
}

async function handleGenerationFailure(modelId, err) {
  const message = String(err?.message || err);
  console.error(`[onnx] generation failed for ${modelId}:`, message);
  if (isOomError(message)) {
    await unload();
    return errorResponse(`Ran out of memory generating a response. The model was unloaded — try a smaller model.`, "oom");
  }
  return errorResponse(`Local generation failed: ${message}`, "engine_error");
}

function isOomError(message) {
  return /out of memory|oom|allocation failed/i.test(message);
}

function nextSmallerModel(modelId) {
  const idx = MODEL_REGISTRY.findIndex((m) => m.id === modelId);
  if (idx <= 0) return null;
  return MODEL_REGISTRY[idx - 1].id;
}
