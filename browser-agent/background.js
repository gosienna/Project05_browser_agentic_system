import { getMaxTokens } from "./agent-config.js";
import { chatCompletions, ensureOffscreenDocument, renderChatPromptPreview } from "./llm.js";
import { migrateApiKeySettings, resolveChatModel } from "./llm-providers.js";
import { migrateGeminiModelSettings } from "./gemini-models.js";
import { callMcpTool, listMcpTools, listMcpToolsOpenAi, registerBuiltinMcpTools } from "./mcp/index.js";
import { runSystemEditor } from "./WebApp/system-editor.js";
import { ensureSeeded, getSystem } from "./WebApp/system-store.js";
import { handleTabBridge } from "./tab-bridge.js";
import { handleRagMessage } from "./rag/handlers.js";
import { stripUnsupportedNativeTools } from "./webllm-models.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureSeeded().catch((err) => console.error("[systems] seed failed", err));
});

chrome.runtime.onStartup?.addListener?.(() => {
  ensureSeeded().catch((err) => console.error("[systems] seed failed", err));
});

ensureSeeded().catch((err) => console.error("[systems] seed failed", err));
registerBuiltinMcpTools();

chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

function mergeSettings(current, patch) {
  const next = { ...current, ...patch };
  if (patch.apiKeys) {
    next.apiKeys = { ...(current.apiKeys || {}), ...patch.apiKeys };
  }
  return next;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const current = settings || {};
  const geminiPatch = migrateGeminiModelSettings(current) || {};
  const apiKeyPatch = migrateApiKeySettings({ ...current, ...geminiPatch }) || {};
  const patch = { ...geminiPatch, ...apiKeyPatch };
  if (!Object.keys(patch).length) return current;
  const next = mergeSettings(current, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function setSettings(patch) {
  const next = mergeSettings(await getSettings(), patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Long-lived port for the unused system-editor ReAct loop (side panel uses Dialogue dock).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "system-editor") return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "run") return;
    const settings = await getSettings();
    const send = (event) => {
      try {
        port.postMessage(event);
      } catch {
        /* panel closed */
      }
    };

    try {
      await ensureSeeded();
      const system = await getSystem(msg.systemId);
      if (!system) throw new Error(`Unknown system "${msg.systemId}"`);
      await runSystemEditor({
        systemId: msg.systemId,
        task: msg.task,
        settings,
        onEvent: send,
      });
      send({ type: "done" });
    } catch (err) {
      send({ type: "error", message: err?.message || String(err) });
    }
  });
});

async function markOnnxModelDownloaded(modelId) {
  const { onnxModels } = await chrome.storage.local.get("onnxModels");
  await chrome.storage.local.set({ onnxModels: { ...(onnxModels || {}), [modelId]: true } });
}

async function markWebllmModelDownloaded(modelId) {
  const { webllmModels } = await chrome.storage.local.get("webllmModels");
  await chrome.storage.local.set({ webllmModels: { ...(webllmModels || {}), [modelId]: true } });
}

async function markWllamaModelDownloaded(modelId) {
  const { wllamaModels } = await chrome.storage.local.get("wllamaModels");
  await chrome.storage.local.set({ wllamaModels: { ...(wllamaModels || {}), [modelId]: true } });
}

function replyAsync(promise, sendResponse) {
  promise
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        error: { message: err?.message || String(err), type: "engine_error", code: null },
      })
    );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.target === "onnx-model-ready" && msg.model) {
    markOnnxModelDownloaded(msg.model);
    return;
  }

  if (msg.target === "webllm-model-ready" && msg.model) {
    markWebllmModelDownloaded(msg.model);
    return;
  }

  if (msg.target === "wllama-model-ready" && msg.model) {
    markWllamaModelDownloaded(msg.model);
    return;
  }

  if (msg.type === "tabBridge") {
    handleTabBridge(msg)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "system.reload" || msg.type === "system.updated") {
    // Broadcast-only; hosts/viewers/side panel listen. No response needed.
    return;
  }

  if (msg.type === "settings.get") {
    replyAsync(getSettings(), sendResponse);
    return true;
  }
  if (msg.type === "settings.set") {
    replyAsync(setSettings(msg.patch), sendResponse);
    return true;
  }
  if (msg.type === "llm.test") {
    replyAsync(
      getSettings().then((settings) =>
        chatCompletions(
          { model: resolveChatModel(settings), messages: [{ role: "user", content: "Hi" }], max_tokens: 1 },
          settings
        )
      ),
      sendResponse
    );
    return true;
  }
  if (msg.type === "dialogue.send") {
    replyAsync(
      getSettings().then((settings) => {
        const model = resolveChatModel(settings);
        const tools = Array.isArray(msg.tools) && msg.tools.length ? msg.tools : undefined;
        return chatCompletions(
          {
            model,
            messages: msg.messages,
            ...(tools ? { tools } : {}),
            temperature: settings.temperature ?? 0.2,
            max_tokens: getMaxTokens(settings),
          },
          settings
        );
      }),
      sendResponse
    );
    return true;
  }
  if (msg.type === "dialogue.renderPrompt") {
    replyAsync(
      getSettings().then((settings) => {
        const model = resolveChatModel(settings);
        const tools = Array.isArray(msg.tools) && msg.tools.length ? msg.tools : undefined;
        return renderChatPromptPreview(
          {
            model,
            messages: msg.messages,
            ...(tools ? { tools } : {}),
          },
          settings
        );
      }),
      sendResponse
    );
    return true;
  }
  if (msg.type === "mcp.tools.list") {
    replyAsync(
      getSettings().then((settings) => {
        const groups = Array.isArray(msg.groups) && msg.groups.length ? msg.groups : ["dialogue"];
        const merged = { ...settings, ...(msg.settings && typeof msg.settings === "object" ? msg.settings : {}) };
        return {
          tools: listMcpTools({ groups, settings: merged }),
          openAiTools: listMcpToolsOpenAi({ groups, settings: merged }),
        };
      }),
      sendResponse
    );
    return true;
  }
  if (msg.type === "dialogue.tool.run") {
    replyAsync(
      getSettings().then(async (settings) => {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const merged = {
          ...settings,
          ...(msg.settings && typeof msg.settings === "object" ? msg.settings : {}),
        };
        return callMcpTool(msg.name, msg.args || {}, {
          settings: merged,
          tabId: activeTab?.id,
          userQuery: msg.userQuery,
          systemId: msg.systemId || merged.webAppSystemId,
        });
      }).then((result) => ({ result })),
      sendResponse
    );
    return true;
  }
  if (msg.type?.startsWith("rag.")) {
    handleRagMessage(msg, getSettings)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
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
        const loadedModel = msg.model || msg.request?.model;
        if (msg.engineType === "engine.load" && loadedModel && !res?.error) await markOnnxModelDownloaded(loadedModel);
        sendResponse(res);
      })
      .catch((err) => sendResponse({ error: { message: err.message, type: "engine_error", code: null } }));
    return true;
  }
  if (msg.type === "webllm.relay") {
    ensureOffscreenDocument()
      .then(async () => {
        const settings = await getSettings();
        let request = msg.request;
        if (msg.engineType === "chat.completions" && request) {
          request = stripUnsupportedNativeTools(
            { ...request, model: msg.model || request.model },
            settings
          );
        }
        return chrome.runtime.sendMessage({
          target: "webllm-engine",
          type: msg.engineType,
          model: msg.model,
          request,
        });
      })
      .then(async (res) => {
        const loadedModel = msg.model || msg.request?.model;
        if (msg.engineType === "engine.load" && loadedModel && !res?.error) await markWebllmModelDownloaded(loadedModel);
        sendResponse(res);
      })
      .catch((err) => sendResponse({ error: { message: err.message, type: "engine_error", code: null } }));
    return true;
  }
  if (msg.type === "wllama.relay") {
    ensureOffscreenDocument()
      .then(async () => {
        const settings = await getSettings();
        let request = msg.request;
        if (msg.engineType === "chat.completions" && request) {
          request = stripUnsupportedNativeTools(
            { ...request, model: msg.model || request.model },
            settings
          );
        }
        return chrome.runtime.sendMessage({
          target: "wllama-engine",
          type: msg.engineType,
          model: msg.model,
          request,
        });
      })
      .then(async (res) => {
        const loadedModel = msg.model || msg.request?.model;
        if (msg.engineType === "engine.load" && loadedModel && !res?.error) {
          await markWllamaModelDownloaded(loadedModel);
        }
        sendResponse(res);
      })
      .catch((err) => sendResponse({ error: { message: err.message, type: "engine_error", code: null } }));
    return true;
  }
});

