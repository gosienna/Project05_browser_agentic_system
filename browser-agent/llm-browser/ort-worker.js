// Runs Transformers.js / ORT inside a Dedicated Worker.
// The offscreen document's main thread cannot call Atomics.wait (used by the
// threaded ORT WASM build) — that throws RuntimeError: Aborted(). Workers can.
import "./chrome-polyfill.js";
import * as engine from "./engine.js";

self.onmessage = async (event) => {
  const { id, msg } = event.data || {};
  if (id == null || !msg) return;

  try {
    const result = await handle(msg);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({
      id,
      result: {
        error: {
          message: err?.message || String(err),
          type: "engine_error",
          code: null,
        },
      },
    });
  }
};

async function handle(msg) {
  switch (msg.type) {
    case "chat.completions":
      return engine.chatCompletions(msg.request);
    case "chat.renderPrompt":
      return engine.renderChatPromptOnly(msg.request);
    case "engine.run":
      return engine.run(msg.request);
    case "engine.status":
      return engine.status();
    case "engine.load": {
      const model = msg.model || msg.request?.model;
      const task = msg.task || msg.request?.task;
      return engine.loadModel(task ? { task, model } : model);
    }
    case "engine.unload": {
      const task = msg.task || msg.request?.task;
      const model = msg.model || msg.request?.model;
      if (task || model) return engine.unload({ task, model });
      return engine.unload();
    }
    case "engine.unloadLlm":
      return engine.unloadLlm();
    case "engine.clearCache":
      return engine.clearCache();
    case "engine.deleteModel":
      return engine.deleteModel(msg.model || msg.request?.model);
    case "engine.models": {
      const task = msg.task || msg.request?.task;
      if (task === "*") return { models: engine.MODEL_REGISTRY };
      return { models: engine.modelsForTask(task) };
    }
    case "engine.contextEstimate":
      return engine.getContextEstimate(msg.model || msg.request?.model);
    default:
      return {
        error: {
          message: `Unknown onnx-engine message type "${msg.type}"`,
          type: "engine_error",
          code: null,
        },
      };
  }
}

self.postMessage({ type: "ort-worker-ready" });
console.log("[onnx] ort-worker ready (Dedicated Worker)");
