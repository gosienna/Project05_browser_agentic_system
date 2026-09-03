// Capture DevTools-style console messages for a tab via chrome.debugger (CDP).
// WebApp host tabs use a sandbox postMessage bridge instead (debugger cannot attach
// to chrome-extension:// pages).

import { isWebAppHostUrl } from "../../modes/WebApp/dom-bridge.js";

const PROTOCOL_VERSION = "1.3";
const RING_CAP = 500;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CHARS = 14000;

/** Severity order (higher = more severe). exception treated as error. */
const LEVEL_RANK = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
  exception: 4,
};

/** @type {Map<number, { attached: boolean, mode?: string, messages: object[] }>} */
const tabState = new Map();

let listenersInstalled = false;
let webAppListenerInstalled = false;

function getOrCreateState(tabId) {
  let state = tabState.get(tabId);
  if (!state) {
    state = { attached: false, messages: [] };
    tabState.set(tabId, state);
  }
  return state;
}

function pushMessage(tabId, entry) {
  const state = getOrCreateState(tabId);
  state.messages.push(entry);
  if (state.messages.length > RING_CAP) {
    state.messages.splice(0, state.messages.length - RING_CAP);
  }
}

function remoteObjectToText(obj) {
  if (obj == null) return "undefined";
  if (obj.value !== undefined) {
    if (typeof obj.value === "string") return obj.value;
    try {
      return JSON.stringify(obj.value);
    } catch {
      return String(obj.value);
    }
  }
  if (obj.description) return obj.description;
  if (obj.unserializableValue) return String(obj.unserializableValue);
  if (obj.type === "undefined") return "undefined";
  if (obj.type === "object" && obj.subtype === "null") return "null";
  if (obj.type) return `[${obj.type}]`;
  return String(obj);
}

function formatConsoleArgs(args) {
  if (!Array.isArray(args) || !args.length) return "";
  return args.map(remoteObjectToText).join(" ");
}

function normalizeConsoleType(type) {
  const t = String(type || "log").toLowerCase();
  if (t === "warning") return "warn";
  if (
    t === "dir" ||
    t === "dirxml" ||
    t === "table" ||
    t === "trace" ||
    t === "clear" ||
    t === "startGroup" ||
    t === "startGroupCollapsed" ||
    t === "endGroup" ||
    t === "assert" ||
    t === "profile" ||
    t === "profileEnd" ||
    t === "count" ||
    t === "timeEnd"
  ) {
    return t === "assert" ? "error" : "log";
  }
  if (LEVEL_RANK[t] != null) return t;
  return "log";
}

function sendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function assertRunnableTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} not found`);
  }
  const url = tab.url || tab.pendingUrl || "";
  if (isWebAppHostUrl(url)) return tab;
  if (/^(chrome|chrome-extension|edge|about|devtools):/i.test(url)) {
    throw new Error(`Cannot capture console on restricted page: ${url}`);
  }
  return tab;
}

/** Receive console lines forwarded from WebApp sandbox → system-host. */
function installWebAppConsoleListener() {
  if (webAppListenerInstalled) return;
  webAppListenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "webapp-console" || !msg.entry) return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const entry = msg.entry;
    const state = getOrCreateState(tabId);
    state.attached = true;
    state.mode = "webapp";
    pushMessage(tabId, {
      type: normalizeConsoleType(entry.type || "log"),
      text: typeof entry.text === "string" ? entry.text : String(entry.text ?? ""),
      timestamp: entry.timestamp ?? Date.now(),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.lineNumber != null ? { lineNumber: entry.lineNumber } : {}),
    });
  });
}

function installListenersOnce() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  installWebAppConsoleListener();

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source?.tabId;
    if (tabId == null) return;
    const state = tabState.get(tabId);
    if (!state?.attached || state.mode === "webapp") return;

    if (method === "Runtime.consoleAPICalled") {
      const type = normalizeConsoleType(params?.type);
      const text = formatConsoleArgs(params?.args);
      const stack = params?.stackTrace?.callFrames?.[0];
      pushMessage(tabId, {
        type,
        text,
        timestamp: params?.timestamp ?? Date.now(),
        ...(stack?.url ? { url: stack.url } : {}),
        ...(stack?.lineNumber != null ? { lineNumber: stack.lineNumber } : {}),
      });
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = params?.exceptionDetails || {};
      const ex = details.exception;
      const text =
        (ex && remoteObjectToText(ex)) ||
        details.text ||
        details.exception?.description ||
        "Uncaught exception";
      const stackText = details.stackTrace?.callFrames
        ?.slice(0, 8)
        .map((f) => `  at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
        .join("\n");
      pushMessage(tabId, {
        type: "exception",
        text: stackText ? `${text}\n${stackText}` : text,
        timestamp: params?.timestamp ?? Date.now(),
        ...(details.url ? { url: details.url } : {}),
        ...(details.lineNumber != null ? { lineNumber: details.lineNumber } : {}),
      });
      return;
    }

    if (method === "Log.entryAdded") {
      const entry = params?.entry || {};
      const type = normalizeConsoleType(entry.level === "warning" ? "warn" : entry.level);
      pushMessage(tabId, {
        type,
        text: entry.text || "",
        timestamp: entry.timestamp ?? Date.now(),
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.lineNumber != null ? { lineNumber: entry.lineNumber } : {}),
      });
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source?.tabId;
    if (tabId == null) return;
    const state = tabState.get(tabId);
    if (state && state.mode !== "webapp") state.attached = false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabState.delete(tabId);
  });
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        if (/already attached/i.test(msg)) {
          resolve();
          return;
        }
        reject(new Error(msg));
        return;
      }
      resolve();
    });
  });
}

/**
 * Start capturing console for a tab (debugger for http(s); bridge for WebApp host).
 * @param {number} tabId
 */
export async function ensureAttached(tabId) {
  installListenersOnce();
  const tab = await assertRunnableTab(tabId);
  const state = getOrCreateState(tabId);
  if (state.attached) return state;

  const url = tab.url || tab.pendingUrl || "";
  if (isWebAppHostUrl(url)) {
    // chrome.debugger cannot attach to chrome-extension:// pages; sandbox forwards logs.
    state.attached = true;
    state.mode = "webapp";
    return state;
  }

  await attachDebugger(tabId);
  try {
    await sendCommand(tabId, "Runtime.enable");
    await sendCommand(tabId, "Log.enable");
  } catch (err) {
    state.attached = false;
    throw err;
  }
  state.attached = true;
  state.mode = "debugger";
  return state;
}

function matchesLevelFilter(msgType, minLevel) {
  if (!minLevel) return true;
  const minRank = LEVEL_RANK[minLevel];
  if (minRank == null) return true;
  const rank = LEVEL_RANK[msgType] ?? LEVEL_RANK.log;
  return rank >= minRank;
}

function normalizeMaxChars(maxChars, defaultMax) {
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return defaultMax;
  return Math.floor(n);
}

/**
 * @param {{ tabId: number, level?: string, maxEntries?: number, clear?: boolean, maxChars?: number }} args
 */
export async function getConsoleMessages({
  tabId,
  level,
  maxEntries = DEFAULT_MAX_ENTRIES,
  clear = false,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error("tabId is required");

  await ensureAttached(id);
  const state = getOrCreateState(id);

  let filterLevel = null;
  if (level != null && String(level).trim()) {
    const raw = String(level).trim().toLowerCase();
    filterLevel = raw === "warning" ? "warn" : raw === "verbose" ? "debug" : raw;
    if (LEVEL_RANK[filterLevel] == null) filterLevel = null;
  }

  const filtered = state.messages.filter((m) => matchesLevelFilter(m.type, filterLevel));
  const totalBuffered = filtered.length;

  const limit = Math.min(Math.max(Number(maxEntries) || DEFAULT_MAX_ENTRIES, 1), RING_CAP);
  const messages = filtered.slice(-limit);

  if (clear) state.messages = [];

  const payload = {
    tabId: id,
    attached: state.attached,
    mode: state.mode || null,
    messages,
    totalBuffered,
    returned: messages.length,
  };

  const limitChars = normalizeMaxChars(maxChars, DEFAULT_MAX_CHARS);
  const json = JSON.stringify(payload);
  if (json.length <= limitChars) return payload;

  const trimmed = { ...payload, messages: messages.map((m) => ({ ...m })), truncated: true };
  let encoded = JSON.stringify(trimmed);
  let i = 0;
  while (encoded.length > limitChars && i < trimmed.messages.length) {
    const m = trimmed.messages[i];
    const room = Math.max(40, Math.floor((m.text?.length || 0) * 0.5));
    m.text = (m.text || "").slice(0, room) + "…[truncated]";
    encoded = JSON.stringify(trimmed);
    i++;
  }
  if (encoded.length > limitChars) {
    trimmed.messages = trimmed.messages.slice(-Math.max(1, Math.floor(trimmed.messages.length / 2)));
    trimmed.returned = trimmed.messages.length;
  }
  return trimmed;
}

/**
 * Clear buffered console messages for a tab (does not detach debugger).
 * @param {{ tabId: number }} args
 */
export async function clearConsoleMessages({ tabId } = {}) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error("tabId is required");
  await assertRunnableTab(id);
  const state = getOrCreateState(id);
  state.messages = [];
  return { ok: true, tabId: id, attached: state.attached, mode: state.mode || null };
}

// Buffer WebApp sandbox logs as soon as the service worker loads tools.
installWebAppConsoleListener();
