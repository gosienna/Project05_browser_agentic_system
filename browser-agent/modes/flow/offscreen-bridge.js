// Offscreen bridge: host Flow sandbox iframe and relay run/api messages for the service worker.

import { ensureFlowSandbox, runNodeScriptInSandbox } from "./sandbox-host.js";

/** Active runs started from the service worker (api bridged via chrome.runtime). */
const swApiProxies = new Map();

function createSwBridgedApi(requestId) {
  const methods = [
    "open_tab",
    "navigate",
    "list_tabs",
    "browser_snapshot",
    "get_page_html",
    "wait",
    "llm",
  ];
  const api = {};
  for (const method of methods) {
    api[method] = async (...args) => {
      if (method === "wait") {
        const ms = Math.max(0, Number(args[0]) || 0);
        await new Promise((r) => setTimeout(r, ms));
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type: "flow.sandbox.api",
        requestId,
        method,
        args,
      });
      if (response?.error) throw new Error(response.error);
      return response?.result;
    };
  }
  return api;
}

/**
 * Handle background → offscreen Flow sandbox messages.
 * @returns {boolean} true if this message was handled (keeps sendResponse channel for async)
 */
export function handleFlowSandboxMessage(msg, sendResponse) {
  if (msg?.type !== "flow.sandbox.run") return false;

  const requestId = msg.requestId;
  if (!requestId) {
    sendResponse?.({ error: "flow.sandbox.run requires requestId" });
    return false;
  }

  (async () => {
    try {
      await ensureFlowSandbox();
      const api = createSwBridgedApi(requestId);
      swApiProxies.set(requestId, api);
      const outputs = await runNodeScriptInSandbox(msg.script, msg.inputs, api);
      chrome.runtime.sendMessage({
        type: "flow.sandbox.done",
        requestId,
        outputs,
      }).catch(() => {});
      sendResponse?.({ ok: true });
    } catch (err) {
      chrome.runtime.sendMessage({
        type: "flow.sandbox.done",
        requestId,
        error: err?.message || String(err),
      }).catch(() => {});
      sendResponse?.({ error: err?.message || String(err) });
    } finally {
      swApiProxies.delete(requestId);
    }
  })();

  return true;
}
