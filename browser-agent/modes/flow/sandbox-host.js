// Host a hidden Flow sandbox iframe and run node scripts with api.* bridged to the host.

const SANDBOX_PATH = "modes/flow/sandbox.html";

/** @type {HTMLIFrameElement|null} */
let iframe = null;
/** @type {Promise<void>|null} */
let readyPromise = null;
/** @type {Map<string, { resolve: Function, reject: Function, api: object }>} */
const pendingRuns = new Map();
let messageListenerInstalled = false;

function sandboxUrl() {
  return chrome.runtime.getURL(SANDBOX_PATH);
}

function installMessageListener() {
  if (messageListenerInstalled) return;
  messageListenerInstalled = true;
  window.addEventListener("message", onSandboxWindowMessage);
}

async function onSandboxWindowMessage(event) {
  if (!iframe || event.source !== iframe.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "flow-api-call" && msg.requestId != null && msg.callId != null) {
    const entry = pendingRuns.get(msg.requestId);
    if (!entry) return;
    try {
      const fn = entry.api?.[msg.method];
      if (typeof fn !== "function") throw new Error(`Unknown api.${msg.method}`);
      const result = await fn(...(msg.args || []));
      iframe.contentWindow.postMessage(
        { type: "flow-api-result", callId: msg.callId, result },
        "*"
      );
    } catch (err) {
      iframe.contentWindow.postMessage(
        {
          type: "flow-api-result",
          callId: msg.callId,
          error: err?.message || String(err),
        },
        "*"
      );
    }
    return;
  }

  if (msg.type === "flow-run-result" && msg.requestId != null) {
    const entry = pendingRuns.get(msg.requestId);
    if (!entry) return;
    pendingRuns.delete(msg.requestId);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.outputs && typeof msg.outputs === "object" ? msg.outputs : {});
  }
}

/**
 * Ensure a hidden sandbox iframe exists in this document.
 * @returns {Promise<void>}
 */
export function ensureFlowSandbox() {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("Flow sandbox host requires a document"));
  }
  installMessageListener();
  if (iframe && readyPromise) return readyPromise;

  iframe = document.createElement("iframe");
  iframe.src = sandboxUrl();
  iframe.title = "Flow script sandbox";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;";

  readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Flow sandbox failed to become ready"));
    }, 15000);
    function onReady(event) {
      if (event.source !== iframe.contentWindow) return;
      if (event.data?.type !== "flow-sandbox-ready") return;
      window.removeEventListener("message", onReady);
      clearTimeout(timer);
      resolve();
    }
    window.addEventListener("message", onReady);
    (document.body || document.documentElement).appendChild(iframe);
  });

  return readyPromise;
}

/**
 * Run a Flow node script inside the sandbox iframe.
 * @param {string} script
 * @param {object} inputs
 * @param {object} api host api from createFlowApi
 * @returns {Promise<object>} outputs
 */
export async function runNodeScriptInSandbox(script, inputs, api) {
  if (!api) throw new Error("runNodeScriptInSandbox requires api");
  await ensureFlowSandbox();
  const requestId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    pendingRuns.set(requestId, { resolve, reject, api });
    try {
      iframe.contentWindow.postMessage(
        {
          type: "flow-run",
          requestId,
          script: String(script || ""),
          inputs: inputs && typeof inputs === "object" ? inputs : {},
        },
        "*"
      );
    } catch (err) {
      pendingRuns.delete(requestId);
      reject(err);
    }
  });
}
