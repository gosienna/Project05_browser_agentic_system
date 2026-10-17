// Runs inside a Chrome extension sandbox page (relaxed CSP — allows AsyncFunction).
// Host posts { type: "flow-run", requestId, script, inputs }; api.* is proxied back.

const pendingApi = new Map();
const API_METHODS = new Set([
  "open_tab",
  "navigate",
  "list_tabs",
  "browser_snapshot",
  "get_page_html",
  "wait",
  "llm",
]);

function callHostApi(requestId, method, args) {
  if (method === "wait") {
    const ms = Math.max(0, Number(args?.[0]) || 0);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  const callId = `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    pendingApi.set(callId, { resolve, reject });
    parent.postMessage(
      {
        type: "flow-api-call",
        requestId,
        callId,
        method,
        args: Array.isArray(args) ? args : [],
      },
      "*"
    );
  });
}

function createProxyApi(requestId) {
  const api = {};
  for (const method of API_METHODS) {
    api[method] = (...args) => callHostApi(requestId, method, args);
  }
  return api;
}

async function runScript(script, inputs, api) {
  const outputs = {};
  const body = String(script || "").trim();
  if (!body) return outputs;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("inputs", "outputs", "api", `"use strict";\n${body}\n`);
  const result = await fn(inputs && typeof inputs === "object" ? inputs : {}, outputs, api);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    Object.assign(outputs, result);
  }
  return outputs;
}

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "flow-api-result" && msg.callId != null) {
    const pending = pendingApi.get(msg.callId);
    if (!pending) return;
    pendingApi.delete(msg.callId);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
    return;
  }

  if (msg.type !== "flow-run" || msg.requestId == null) return;

  try {
    const outputs = await runScript(msg.script, msg.inputs, createProxyApi(msg.requestId));
    parent.postMessage({ type: "flow-run-result", requestId: msg.requestId, outputs }, "*");
  } catch (err) {
    parent.postMessage(
      {
        type: "flow-run-result",
        requestId: msg.requestId,
        error: err?.message || String(err),
      },
      "*"
    );
  }
});

parent.postMessage({ type: "flow-sandbox-ready" }, "*");
