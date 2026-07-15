// Offscreen shell: owns chrome.runtime messaging and delegates all ORT work to
// a Dedicated Worker (Atomics.wait is illegal on the window/offscreen main
// thread and causes "Aborted()" with the threaded ORT WASM build).

const worker = new Worker(chrome.runtime.getURL("ort-worker.js"), { type: "module" });
let seq = 0;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pending = new Map();
let workerReady = new Promise((resolve) => {
  const onReady = (event) => {
    if (event.data?.type === "ort-worker-ready") {
      worker.removeEventListener("message", onReady);
      console.log("[onnx] offscreen ↔ ort-worker linked");
      resolve();
    }
  };
  worker.addEventListener("message", onReady);
});

worker.addEventListener("message", (event) => {
  const data = event.data || {};

  // Worker chrome.* shim → real extension messaging (progress, model-ready).
  if (data.type === "chrome.runtime.sendMessage") {
    chrome.runtime.sendMessage(data.message).catch(() => {});
    return;
  }

  const { id, result } = data;
  if (id == null) return;
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  waiter.resolve(result);
});

worker.addEventListener("error", (event) => {
  console.error("[onnx] ort-worker error:", event.message, event);
});

worker.addEventListener("messageerror", (event) => {
  console.error("[onnx] ort-worker messageerror:", event);
});

function callWorker(msg) {
  return workerReady.then(
    () =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ id, msg });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      })
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "onnx-engine") return;

  callWorker(msg)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        error: { message: err?.message || String(err), type: "engine_error", code: null },
      })
    );
  return true;
});

console.log("[onnx] offscreen document ready (worker host)");
