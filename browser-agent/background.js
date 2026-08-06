import { runAgent } from "./agent.js";
import { getMaxTokens } from "./agent-config.js";
import { chatCompletions, ensureOffscreenDocument, renderChatPromptPreview } from "./llm.js";
import { callMcpTool, listMcpTools, listMcpToolsOpenAi, registerBuiltinMcpTools } from "./mcp/index.js";
import * as tools from "./tools/browser.js";
import { runSystemEditor } from "./system-editor-l2.js";
import { runScriptEditor } from "./system-editor-l1.js";
import { BUILTIN_BROWSER_AGENT_ID, ensureSeeded, getEditableKinds, getSystem, saveConversation } from "./system-store.js";
import { handleTabBridge } from "./tab-bridge.js";

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

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings || {};
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function broadcastReload(systemId) {
  chrome.runtime.sendMessage({ type: "system.reload", systemId }).catch(() => {});
}

function broadcastComponentUpdated(systemId, kind) {
  chrome.runtime.sendMessage({ type: "system.updated", systemId, kind }).catch(() => {});
}

function broadcastConversationSaved(systemId) {
  chrome.runtime.sendMessage({ type: "system.conversation", systemId }).catch(() => {});
}

async function persistConversation(meta) {
  try {
    await saveConversation(meta);
    broadcastConversationSaved(meta.systemId);
  } catch (err) {
    console.error("[systems] save conversation failed", err);
  }
}

// Long-lived port for classic browser automation runs.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "agent") {
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
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await runAgent({
          task: msg.task,
          settings,
          tools,
          tabId: activeTab?.id,
          onEvent: send,
          onComplete: ({ messages, final }) =>
            persistConversation({
              systemId: BUILTIN_BROWSER_AGENT_ID,
              source: "automation",
              task: msg.task,
              messages,
              final,
            }),
        });
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err?.message || String(err) });
      }
    });
    return;
  }

  if (port.name === "system-editor") {
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
        // The access level is an immutable property of the system record — the
        // side panel cannot request an escalated level.
        const system = await getSystem(msg.systemId);
        if (!system) throw new Error(`Unknown system "${msg.systemId}"`);
        const editorArgs = {
          systemId: msg.systemId,
          task: msg.task,
          settings,
          onEvent: send,
          onReloadHome: async () => broadcastReload(msg.systemId),
          onComponentWritten: (kind) => broadcastComponentUpdated(msg.systemId, kind),
          onComplete: ({ messages, final }) =>
            persistConversation({
              systemId: msg.systemId,
              source: "editor",
              kinds: system.level === 1 ? getEditableKinds(system) : null,
              task: msg.task,
              messages,
              final,
            }),
        };
        if (system.level === 1) {
          await runScriptEditor(editorArgs);
        } else {
          await runSystemEditor(editorArgs);
        }
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err?.message || String(err) });
      }
    });
  }
});

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

  if (msg.type === "tabBridge") {
    handleTabBridge(msg)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "system.reload" || msg.type === "system.updated" || msg.type === "system.conversation") {
    // Broadcast-only; hosts/viewers/side panel listen. No response needed.
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
  if (msg.type === "llm.test") {
    getSettings()
      .then((settings) =>
        chatCompletions(
          { model: settings.model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 },
          settings
        )
      )
      .then(sendResponse);
    return true;
  }
  if (msg.type === "dialogue.send") {
    getSettings()
      .then((settings) => {
        const model = settings.provider === "onnx" ? settings.onnxModel : settings.model;
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
      })
      .then(sendResponse);
    return true;
  }
  if (msg.type === "dialogue.renderPrompt") {
    getSettings()
      .then((settings) => {
        const model = settings.provider === "onnx" ? settings.onnxModel : settings.model;
        const tools = Array.isArray(msg.tools) && msg.tools.length ? msg.tools : undefined;
        return renderChatPromptPreview(
          {
            model,
            messages: msg.messages,
            ...(tools ? { tools } : {}),
          },
          settings
        );
      })
      .then(sendResponse);
    return true;
  }
  if (msg.type === "mcp.tools.list") {
    getSettings()
      .then((settings) => {
        const groups = Array.isArray(msg.groups) && msg.groups.length ? msg.groups : ["dialogue"];
        const merged = { ...settings, ...(msg.settings && typeof msg.settings === "object" ? msg.settings : {}) };
        return {
          tools: listMcpTools({ groups, settings: merged }),
          openAiTools: listMcpToolsOpenAi({ groups, settings: merged }),
        };
      })
      .then(sendResponse);
    return true;
  }
  if (msg.type === "dialogue.tool.run") {
    getSettings()
      .then(async (settings) => {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return callMcpTool(msg.name, msg.args || {}, { settings, tabId: activeTab?.id });
      })
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
        if (msg.engineType === "engine.load" && loadedModel && !res?.error) await markModelDownloaded(loadedModel);
        sendResponse(res);
      })
      .catch((err) => sendResponse({ error: { message: err.message, type: "engine_error", code: null } }));
    return true;
  }
});

