// Runs inside the Chrome sandbox page (relaxed CSP). Host posts components here.

const root = document.getElementById("root");
let styleEl = null;
let pending = new Map();
let reqSeq = 0;

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "load" && typeof msg.html === "string") {
    loadSystem(msg);
    return;
  }

  if (msg.type === "api-result" && msg.requestId != null) {
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  }
});

function loadSystem({ html, css, ui, tools }) {
  pending.forEach((p) => p.reject(new Error("System reloaded")));
  pending = new Map();

  if (styleEl) styleEl.remove();
  styleEl = document.createElement("style");
  styleEl.textContent = css || "";
  document.head.appendChild(styleEl);

  root.innerHTML = html || "";

  const api = createApi();

  try {
    // tools component may assign self.__agentTools
    self.__agentTools = {};
    if (tools && String(tools).trim()) {
      const toolFn = new Function("api", `${tools}\n; return self.__agentTools;`);
      const exported = toolFn(api);
      self.__agentTools = exported && typeof exported === "object" ? exported : self.__agentTools || {};
    }
  } catch (err) {
    console.error("[sandbox] tools error", err);
    self.__agentTools = {};
  }

  // Expose api + tools to home UI scripts
  self.__agentApi = api;

  try {
    if (ui && String(ui).trim()) {
      const uiFn = new Function("api", "tools", `${ui}`);
      uiFn(api, self.__agentTools || {});
    }
  } catch (err) {
    console.error("[sandbox] ui error", err);
    root.insertAdjacentHTML(
      "beforeend",
      `<pre style="color:#a02525;padding:12px;white-space:pre-wrap;">UI script error: ${escapeHtml(err.message)}</pre>`
    );
  }

  parent.postMessage({ type: "sandbox-ready" }, "*");
}

function createApi() {
  const call = (op, payload = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++reqSeq;
      pending.set(requestId, { resolve, reject });
      parent.postMessage({ type: "api", requestId, op, ...payload }, "*");
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(new Error(`api.${op} timed out`));
        }
      }, 60000);
    });

  return {
    listTabs: () => call("listTabs"),
    getActiveTab: () => call("getActiveTab"),
    executeInTab: (tabId, fnSource, args) => call("executeInTab", { tabId, fnSource, args }),
    readPage: (tabId, opts = {}) => call("readPage", { tabId, maxChars: opts.maxChars }),
    click: (tabId, selector) => call("click", { tabId, selector }),
    typeText: (tabId, selector, text) => call("typeText", { tabId, selector, text }),
    scroll: (tabId, opts = {}) => call("scroll", { tabId, direction: opts.direction }),
    navigate: (tabId, url) => call("navigate", { tabId, url }),
    captureTab: (tabId) => call("captureTab", { tabId }),
    runTool: async (name, args = {}) => {
      const fn = self.__agentTools?.[name];
      if (typeof fn !== "function") throw new Error(`Unknown tool "${name}"`);
      return fn(args, createApi());
    },
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

parent.postMessage({ type: "sandbox-boot" }, "*");
