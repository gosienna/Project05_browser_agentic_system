// Message router for the "onnx-engine" target. Runs inside the persistent
// offscreen document so loaded model weights survive service-worker eviction.
import * as engine from "./engine.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "onnx-engine") return;

  handle(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: { message: err?.message || String(err), type: "engine_error", code: null } }));
  return true; // keep the message channel open for the async response
});

async function handle(msg) {
  switch (msg.type) {
    case "chat.completions":
      return engine.chatCompletions(msg.request);
    case "engine.status":
      return engine.status();
    case "engine.load":
      return engine.loadModel(msg.model);
    case "engine.unload":
      return engine.unload();
    case "engine.models":
      return { models: engine.MODEL_REGISTRY };
    default:
      return { error: { message: `Unknown onnx-engine message type "${msg.type}"`, type: "engine_error", code: null } };
  }
}

console.log("[onnx] offscreen document ready");
