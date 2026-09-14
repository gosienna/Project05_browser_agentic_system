// Offscreen shell: owns chrome.runtime messaging and delegates ORT / WebLLM / wllama work to
// Dedicated Workers (Atomics.wait is illegal on the window/offscreen main thread).

const WORKERS = {
  "onnx-engine": {
    script: "llm-browser/ort-worker.js",
    readyType: "ort-worker-ready",
    label: "onnx",
  },
  "webllm-engine": {
    script: "llm-browser/webllm-worker.js",
    readyType: "webllm-worker-ready",
    label: "webllm",
  },
  "wllama-engine": {
    script: "llm-browser/wllama-worker.js",
    readyType: "wllama-worker-ready",
    label: "wllama",
  },
};

/** @type {Map<string, { worker: Worker, ready: Promise<void>, pending: Map<number, { resolve: Function }>, seq: number }>} */
const hosts = new Map();

function createWorkerHost(target) {
  const spec = WORKERS[target];
  if (!spec) throw new Error(`Unknown engine target "${target}"`);

  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const host = {
    worker: new Worker(chrome.runtime.getURL(spec.script), { type: "module" }),
    ready,
    pending: new Map(),
    seq: 0,
  };

  host.worker.addEventListener("message", (event) => {
    const data = event.data || {};

    if (data.type === spec.readyType) {
      console.log(`[${spec.label}] offscreen ↔ ${spec.script} linked`);
      readyResolve();
      return;
    }

    if (data.type === "chrome.runtime.sendMessage") {
      chrome.runtime.sendMessage(data.message).catch(() => {});
      return;
    }

    if (data.type === "engine.unloadPeer") {
      callWorker(data.peer, data.msg).catch((err) =>
        console.warn(`[${spec.label}] peer unload ${data.peer}:`, err)
      );
      return;
    }

    const { id, result } = data;
    if (id == null) return;
    const waiter = host.pending.get(id);
    if (!waiter) return;
    host.pending.delete(id);
    waiter.resolve(result);
  });

  host.worker.addEventListener("error", (event) => {
    console.error(`[${spec.label}] worker error:`, event.message, event);
  });

  host.worker.addEventListener("messageerror", (event) => {
    console.error(`[${spec.label}] worker messageerror:`, event);
  });

  hosts.set(target, host);
  return host;
}

function getHost(target) {
  if (!hosts.has(target)) createWorkerHost(target);
  return hosts.get(target);
}

function callWorker(target, msg) {
  const host = getHost(target);
  return host.ready.then(
    () =>
      new Promise((resolve, reject) => {
        const id = ++host.seq;
        host.pending.set(id, { resolve });
        try {
          host.worker.postMessage({ id, msg });
        } catch (err) {
          host.pending.delete(id);
          reject(err);
        }
      })
  );
}

/** Interrupt in-flight generation; no reply expected from the worker. */
function abortWorker(target) {
  const host = getHost(target);
  return host.ready.then(() => {
    host.worker.postMessage({ msg: { type: "chat.abort" } });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg.target !== "onnx-engine" && msg.target !== "webllm-engine" && msg.target !== "wllama-engine")) {
    return;
  }

  if (msg.type === "chat.abort") {
    abortWorker(msg.target)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          error: { message: err?.message || String(err), type: "engine_error", code: null },
        })
      );
    return true;
  }

  callWorker(msg.target, msg)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        error: { message: err?.message || String(err), type: "engine_error", code: null },
      })
    );
  return true;
});

console.log("[local-engine] offscreen document ready (ORT + WebLLM + wllama worker host)");
