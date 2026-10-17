// Execute a Flow node script as an async function with injected helpers.
// Scripts run in a CSP-relaxed sandbox page (AsyncFunction is blocked on extension pages).

/**
 * Build the helper API passed to node scripts as `api`.
 * @param {{ callTool: (name: string, args?: object) => Promise<unknown>, llm: (prompt: string, model?: string) => Promise<string>, model?: string }} deps
 */
export function createFlowApi({ callTool, llm, model = "" }) {
  if (typeof callTool !== "function") throw new Error("createFlowApi requires callTool");
  if (typeof llm !== "function") throw new Error("createFlowApi requires llm");
  const boundModel = model != null ? String(model).trim() : "";
  return {
    open_tab: (args = {}) => callTool("open_tab", args),
    navigate: (args = {}) => callTool("navigate", args),
    list_tabs: (args = {}) => callTool("list_tabs", args),
    browser_snapshot: (args = {}) => callTool("browser_snapshot", args),
    get_page_html: (args = {}) => callTool("get_page_html", args),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
    llm: async (prompt) => {
      const text = await llm(String(prompt ?? ""), boundModel || undefined);
      return text == null ? "" : String(text);
    },
  };
}

/**
 * Extract assistant text from an OpenAI-style chatCompletions response.
 */
export function assistantTextFromCompletion(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  if (res.error) {
    const err = res.error;
    throw new Error(typeof err === "string" ? err : err?.message || String(err));
  }
  const msg = res.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return content != null ? String(content) : "";
}

/** @type {Map<string, { api: object, resolve: Function, reject: Function }>} */
const offscreenRuns = new Map();
let offscreenListenerInstalled = false;

function installOffscreenApiListener() {
  if (offscreenListenerInstalled) return;
  offscreenListenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "flow.sandbox.api" && msg.requestId) {
      const entry = offscreenRuns.get(msg.requestId);
      if (!entry) {
        sendResponse({ error: "No active Flow sandbox run for api call" });
        return false;
      }
      Promise.resolve()
        .then(async () => {
          const fn = entry.api?.[msg.method];
          if (typeof fn !== "function") throw new Error(`Unknown api.${msg.method}`);
          return fn(...(msg.args || []));
        })
        .then((result) => sendResponse({ result }))
        .catch((err) => sendResponse({ error: err?.message || String(err) }));
      return true;
    }
    if (msg?.type === "flow.sandbox.done" && msg.requestId) {
      const entry = offscreenRuns.get(msg.requestId);
      if (!entry) return false;
      offscreenRuns.delete(msg.requestId);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.outputs && typeof msg.outputs === "object" ? msg.outputs : {});
      return false;
    }
    return false;
  });
}

async function runNodeScriptViaOffscreen(script, inputs, api) {
  installOffscreenApiListener();
  const { ensureOffscreenDocument } = await import("../../llm.js");
  await ensureOffscreenDocument();
  const requestId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  async function postRun(attempt = 0) {
    try {
      return await chrome.runtime.sendMessage({
        type: "flow.sandbox.run",
        requestId,
        script: String(script || ""),
        inputs: inputs && typeof inputs === "object" ? inputs : {},
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (attempt < 8 && /Receiving end does not exist|The message port closed/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        return postRun(attempt + 1);
      }
      throw err;
    }
  }

  return new Promise((resolve, reject) => {
    offscreenRuns.set(requestId, { api, resolve, reject });
    postRun().catch((err) => {
      offscreenRuns.delete(requestId);
      reject(err);
    });
  });
}

/**
 * Run one node's script. Mutates / returns `outputs`.
 * Script body has access to: inputs, outputs, api.
 */
export async function runNodeScript(script, inputs = {}, api) {
  if (!api) throw new Error("runNodeScript requires api");
  const body = String(script || "").trim();
  if (!body) {
    return {};
  }

  // Extension pages / service workers block eval; use sandboxed page instead.
  if (typeof document !== "undefined") {
    const { runNodeScriptInSandbox } = await import("./sandbox-host.js");
    return runNodeScriptInSandbox(body, inputs, api);
  }

  return runNodeScriptViaOffscreen(body, inputs, api);
}

/**
 * Run a single node record: returns { outputs, status, error }.
 */
export async function executeFlowNode(node, api) {
  try {
    const outputs = await runNodeScript(node?.script, node?.inputs, api);
    return { outputs, status: "done", error: null };
  } catch (err) {
    return {
      outputs: node?.outputs ?? null,
      status: "error",
      error: err?.message || String(err),
    };
  }
}
