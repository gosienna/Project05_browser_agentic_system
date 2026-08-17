// Runs wllama / llama.cpp WASM inside a Dedicated Worker.
import "./chrome-polyfill.js";
import * as engine from "./wllama-engine.js";

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
    case "engine.status":
      return engine.status();
    case "engine.load":
      return engine.loadModel(msg.model || msg.request?.model);
    case "engine.unload":
      return engine.unload();
    case "engine.clearCache":
      return engine.clearCache();
    case "engine.deleteModel":
      return engine.deleteModel(msg.model || msg.request?.model);
    case "engine.models":
      return { models: await engine.modelsForTask() };
    case "engine.contextEstimate":
      return engine.getContextEstimate(msg.model || msg.request?.model);
    default:
      return {
        error: {
          message: `Unknown wllama-engine message type "${msg.type}"`,
          type: "engine_error",
          code: null,
        },
      };
  }
}

self.postMessage({ type: "wllama-worker-ready" });
console.log("[wllama] wllama-worker ready (Dedicated Worker)");
