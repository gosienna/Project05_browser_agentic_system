import { ensureSeeded, getAllComponents, getSystem } from "./system-store.js";

const params = new URLSearchParams(location.search);
const systemId = params.get("id");
const frame = document.getElementById("frame");
const statusEl = document.getElementById("status");
let sandboxReady = false;
let pendingLoad = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function loadComponents() {
  if (!systemId) {
    setStatus("Missing system id (?id=…)", true);
    return;
  }
  await ensureSeeded();
  const system = await getSystem(systemId);
  if (!system) {
    setStatus(`Unknown system ${systemId}`, true);
    return;
  }
  document.title = system.name;
  const comps = await getAllComponents(systemId);
  const payload = {
    type: "load",
    html: comps.html,
    css: comps.css,
    script: comps.script,
  };
  if (sandboxReady && frame.contentWindow) {
    frame.contentWindow.postMessage(payload, "*");
    setStatus(`${system.name} · ready`);
  } else {
    pendingLoad = payload;
    setStatus(`${system.name} · waiting for sandbox…`);
  }
}

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  // Only accept api calls from our sandbox iframe
  if (msg.type === "api") {
    if (event.source !== frame.contentWindow) return;
    const { requestId, op, ...rest } = msg;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "tabBridge",
        op,
        ...rest,
      });
      if (response?.error) throw new Error(response.error);
      frame.contentWindow.postMessage({ type: "api-result", requestId, result: response?.result }, "*");
    } catch (err) {
      frame.contentWindow.postMessage(
        { type: "api-result", requestId, error: err?.message || String(err) },
        "*"
      );
    }
    return;
  }

  if (msg.type === "sandbox-boot" || msg.type === "sandbox-ready") {
    if (event.source !== frame.contentWindow) return;
    sandboxReady = true;
    if (pendingLoad) {
      frame.contentWindow.postMessage(pendingLoad, "*");
      pendingLoad = null;
    }
    if (msg.type === "sandbox-ready") setStatus("ready");
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "system.reload" && msg.systemId === systemId) {
    loadComponents().catch((err) => setStatus(err.message, true));
    return;
  }
  if (msg?.type === "webapp-dom-exec") {
    forwardDomExec(msg)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
});

frame.addEventListener("load", () => {
  sandboxReady = false;
  loadComponents().catch((err) => setStatus(err.message, true));
});

const domPending = new Map();
let domSeq = 0;

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type !== "dom-exec-result" || msg.requestId == null) return;
  const entry = domPending.get(msg.requestId);
  if (!entry) return;
  domPending.delete(msg.requestId);
  if (msg.error) entry.reject(new Error(msg.error));
  else entry.resolve(msg.result);
});

function forwardDomExec({ funcSource, args, world }) {
  return new Promise((resolve, reject) => {
    if (!frame.contentWindow) {
      reject(new Error("WebApp sandbox iframe is not ready"));
      return;
    }
    const requestId = ++domSeq;
    domPending.set(requestId, { resolve, reject });
    frame.contentWindow.postMessage({ type: "dom-exec", requestId, funcSource, args, world }, "*");
    setTimeout(() => {
      if (!domPending.has(requestId)) return;
      domPending.delete(requestId);
      reject(new Error("WebApp dom-exec timed out"));
    }, 60000);
  });
}

loadComponents().catch((err) => setStatus(err.message, true));
