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
    ui: comps.ui,
    tools: comps.tools,
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "system.reload" && msg.systemId === systemId) {
    loadComponents().catch((err) => setStatus(err.message, true));
  }
});

frame.addEventListener("load", () => {
  sandboxReady = false;
  loadComponents().catch((err) => setStatus(err.message, true));
});

loadComponents().catch((err) => setStatus(err.message, true));
