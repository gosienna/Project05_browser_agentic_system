import { runAgent } from "./agent.js";
import { chat, chatCompletions, ensureOffscreenDocument } from "./llm.js";
import * as tools from "./tools.js";

const TRACKER_TIMEOUT_MS = { onnx: 120000, default: 60000 };

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings || {};
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Long-lived port for live agent runs from the side panel (see plan §1).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent") return;

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "run") return;
    const settings = await getSettings();
    const send = (event) => {
      try {
        port.postMessage(event);
      } catch {
        // panel was closed mid-run
      }
    };

    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await runAgent({ task: msg.task, settings, tools, tabId: activeTab?.id, onEvent: send });
      send({ type: "done" });
    } catch (err) {
      send({ type: "error", message: err?.message || String(err) });
    }
  });
});

// One-shot messages: settings + trackers. onnx-progress/onnx-engine traffic
// between background and offscreen passes through untouched — the side
// panel listens for onnx-progress directly via chrome.runtime.onMessage.
// The offscreen document can't use chrome.storage, so it broadcasts
// "onnx-model-ready" after a successful load and we persist the flag here.
async function markModelDownloaded(modelId) {
  const { onnxModels } = await chrome.storage.local.get("onnxModels");
  await chrome.storage.local.set({ onnxModels: { ...(onnxModels || {}), [modelId]: true } });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.target === "onnx-model-ready" && msg.model) {
    markModelDownloaded(msg.model);
    return;
  }
  if (msg.type === "settings.get") {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg.type === "settings.set") {
    setSettings(msg.patch).then(sendResponse);
    return true;
  }
  if (msg.type === "tracker.create") {
    createTracker(msg.tracker).then(sendResponse);
    return true;
  }
  if (msg.type === "tracker.delete") {
    deleteTracker(msg.id).then(sendResponse);
    return true;
  }
  if (msg.type === "tracker.list") {
    listTrackers().then(sendResponse);
    return true;
  }
  if (msg.type === "llm.test") {
    getSettings()
      .then((settings) => chatCompletions({ model: settings.model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 }, settings))
      .then(sendResponse);
    return true;
  }
  // Dialogue tab: sends exactly the messages the user composed, no system
  // prompt injected, so it exercises the same chatCompletions() path the
  // agent uses but without agent.js's tool loop wrapped around it.
  if (msg.type === "dialogue.send") {
    getSettings()
      .then((settings) => {
        const model = settings.provider === "onnx" ? settings.onnxModel : settings.model;
        return chatCompletions(
          { model, messages: msg.messages, temperature: settings.temperature ?? 0.2, max_tokens: settings.maxTokens ?? 1024 },
          settings
        );
      })
      .then(sendResponse);
    return true;
  }
  // The side panel never talks to the offscreen engine directly (plan §5.2);
  // it relays through here so background owns the offscreen lifecycle.
  if (msg.type === "onnx.relay") {
    ensureOffscreenDocument()
      .then(() =>
        chrome.runtime.sendMessage({
          target: "onnx-engine",
          type: msg.engineType,
          model: msg.model,
          task: msg.task,
          request: msg.request,
        })
      )
      .then(async (res) => {
        // Persist before responding so the panel's immediate storage read
        // sees the flag (the offscreen broadcast alone would race it).
        const loadedModel = msg.model || msg.request?.model;
        if (msg.engineType === "engine.load" && loadedModel && !res?.error) await markModelDownloaded(loadedModel);
        sendResponse(res);
      })
      .catch((err) => sendResponse({ error: { message: err.message, type: "engine_error", code: null } }));
    return true;
  }
});

// --- Trackers (chrome.alarms) -------------------------------------------

async function listTrackers() {
  const { trackers } = await chrome.storage.local.get("trackers");
  return trackers || [];
}

async function createTracker(tracker) {
  const trackers = await listTrackers();
  const record = { ...tracker, id: `t_${Date.now()}`, createdAt: Date.now() };
  trackers.push(record);
  await chrome.storage.local.set({ trackers });
  chrome.alarms.create(record.id, { periodInMinutes: Math.max(1, tracker.intervalMinutes || 60) });
  return record;
}

async function deleteTracker(id) {
  await chrome.storage.local.set({ trackers: (await listTrackers()).filter((t) => t.id !== id) });
  await chrome.alarms.clear(id);
  return true;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tracker = (await listTrackers()).find((t) => t.id === alarm.name);
  if (!tracker) return;

  const settings = await getSettings();
  const timeoutMs = settings.provider === "onnx" ? TRACKER_TIMEOUT_MS.onnx : TRACKER_TIMEOUT_MS.default;

  try {
    const result = await withTimeout(
      chat(
        [
          { role: "system", content: "You are a background monitoring tracker. Answer concisely." },
          { role: "user", content: tracker.prompt },
        ],
        settings
      ),
      timeoutMs
    );
    chrome.notifications.create(`${tracker.id}_${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: tracker.label || "Tracker update",
      message: result.slice(0, 300),
    });
  } catch (err) {
    console.error("[tracker] failed", tracker.id, err);
  }
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Tracker run timed out")), ms)),
  ]);
}
