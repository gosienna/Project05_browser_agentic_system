// Side panel UI: Agent systems and Settings (incl. the ONNX model picker).

import {
  BUILTIN_BROWSER_AGENT_ID,
  BUILTIN_CURVE_PLOTTER_ID,
  COMPONENT_KINDS,
  clearConversations,
  createSystem,
  deleteConversation,
  deleteSystem,
  ensureSeeded,
  getComponent,
  getConversation,
  listComponents,
  listConversations,
  listSystems,
  writeComponent,
} from "./system-store.js";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  getDialogueMaxToolRounds,
  getMaxTokens,
} from "./agent-config.js";
import { chatCompletions, renderChatPromptPreview } from "./llm.js";
import {
  apiKeyPlaceholder,
  getThinkingHintForSettings,
  isRemoteLlmProvider,
  isKnownNonOllamaBaseUrl,
  DEFAULT_OLLAMA_BASE_URL,
  NVIDIA_NIM_BASE_URL,
  providerStoresApiKey,
  providerSupportsThinkingToggle,
  resolveApiKey,
  resolveChatModel,
  resolveLlmBaseUrl,
  resolveOllamaBaseUrl,
} from "./llm-providers.js";
import {
  DEFAULT_GEMINI_MODEL,
  fetchGeminiModelsFromApi,
  formatGeminiPickerLabel,
  geminiModelLabel,
  listGeminiModels,
  migrateGeminiModelSettings,
  resolveGeminiModel,
} from "./gemini-models.js";
import {
  DEFAULT_OPENAI_MODEL,
  formatOpenAiPickerLabel,
  listOpenAiFlagshipModels,
  openAiModelLabel,
  resolveOpenAiModel,
} from "./openai-models.js";
import {
  DEFAULT_NVIDIA_NIM_MODEL,
  listNvidiaNimModels,
  nvidiaNimModelLabel,
} from "./nvidia-nim-models.js";
import { createDialoguePanel } from "./dialogue/index.js";
import {
  deleteOllamaModel,
  fetchOllamaCatalog,
  formatOllamaCatalogMeta,
  getInstalledVariants,
  isOllamaModelInstalled,
  listOllamaInstalled,
  listOllamaModelsWithMeta,
  ollamaCatalogPullId,
  ollamaInstalledDownloadMap,
  pullOllamaModel,
  resolveOllamaInstalledName,
} from "./ollama-models.js";
import { formatWebllmPickerLabel, formatWebllmRegistryMeta } from "./webllm-models.js";
import {
  DEFAULT_GEMINI_EMBED_MODEL,
  DEFAULT_NVIDIA_EMBED_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_EMBED_MODEL,
  DEFAULT_OPENAI_EMBED_MODEL,
  listGeminiEmbedModels,
  listNvidiaEmbedModels,
  listOpenAiEmbedModels,
} from "./embed-models.js";
import {
  DEFAULT_ONNX_EMBED_MODEL,
  DEFAULT_WEBLLM_EMBED_MODEL,
  DEFAULT_OLLAMA_EMBED_MODEL,
} from "./rag/config.js";

const $ = (sel) => document.querySelector(sel);

let settings = {};
let registry = [];
let webllmRegistry = [];
let ollamaRegistry = [];
let ollamaInstalled = new Set();
let downloadedModels = {};
let downloadedWebllmModels = {};
let ollamaCatalogSkip = 0;
let ollamaCatalogTotal = 0;
let ollamaCatalogSearch = "";
let ollamaCatalogFilter = "";
let ollamaPullAbort = null;
let ollamaPulling = false;
let ollamaSearchTimer = null;
const OLLAMA_CATALOG_PAGE = 40;
let agentPort = null;
let editorPort = null;
let running = false;
let editing = false;
let lastKnownDevice = null;
let dialoguePanel = null;
let systems = [];
let currentSystemId = null;
let activeComponentKind = COMPONENT_KINDS[0];
let componentBaseline = "";
let componentDirty = false;
let componentLoading = false;
let componentMetaByKind = {};
/** @type {Map<string, object>} client-side cache of engine.contextEstimate results, keyed by model id. */
const contextEstimateCache = new Map();

init();

async function init() {
  settings = await sendMessage({ type: "settings.get" });
  const geminiPatch = migrateGeminiModelSettings(settings);
  if (geminiPatch) {
    settings = await saveSettings(geminiPatch);
  }
  if (
    settings.provider === "ollama" &&
    settings.baseUrl &&
    isKnownNonOllamaBaseUrl(settings.baseUrl)
  ) {
    settings = await saveSettings({ baseUrl: DEFAULT_OLLAMA_BASE_URL });
  }
  wireTabs();
  wireOnboarding();
  wireSettingsForm();
  wireSettingsModal();
  wireAgentForm();
  wireEditorForm();
  wireSystemsUi();
  wireComponentEditor();
  dialoguePanel = createDialoguePanel({
    $,
    sendMessage,
    getSettings: () => settings,
    saveSettings,
    getRegistry: () => {
      const p = settings.provider || "onnx";
      if (p === "webllm") return webllmRegistry;
      if (p === "ollama") return ollamaRegistry;
      return registry;
    },
    setRegistry: (models) => {
      const p = settings.provider || "onnx";
      if (p === "webllm") webllmRegistry = models;
      else if (p === "ollama") ollamaRegistry = models;
      else registry = models;
    },
    getDownloadedModels: () => {
      const p = settings.provider || "onnx";
      if (p === "webllm") return downloadedWebllmModels;
      if (p === "ollama") return ollamaInstalledDownloadMap(ollamaInstalled);
      return downloadedModels;
    },
    llmModels,
    modelMetaLabel,
    webllmPickerLabel: formatWebllmPickerLabel,
    webllmMetaLabel,
    ollamaMetaLabel: formatOllamaCatalogMeta,
    startDownload,
    formatTime,
    escapeHtml,
  });
  dialoguePanel.wire();
  wireHistory();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "onnx-progress") onOnnxProgress(msg);
    if (msg?.target === "webllm-progress") onWebllmProgress(msg);
    if (msg?.target === "onnx-model-ready" && msg.model) {
      downloadedModels = { ...downloadedModels, [msg.model]: true };
      dialoguePanel?.onSettingsChanged();
    }
    if (msg?.target === "webllm-model-ready" && msg.model) {
      downloadedWebllmModels = { ...downloadedWebllmModels, [msg.model]: true };
      dialoguePanel?.onSettingsChanged();
    }
    if (msg?.type === "system.reload" && msg.systemId === currentSystemId) {
      refreshComponentEditor().catch((err) => setComponentMeta(err.message, true));
    }
    if (msg?.type === "system.updated" && msg.systemId === currentSystemId) {
      refreshComponentEditor({ keepDirty: true }).catch((err) =>
        setComponentMeta(err.message, true)
      );
    }
    if (msg?.type === "system.conversation" && msg.systemId === currentSystemId) {
      refreshHistory();
    }
  });

  if (!settings || Object.keys(settings).length === 0) {
    $("#onboarding").classList.remove("hidden");
    probeOllama();
  } else {
    applySettingsToForm();
  }

  renderModelBadge();
  await refreshSystems();
}

/** Remote providers can run for minutes; call from the panel to avoid MV3 message timeouts. */
function isPanelRemoteLlmProvider(provider) {
  return isRemoteLlmProvider(provider);
}

async function sendMessage(msg) {
  const provider = settings?.provider || "onnx";
  if (isPanelRemoteLlmProvider(provider)) {
    if (msg?.type === "dialogue.send") {
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
    }
    if (msg?.type === "dialogue.renderPrompt") {
      const model = resolveChatModel(settings);
      const tools = Array.isArray(msg.tools) && msg.tools.length ? msg.tools : undefined;
      return renderChatPromptPreview(
        { model, messages: msg.messages, ...(tools ? { tools } : {}) },
        settings
      );
    }
    if (msg?.type === "llm.test") {
      return chatCompletions(
        { model: resolveChatModel(settings), messages: [{ role: "user", content: "Hi" }], max_tokens: 1 },
        settings
      );
    }
  }
  return chrome.runtime.sendMessage(msg);
}

// --- Tabs -----------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
      if (btn.dataset.tab === "dialogue") {
        dialoguePanel?.onTabActivate();
      }
    });
  });
}

// --- Settings modal ---------------------------------------------------------

function wireSettingsModal() {
  $("#settings-icon-btn").addEventListener("click", openSettingsModal);
  $("#settings-close-btn").addEventListener("click", closeSettingsModal);
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettingsModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#settings-modal").classList.contains("hidden")) closeSettingsModal();
  });
  document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSettingsTab(btn.dataset.settingsTab));
  });
}

function switchSettingsTab(tabId) {
  const tab = tabId === "dialogue" ? "dialogue" : "llm";
  document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
    const active = btn.dataset.settingsTab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".settings-tab-panel").forEach((panel) => {
    const active = panel.id === `settings-tab-${tab}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function openSettingsModal(tabId) {
  $("#settings-modal").classList.remove("hidden");
  switchSettingsTab(tabId || "llm");
  applyThinkingToggleUi();
  if (settings.provider === "onnx") refreshOnnxSettings();
  if (settings.provider === "webllm") refreshWebllmSettings();
  if (settings.provider === "ollama") refreshOllamaSettings();
  refreshRagEmbedModelOptions();
}

function closeSettingsModal() {
  $("#settings-modal").classList.add("hidden");
}

// --- Onboarding -------------------------------------------------------------

function wireOnboarding() {
  $("#ob-onnx").addEventListener("click", async () => {
    await saveSettings({ provider: "onnx", onnxModel: "onnx-community/Qwen2.5-1.5B-Instruct" });
    $("#onboarding").classList.add("hidden");
    openSettingsModal();
    await refreshOnnxSettings();
    startOnnxDownload("onnx-community/Qwen2.5-1.5B-Instruct", "text-generation");
  });
  $("#ob-webllm").addEventListener("click", async () => {
    await saveSettings({ provider: "webllm", webllmModel: "Llama-3.2-3B-Instruct-q4f16_1-MLC" });
    $("#onboarding").classList.add("hidden");
    openSettingsModal();
    await refreshWebllmSettings();
    startWebllmDownload("Llama-3.2-3B-Instruct-q4f16_1-MLC");
  });
  $("#ob-ollama").addEventListener("click", async () => {
    await saveSettings({ provider: "ollama", baseUrl: DEFAULT_OLLAMA_BASE_URL, model: "llama3.2" });
    $("#onboarding").classList.add("hidden");
    openSettingsModal();
    await refreshOllamaSettings();
  });
  $("#ob-api").addEventListener("click", async () => {
    await saveSettings({ provider: "openai", model: DEFAULT_OPENAI_MODEL });
    $("#onboarding").classList.add("hidden");
    applySettingsToForm();
    openSettingsModal();
  });
}

async function probeOllama() {
  const label = $("#ob-ollama-status");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: ctrl.signal,
      targetAddressSpace: "loopback",
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json();
      const names = (body.models || []).map((m) => m.name).join(", ");
      label.textContent = names ? `Detected ✓ — ${names}` : "Detected ✓";
      return;
    }
  } catch {
    // fall through
  }
  label.textContent = "Not detected — install from ollama.com, then open Settings to pull a model.";
}

// --- Settings ---------------------------------------------------------------

function wireSettingsForm() {
  $("#provider-select").addEventListener("change", async (e) => {
    const prev = settings.provider || "onnx";
    const next = e.target.value;
    const patch = { provider: next };
    if (providerStoresApiKey(prev)) {
      patch.apiKeys = { [prev]: ($("#api-key")?.value || "").trim() };
    }
    if (next === "ollama") {
      if (!settings.baseUrl || isKnownNonOllamaBaseUrl(settings.baseUrl)) {
        patch.baseUrl = DEFAULT_OLLAMA_BASE_URL;
      }
    }
    if (next === "nvidia-nim") {
      patch.baseUrl = NVIDIA_NIM_BASE_URL;
      if (!settings.model) patch.model = DEFAULT_NVIDIA_NIM_MODEL;
    }
    if (next === "gemini") {
      const resolved = resolveGeminiModel(settings.model || DEFAULT_GEMINI_MODEL);
      patch.model = resolved.model;
    }
    if (next === "openai") {
      const resolved = resolveOpenAiModel(settings.model || DEFAULT_OPENAI_MODEL);
      patch.model = resolved.model;
    }
    await saveSettings(patch);
    if (prev === "onnx" && next !== "onnx") {
      await sendMessage({ type: "onnx.relay", engineType: "engine.unloadLlm" });
    }
    if (prev === "webllm" && next !== "webllm") {
      await sendMessage({ type: "webllm.relay", engineType: "engine.unload" });
    }
    applySettingsToForm();
  });
  $("#base-url").addEventListener("change", (e) => saveSettings({ baseUrl: e.target.value.trim() }));
  $("#api-key").addEventListener("change", (e) => {
    const provider = settings.provider || $("#provider-select")?.value;
    if (!providerStoresApiKey(provider)) return;
    saveSettings({ apiKeys: { [provider]: e.target.value.trim() } });
  });
  $("#model-name").addEventListener("change", (e) => {
    saveSettings({ model: e.target.value });
    applyThinkingToggleUi();
  });
  $("#nvidia-model-select")?.addEventListener("change", (e) => {
    const model = e.target.value;
    saveSettings({ model });
    const modelInput = $("#model-name");
    if (modelInput) modelInput.value = model;
    applyThinkingToggleUi();
    dialoguePanel?.onSettingsChanged();
  });
  $("#gemini-model-select")?.addEventListener("change", (e) => {
    const model = e.target.value;
    saveSettings({ model });
    const modelInput = $("#model-name");
    if (modelInput) modelInput.value = model;
    applyThinkingToggleUi();
    renderGeminiModelCatalog();
    dialoguePanel?.onSettingsChanged();
  });
  $("#openai-model-select")?.addEventListener("change", (e) => {
    const model = e.target.value;
    saveSettings({ model });
    const modelInput = $("#model-name");
    if (modelInput) modelInput.value = model;
    applyThinkingToggleUi();
    renderOpenAiModelCatalog();
    dialoguePanel?.onSettingsChanged();
  });
  $("#gemini-refresh-models-btn")?.addEventListener("click", () => refreshGeminiModelsFromApi());
  $("#max-steps-input").addEventListener("change", (e) => {
    const n = Math.min(100, Math.max(1, Math.floor(Number(e.target.value)) || DEFAULT_MAX_STEPS));
    e.target.value = n;
    saveSettings({ maxSteps: n });
  });
  $("#max-tokens-input").addEventListener("change", (e) => {
    const n = getMaxTokens({ maxTokens: e.target.value });
    e.target.value = n;
    saveSettings({ maxTokens: n });
  });
  $("#dialogue-max-tool-rounds-input")?.addEventListener("change", (e) => {
    const n = getDialogueMaxToolRounds({ dialogueMaxToolRounds: e.target.value });
    e.target.value = n;
    saveSettings({ dialogueMaxToolRounds: n });
  });
  $("#enable-thinking-input")?.addEventListener("change", (e) => {
    if (!providerSupportsThinkingToggle(settings.provider || "onnx")) {
      e.target.checked = false;
      return;
    }
    saveSettings({ enableThinking: e.target.checked });
  });
  $("#tavily-api-key").addEventListener("change", (e) => saveSettings({ tavilyApiKey: e.target.value.trim() }));
  const ragToolsSetting = $("#dialogue-rag-tools-setting");
  if (ragToolsSetting) ragToolsSetting.addEventListener("change", (e) => saveSettings({ dialogueRagTools: e.target.checked }));
  $("#rag-embed-provider").addEventListener("change", (e) => saveSettings({ ragEmbedProvider: e.target.value }));
  wireEmbedModelSelect($("#rag-onnx-embed-model"), $("#rag-onnx-embed-model-custom"), (modelId) =>
    saveSettings({ ragOnnxEmbedModel: modelId })
  );
  $("#rag-webllm-embed-model").addEventListener("change", (e) => saveSettings({ ragWebllmEmbedModel: e.target.value }));
  wireEmbedModelSelect($("#rag-ollama-embed-model"), $("#rag-ollama-embed-model-custom"), (modelId) =>
    saveSettings({ ragOllamaEmbedModel: modelId })
  );
  $("#rag-openai-embed-model")?.addEventListener("change", (e) => saveSettings({ ragOpenaiEmbedModel: e.target.value }));
  $("#rag-gemini-embed-model")?.addEventListener("change", (e) => saveSettings({ ragGeminiEmbedModel: e.target.value }));
  $("#rag-nvidia-embed-model")?.addEventListener("change", (e) => saveSettings({ ragNvidiaEmbedModel: e.target.value }));
  wireEmbedModelSelect(
    $("#rag-openai-compatible-embed-model"),
    $("#rag-openai-compatible-embed-model-custom"),
    (modelId) => saveSettings({ ragOpenaiCompatibleEmbedModel: modelId })
  );
  $("#rag-ollama-embed-refresh-btn")?.addEventListener("click", () => refreshOllamaPulledModels({ embedOnly: true }));
  $("#rag-chunk-size").addEventListener("change", (e) => saveSettings({ ragChunkSize: Number(e.target.value) || 800 }));
  $("#rag-chunk-overlap").addEventListener("change", (e) => saveSettings({ ragChunkOverlap: Number(e.target.value) || 120 }));
  $("#onnx-unload-btn").addEventListener("click", async () => {
    await sendMessage({ type: "onnx.relay", engineType: "engine.unload" });
    await refreshOnnxSettings();
  });
  $("#onnx-clear-cache-btn").addEventListener("click", async () => {
    if (!confirm("Delete all cached ONNX model weights from IndexedDB? You'll need to re-download models.")) return;
    await sendMessage({ type: "onnx.relay", engineType: "engine.clearCache" });
    await chrome.storage.local.set({ onnxModels: {} });
    downloadedModels = {};
    await refreshOnnxSettings();
  });
  $("#webllm-unload-btn").addEventListener("click", async () => {
    await sendMessage({ type: "webllm.relay", engineType: "engine.unload" });
    await refreshWebllmSettings();
  });
  $("#webllm-clear-cache-btn").addEventListener("click", async () => {
    if (!confirm("Delete all cached WebLLM model weights from IndexedDB? You'll need to re-download models.")) return;
    await sendMessage({ type: "webllm.relay", engineType: "engine.clearCache" });
    await chrome.storage.local.set({ webllmModels: {} });
    downloadedWebllmModels = {};
    await refreshWebllmSettings();
  });
  $("#ollama-base-url").addEventListener("change", async (e) => {
    await saveSettings({ baseUrl: e.target.value.trim() });
    await refreshOllamaSettings();
  });
  $("#ollama-catalog-search").addEventListener("input", (e) => {
    ollamaCatalogSearch = e.target.value.trim();
    clearTimeout(ollamaSearchTimer);
    ollamaSearchTimer = setTimeout(() => reloadOllamaCatalog(), 300);
  });
  $("#ollama-catalog-filter").addEventListener("change", (e) => {
    ollamaCatalogFilter = e.target.value;
    reloadOllamaCatalog();
  });
  $("#ollama-refresh-pulled-btn")?.addEventListener("click", () => refreshOllamaPulledModels());
  $("#ollama-load-more-btn").addEventListener("click", () => loadMoreOllamaCatalog());
  $("#ollama-custom-pull-btn").addEventListener("click", () => {
    const name = $("#ollama-custom-pull")?.value?.trim();
    if (!name) return;
    startOllamaPull(name);
  });
  $("#ollama-custom-pull").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#ollama-custom-pull-btn")?.click();
    }
  });
  $("#test-connection-btn").addEventListener("click", testConnection);
}

function renderGeminiModelSelect() {
  const select = $("#gemini-model-select");
  if (!select) return;
  const current = settings.model || DEFAULT_GEMINI_MODEL;
  select.innerHTML = "";
  for (const m of listGeminiModels()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = formatGeminiPickerLabel(m);
    select.appendChild(opt);
  }
  if (current && !listGeminiModels().some((m) => m.id === current)) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = `${geminiModelLabel(current)} (${current})`;
    select.prepend(opt);
  }
  select.value = current;
  const modelInput = $("#model-name");
  if (modelInput) modelInput.value = current;
  renderGeminiModelCatalog();
}

function renderGeminiModelCatalog() {
  const list = $("#gemini-model-catalog");
  if (!list) return;
  list.innerHTML = "";
  const selected = settings.model || DEFAULT_GEMINI_MODEL;

  for (const m of listGeminiModels()) {
    const li = document.createElement("li");
    li.className = m.id === selected ? "selected" : "";

    const caps = [
      m.thinking ? "Thinking" : "No thinking",
      m.tools ? "Tools" : "No tools",
      `In: ${m.inputs}`,
      `Out: ${m.output}`,
    ].join(" · ");

    li.innerHTML = `
      <span class="model-info">
        <span class="model-name">${escapeHtml(m.label)} <code>${escapeHtml(m.id)}</code></span>
        <small class="model-meta">${escapeHtml(`${m.priceIn} in · ${m.priceOut} out /1M`)}</small>
        <small class="model-context">${escapeHtml(caps)}</small>
        ${m.priceNote ? `<small class="model-context">${escapeHtml(m.priceNote)}</small>` : ""}
      </span>
      <span class="badge ${m.tier}">${m.tier}</span>
    `;

    const actions = document.createElement("span");
    actions.className = "model-actions";
    const btn = document.createElement("button");
    btn.textContent = m.id === selected ? "Selected" : "Use";
    btn.disabled = m.id === selected;
    btn.addEventListener("click", async () => {
      await saveSettings({ model: m.id });
      const select = $("#gemini-model-select");
      if (select) select.value = m.id;
      const modelInput = $("#model-name");
      if (modelInput) modelInput.value = m.id;
      applyThinkingToggleUi();
      renderGeminiModelCatalog();
      renderModelBadge();
      dialoguePanel?.onSettingsChanged();
    });
    actions.appendChild(btn);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

function renderOpenAiModelSelect() {
  const select = $("#openai-model-select");
  if (!select) return;
  const current = resolveOpenAiModel(settings.model || DEFAULT_OPENAI_MODEL).model;
  select.innerHTML = "";
  for (const m of listOpenAiFlagshipModels()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = formatOpenAiPickerLabel(m);
    select.appendChild(opt);
  }
  if (current && !listOpenAiFlagshipModels().some((m) => m.id === current)) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = `${openAiModelLabel(current)} (${current})`;
    select.prepend(opt);
  }
  select.value = current;
  const modelInput = $("#model-name");
  if (modelInput) modelInput.value = current;
  renderOpenAiModelCatalog();
}

function renderOpenAiModelCatalog() {
  const list = $("#openai-model-catalog");
  if (!list) return;
  list.innerHTML = "";
  const selected = resolveOpenAiModel(settings.model || DEFAULT_OPENAI_MODEL).model;

  for (const m of listOpenAiFlagshipModels()) {
    const li = document.createElement("li");
    li.className = m.id === selected ? "selected" : "";

    const caps = [
      m.thinking ? "Thinking" : "No thinking",
      m.tools ? "Tools" : "No tools",
      `In: ${m.inputs}`,
      `Out: ${m.output}`,
    ].join(" · ");

    li.innerHTML = `
      <span class="model-info">
        <span class="model-name">${escapeHtml(m.label)} <code>${escapeHtml(m.id)}</code></span>
        ${m.description ? `<small class="model-context">${escapeHtml(m.description)}</small>` : ""}
        <small class="model-meta">${escapeHtml(`${m.priceIn} in · ${m.priceOut} out /1M`)}</small>
        <small class="model-context">${escapeHtml(caps)}</small>
        ${m.priceNote ? `<small class="model-context">${escapeHtml(m.priceNote)}</small>` : ""}
      </span>
      <span class="badge ${m.tier}">${m.tier}</span>
    `;

    const actions = document.createElement("span");
    actions.className = "model-actions";
    const btn = document.createElement("button");
    btn.textContent = m.id === selected ? "Selected" : "Use";
    btn.disabled = m.id === selected;
    btn.addEventListener("click", async () => {
      await saveSettings({ model: m.id });
      const select = $("#openai-model-select");
      if (select) select.value = m.id;
      const modelInput = $("#model-name");
      if (modelInput) modelInput.value = m.id;
      applyThinkingToggleUi();
      renderOpenAiModelCatalog();
      renderModelBadge();
      dialoguePanel?.onSettingsChanged();
    });
    actions.appendChild(btn);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

async function refreshGeminiModelsFromApi() {
  const errEl = $("#gemini-catalog-error");
  const btn = $("#gemini-refresh-models-btn");
  const apiKey = (resolveApiKey(settings, "gemini") || $("#api-key")?.value || "").trim();
  if (!apiKey) {
    if (errEl) {
      errEl.textContent = "Add your Gemini API key above, then refresh.";
      errEl.classList.remove("hidden");
    }
    return;
  }
  if (errEl) errEl.classList.add("hidden");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Refreshing…";
  }
  try {
    await fetchGeminiModelsFromApi(apiKey);
    renderGeminiModelSelect();
    if (errEl) {
      errEl.textContent = `Loaded ${listGeminiModels().length} generateContent models from API.`;
      errEl.classList.remove("hidden");
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove("hidden");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Refresh from API";
    }
  }
}

function renderNvidiaModelSelect() {
  const select = $("#nvidia-model-select");
  if (!select) return;
  const current = settings.model || DEFAULT_NVIDIA_NIM_MODEL;
  select.innerHTML = "";
  for (const m of listNvidiaNimModels()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.label} (${m.id})`;
    select.appendChild(opt);
  }
  if (current && !listNvidiaNimModels().some((m) => m.id === current)) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = `${nvidiaNimModelLabel(current)} (${current})`;
    select.prepend(opt);
  }
  select.value = current;
  const modelInput = $("#model-name");
  if (modelInput) modelInput.value = current;
}

function applyThinkingToggleUi() {
  const provider = settings.provider || "onnx";
  const available = providerSupportsThinkingToggle(provider);
  const cb = $("#enable-thinking-input");
  const wrap = $("#enable-thinking-wrap");
  const hint = $("#enable-thinking-hint");
  if (!cb || !hint) return;

  cb.disabled = !available;
  wrap?.classList.toggle("settings-checkbox--disabled", !available);
  if (available) cb.checked = settings.enableThinking !== false;
  hint.textContent = getThinkingHintForSettings(settings);
}

function applySettingsToForm() {
  $("#provider-select").value = settings.provider || "onnx";
  $("#base-url").value = resolveLlmBaseUrl(settings) || "";
  $("#api-key").value = resolveApiKey(settings) || "";
  $("#model-name").value = settings.model || "";
  renderNvidiaModelSelect();
  renderGeminiModelSelect();
  renderOpenAiModelSelect();
  $("#max-steps-input").value = settings.maxSteps || DEFAULT_MAX_STEPS;
  $("#max-tokens-input").value = getMaxTokens(settings);
  const toolRoundsInput = $("#dialogue-max-tool-rounds-input");
  if (toolRoundsInput) toolRoundsInput.value = getDialogueMaxToolRounds(settings);
  const thinkingCb = $("#enable-thinking-input");
  if (thinkingCb && providerSupportsThinkingToggle(settings.provider || "onnx")) {
    thinkingCb.checked = settings.enableThinking !== false;
  }
  $("#tavily-api-key").value = settings.tavilyApiKey || "";
  const webSearchCb = $("#dialogue-web-search-enabled");
  if (webSearchCb) webSearchCb.checked = settings.dialogueWebSearch !== false;
  const browserToolsCb = $("#dialogue-browser-tools-enabled");
  if (browserToolsCb) browserToolsCb.checked = settings.dialogueBrowserTools !== false;
  const ragToolsSetting = $("#dialogue-rag-tools-setting");
  if (ragToolsSetting) ragToolsSetting.checked = settings.dialogueRagTools !== false;
  $("#rag-embed-provider").value = settings.ragEmbedProvider || "auto";
  // Embed model <select>s are populated (and their values set) by refreshRagEmbedModelOptions(),
  // since assigning .value before their <option>s exist would silently no-op.
  $("#rag-chunk-size").value = settings.ragChunkSize ?? 800;
  $("#rag-chunk-overlap").value = settings.ragChunkOverlap ?? 120;

  const provider = settings.provider || "onnx";
  const isOnnx = provider === "onnx";
  const isWebllm = provider === "webllm";
  const isOllama = provider === "ollama";
  const isNvidiaNim = provider === "nvidia-nim";
  const isGemini = provider === "gemini";
  const isOpenAi = provider === "openai";
  const isAnthropic = provider === "anthropic";
  const isOpenAiCompatible = provider === "openai-compatible";
  const isLocalEngine = isOnnx || isWebllm;
  $("#onnx-settings").classList.toggle("hidden", !isOnnx);
  $("#webllm-settings").classList.toggle("hidden", !isWebllm);
  $("#ollama-settings").classList.toggle("hidden", !isOllama);
  $("#remote-settings").classList.toggle("hidden", isLocalEngine || isOllama);
  $("#rag-remote-embed-openai")?.classList.toggle("hidden", !isOpenAi);
  $("#rag-remote-embed-gemini")?.classList.toggle("hidden", !isGemini);
  $("#rag-remote-embed-nvidia")?.classList.toggle("hidden", !isNvidiaNim);
  $("#rag-remote-embed-compatible")?.classList.toggle("hidden", !isOpenAiCompatible);
  $("#rag-remote-embed-anthropic-hint")?.classList.toggle("hidden", !isAnthropic);
  $("#nvidia-base-url-line")?.classList.toggle("hidden", !isNvidiaNim);
  $("#gemini-base-url-line")?.classList.toggle("hidden", !isGemini);
  $("#remote-base-url-wrap")?.classList.toggle("hidden", isNvidiaNim || isGemini);
  $("#nvidia-model-select")?.classList.toggle("hidden", !isNvidiaNim);
  $("#nvidia-model-label")?.classList.toggle("hidden", !isNvidiaNim);
  $("#gemini-model-select")?.classList.toggle("hidden", !isGemini);
  $("#gemini-model-label")?.classList.toggle("hidden", !isGemini);
  $("#gemini-model-catalog-wrap")?.classList.toggle("hidden", !isGemini);
  $("#openai-model-select")?.classList.toggle("hidden", !isOpenAi);
  $("#openai-model-label")?.classList.toggle("hidden", !isOpenAi);
  $("#openai-model-catalog-wrap")?.classList.toggle("hidden", !isOpenAi);
  $("#remote-model-label")?.classList.toggle("hidden", isNvidiaNim || isGemini || isOpenAi);
  $("#model-name")?.classList.toggle("hidden", isNvidiaNim || isGemini || isOpenAi);
  const apiKeyInput = $("#api-key");
  if (apiKeyInput) {
    apiKeyInput.placeholder = apiKeyPlaceholder(provider);
  }
  if (isOnnx) refreshOnnxSettings();
  if (isWebllm) refreshWebllmSettings();
  if (isOllama) {
    const baseInput = $("#ollama-base-url");
    if (baseInput) baseInput.value = resolveOllamaBaseUrl(settings);
    refreshOllamaSettings();
  }
  const noteEl = $("#remote-context-note");
  if (noteEl) {
    noteEl.textContent = isLocalEngine || isOllama
      ? ""
      : isNvidiaNim
        ? "NVIDIA NIM uses OpenAI-compatible chat completions. Reasoning is controlled for GLM, Qwen3, and DeepSeek models."
        : isGemini
          ? "Gemini uses the Google generateContent API. See the model catalog below for pricing, thinking, tools, and I/O types."
          : isOpenAi
            ? "OpenAI uses chat completions. See the flagship model catalog below for pricing, thinking, tools, and I/O types."
            : "Context-length estimate not available for remote providers — check the provider's docs for this model's context window.";
  }
  if (isGemini) renderGeminiModelCatalog();
  if (isOpenAi) renderOpenAiModelCatalog();
  applyThinkingToggleUi();
  renderModelBadge();
  refreshRagEmbedModelOptions();
  dialoguePanel?.onSettingsChanged();
}

function ollamaBaseUrl() {
  return resolveOllamaBaseUrl(settings);
}

/** Rewrite untagged catalog ids (e.g. gemma4) to a pulled tag (gemma4:e4b). */
async function persistResolvedOllamaModel(installed) {
  if (settings.provider !== "ollama") return;
  const requested = (settings.model || "").trim();
  if (!requested || !installed?.size) return;
  const resolved = resolveOllamaInstalledName(requested, installed);
  if (resolved && resolved !== requested && installed.has(resolved)) {
    await saveSettings({ model: resolved });
  }
}

function ollamaCatalogQueryOpts() {
  const opts = { search: ollamaCatalogSearch, skip: ollamaCatalogSkip, limit: OLLAMA_CATALOG_PAGE };
  if (ollamaCatalogFilter === "official") opts.modelType = "official";
  else if (ollamaCatalogFilter.startsWith("cap:")) opts.capability = ollamaCatalogFilter.slice(4);
  return opts;
}

async function reloadOllamaCatalog() {
  ollamaCatalogSkip = 0;
  ollamaRegistry = [];
  await loadMoreOllamaCatalog(true);
}

async function loadMoreOllamaCatalog(replace = false) {
  const errEl = $("#ollama-catalog-error");
  const loadMoreBtn = $("#ollama-load-more-btn");
  if (loadMoreBtn) loadMoreBtn.disabled = true;
  try {
    const page = await fetchOllamaCatalog(ollamaCatalogQueryOpts());
    ollamaCatalogTotal = page.totalCount;
    if (replace) ollamaRegistry = page.models;
    else ollamaRegistry = [...ollamaRegistry, ...page.models];
    ollamaCatalogSkip += page.models.length;
    if (errEl) {
      errEl.classList.add("hidden");
      errEl.textContent = "";
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = `Catalog unavailable: ${err.message}. Showing locally installed models only.`;
      errEl.classList.remove("hidden");
    }
    if (replace) ollamaRegistry = [];
  } finally {
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      const hasMore = ollamaRegistry.length < ollamaCatalogTotal;
      loadMoreBtn.classList.toggle("hidden", !hasMore || ollamaRegistry.length === 0);
    }
    renderOllamaRegistry();
  }
}

function updateOllamaServerStatus(installed, reachable, error, base) {
  const statusEl = $("#ollama-server-status");
  const hintEl = $("#ollama-cache-hint");
  if (statusEl) {
    if (!reachable) {
      statusEl.textContent = `Server: not reachable — is Ollama running at ${base}?`;
    } else if (error) {
      statusEl.textContent = `Server: reachable but ${error}`;
    } else {
      const n = installed.size;
      statusEl.textContent = n
        ? `Server: connected ✓ — ${n} model(s) pulled`
        : "Server: connected ✓ — no models pulled yet";
    }
  }
  if (hintEl) {
    hintEl.textContent = installed.size
      ? `Active model: ${settings.model || "(none selected)"}`
      : "Pull a model below to use Ollama with this extension.";
  }
}

/** Query Ollama GET /api/tags for locally pulled models (e.g. after `ollama pull` in a terminal). */
async function refreshOllamaPulledModels({ embedOnly = false } = {}) {
  const base = ollamaBaseUrl();
  const errEl = $("#ollama-catalog-error");
  const btn = embedOnly ? $("#rag-ollama-embed-refresh-btn") : $("#ollama-refresh-pulled-btn");
  const btnLabel = embedOnly ? "Refresh pulled embed models" : "Refresh pulled models";

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Refreshing…";
  }
  if (!embedOnly && errEl) errEl.classList.add("hidden");

  try {
    const { installed, reachable, error } = await listOllamaInstalled(base);
    ollamaInstalled = installed;
    updateOllamaServerStatus(installed, reachable, error, base);

    if (!reachable) {
      throw new Error(`Ollama not reachable at ${base}`);
    }
    if (error) {
      throw new Error(error);
    }

    await persistResolvedOllamaModel(installed);

    if (!embedOnly) {
      renderOllamaRegistry();
      if (errEl) {
        const n = installed.size;
        errEl.textContent = n
          ? `Found ${n} pulled model(s) on ${base}.`
          : `Connected to ${base} — no models pulled yet. Use Pull below or run ollama pull in a terminal.`;
        errEl.classList.remove("hidden");
      }
    }

    await refreshRagEmbedModelOptions();
    dialoguePanel?.onSettingsChanged();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove("hidden");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btnLabel;
    }
  }
}

async function refreshOllamaSettings() {
  const base = ollamaBaseUrl();
  const searchInput = $("#ollama-catalog-search");
  const filterSelect = $("#ollama-catalog-filter");

  if (searchInput && searchInput.value !== ollamaCatalogSearch) searchInput.value = ollamaCatalogSearch;
  if (filterSelect && filterSelect.value !== ollamaCatalogFilter) filterSelect.value = ollamaCatalogFilter;

  const { installed, reachable, error } = await listOllamaInstalled(base);
  ollamaInstalled = installed;
  updateOllamaServerStatus(installed, reachable, error, base);
  await persistResolvedOllamaModel(installed);

  if (ollamaRegistry.length === 0 && ollamaCatalogSkip === 0) {
    await reloadOllamaCatalog();
  } else {
    renderOllamaRegistry();
  }
  dialoguePanel?.onSettingsChanged();
}

function buildOllamaRegistryRows() {
  const rows = [...ollamaRegistry];
  const seenIds = new Set(rows.map((r) => r.id));
  for (const name of ollamaInstalled) {
    if (seenIds.has(name)) continue;
    rows.push({
      id: name,
      label: name,
      description: "Installed locally (not in catalog)",
      labels: [],
      installedOnly: true,
    });
    seenIds.add(name);
  }
  return rows;
}

function renderOllamaRegistry() {
  const list = $("#ollama-registry");
  if (!list) return;
  list.innerHTML = "";
  const rows = buildOllamaRegistryRows();
  const selectedId = settings.model || rows.find((m) => m.tier === "default")?.id || "";
  const resolvedSelected = resolveOllamaInstalledName(selectedId, ollamaInstalled);

  for (const m of rows) {
    const li = document.createElement("li");
    const installed = isOllamaModelInstalled(ollamaInstalled, m.id);
    const isUsing = m.id === selectedId || m.id === resolvedSelected;
    li.className = isUsing ? "selected" : "";

    li.innerHTML = `
      <span class="model-info">
        <span class="model-name"><code>${escapeHtml(m.id)}</code></span>
        <small class="model-meta">${escapeHtml(formatOllamaCatalogMeta(m) || m.id)}</small>
        ${m.description ? `<small class="model-context">${escapeHtml(m.description.slice(0, 120))}${m.description.length > 120 ? "…" : ""}</small>` : ""}
      </span>
      <span class="badge ${installed ? "downloaded" : ""}">${installed ? "Pulled" : "Not pulled"}</span>
    `;

    const actions = document.createElement("span");
    actions.className = "model-actions";
    const btn = document.createElement("button");
    if (ollamaPulling) {
      btn.textContent = "Pulling…";
      btn.disabled = true;
    } else if (installed) {
      btn.textContent = isUsing ? "Selected" : "Use";
      btn.disabled = isUsing;
      btn.addEventListener("click", async () => {
        await saveSettings({ model: m.id });
        renderOllamaRegistry();
        renderModelBadge();
      });
    } else {
      btn.textContent = "Pull";
      btn.addEventListener("click", async () => {
        await saveSettings({ model: m.id });
        startOllamaPull(m.id);
      });
    }
    actions.appendChild(btn);

    if (installed) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.className = "danger";
      delBtn.disabled = ollamaPulling;
      delBtn.addEventListener("click", async () => {
        const variants = getInstalledVariants(ollamaInstalled, m.id);
        if (!variants.length) return;
        let toDelete = variants;
        if (variants.length > 1) {
          const pick = prompt(
            `Multiple variants installed:\n${variants.join("\n")}\n\nEnter the exact name to delete, or leave blank to cancel:`,
            variants[0]
          );
          if (!pick || !variants.includes(pick)) return;
          toDelete = [pick];
        } else if (!confirm(`Delete ${variants[0]} from Ollama?`)) {
          return;
        }
        delBtn.disabled = true;
        try {
          for (const name of toDelete) {
            await deleteOllamaModel(ollamaBaseUrl(), name);
          }
          await refreshOllamaSettings();
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
          delBtn.disabled = false;
        }
      });
      actions.appendChild(delBtn);
    }

    li.appendChild(actions);
    list.appendChild(li);
  }
}

function onOllamaProgress(event) {
  const wrap = $("#ollama-progress-wrap");
  if (!wrap) return;
  wrap.classList.remove("hidden");
  const pct =
    event.total && event.completed != null ? Math.round((event.completed / event.total) * 100) : 0;
  $("#ollama-progress-fill").style.width = `${pct}%`;
  const status = event.status || "pulling";
  $("#ollama-progress-label").textContent =
    `${status} ${event.total ? pct + "%" : ""}`.trim();
}

async function startOllamaPull(modelId) {
  if (ollamaPulling) return;
  const pullId = ollamaCatalogPullId(modelId);
  ollamaPulling = true;
  ollamaPullAbort?.abort();
  ollamaPullAbort = new AbortController();
  const wrap = $("#ollama-progress-wrap");
  wrap?.classList.remove("hidden");
  $("#ollama-progress-fill").style.width = "0%";
  $("#ollama-progress-label").textContent = `Pulling ${pullId}…`;
  renderOllamaRegistry();

  try {
    await pullOllamaModel(ollamaBaseUrl(), pullId, {
      signal: ollamaPullAbort.signal,
      onProgress: onOllamaProgress,
    });
    const variants = getInstalledVariants(
      (await listOllamaInstalled(ollamaBaseUrl())).installed,
      pullId
    );
    await saveSettings({ model: variants[0] || pullId });
    wrap?.classList.add("hidden");
    await refreshOllamaSettings();
    renderModelBadge();
  } catch (err) {
    if (err.name === "AbortError") {
      $("#ollama-progress-label").textContent = "Pull cancelled.";
    } else {
      $("#ollama-progress-fill").style.width = "0%";
      $("#ollama-progress-label").textContent = `✗ ${err.message}`;
    }
  } finally {
    ollamaPulling = false;
    ollamaPullAbort = null;
    renderOllamaRegistry();
  }
}

async function saveSettings(patch) {
  settings = await sendMessage({ type: "settings.set", patch });
  renderModelBadge();
  dialoguePanel?.onSettingsChanged();
  return settings;
}

async function refreshOnnxSettings() {
  const { onnxModels } = await chrome.storage.local.get("onnxModels");
  downloadedModels = onnxModels || {};

  const statusRes = await sendMessage({ type: "onnx.relay", engineType: "engine.status" });
  if (statusRes?.error) {
    $("#onnx-device").textContent = "Device: not started yet";
    $("#onnx-cache-hint").textContent = "";
  } else {
    const deviceLabel = statusRes.device === "webgpu" ? "GPU (WebGPU)" : statusRes.device === "wasm" ? "CPU (slow)" : "unknown";
    $("#onnx-device").textContent = `Device: ${statusRes.device ? deviceLabel : "not started yet"}`;
    const files = statusRes.cachedFiles || [];
    const totalMB = files.reduce((sum, f) => sum + (f.size || 0), 0) / (1024 * 1024);
    $("#onnx-cache-hint").textContent = files.length
      ? `IndexedDB cache: ${files.length} file(s), ~${totalMB.toFixed(0)} MB`
      : "IndexedDB cache: empty";
    registry = statusRes.registry || registry;
    lastKnownDevice = statusRes.device || lastKnownDevice;
    renderModelBadge();
  }

  if (registry.length === 0) {
    const modelsRes = await sendMessage({ type: "onnx.relay", engineType: "engine.models", task: "*" });
    // Fallback: full registry via status already attempted; try chat models only then
    if (!modelsRes?.models?.length) {
      const llmRes = await sendMessage({ type: "onnx.relay", engineType: "engine.models" });
      registry = llmRes?.models || [];
    } else {
      registry = modelsRes.models;
    }
  }

  // Drop stored model picks that were removed from the registry — otherwise
  // chat/agent runs keep requesting a dead HF repo (401/404) forever.
  if (registry.length) {
    const stale = {};
    for (const key of ["onnxModel", "onnxCaptionModel", "onnxClassifyModel", "onnxAsrModel"]) {
      if (settings[key] && !registry.some((m) => m.id === settings[key])) stale[key] = null;
    }
    if (Object.keys(stale).length) await saveSettings(stale);
  }

  const loadedByTask = {};
  for (const entry of statusRes?.loaded || []) {
    loadedByTask[entry.task] = entry.model;
  }
  // Back-compat if older engine only returns loadedModel
  if (!loadedByTask["text-generation"] && statusRes?.loadedModel) {
    loadedByTask["text-generation"] = statusRes.loadedModel;
  }

  renderRegistrySection("onnx-registry", "text-generation", "onnxModel", llmLoadedModel(loadedByTask), { modality: "llm" });
  renderRegistrySection("onnx-registry-caption", "image-to-text", "onnxCaptionModel", loadedByTask["image-to-text"]);
  renderRegistrySection("onnx-registry-classify", "image-classification", "onnxClassifyModel", loadedByTask["image-classification"]);
  renderRegistrySection("onnx-registry-asr", "automatic-speech-recognition", "onnxAsrModel", loadedByTask["automatic-speech-recognition"]);
  dialoguePanel?.onSettingsChanged();
}

async function refreshWebllmSettings() {
  const { webllmModels } = await chrome.storage.local.get("webllmModels");
  downloadedWebllmModels = webllmModels || {};

  const statusRes = await sendMessage({ type: "webllm.relay", engineType: "engine.status" });
  if (statusRes?.error) {
    $("#webllm-device").textContent = "Device: not started yet";
    $("#webllm-cache-hint").textContent = "";
  } else {
    const deviceLabel =
      statusRes.device === "webgpu"
        ? "GPU (WebGPU)"
        : statusRes.device === "unavailable"
          ? "WebGPU unavailable"
          : "unknown";
    $("#webllm-device").textContent = `Device: ${deviceLabel}`;
    const cached = statusRes.cachedModels || [];
    webllmRegistry = statusRes.registry || webllmRegistry;
    const catalogCount = webllmRegistry.length || statusRes.registry?.length || 0;
    $("#webllm-cache-hint").textContent = cached.length
      ? `IndexedDB cache: ${cached.length} model(s) cached · ${catalogCount} in catalog`
      : catalogCount
        ? `${catalogCount} models in catalog (IndexedDB cache empty)`
        : "IndexedDB cache: empty";
    lastKnownDevice = statusRes.device === "webgpu" ? "webgpu" : lastKnownDevice;
    renderModelBadge();
  }

  if (webllmRegistry.length === 0) {
    const modelsRes = await sendMessage({ type: "webllm.relay", engineType: "engine.models" });
    webllmRegistry = modelsRes?.models || [];
  }

  if (webllmRegistry.length && settings.webllmModel && !webllmRegistry.some((m) => m.id === settings.webllmModel)) {
    await saveSettings({ webllmModel: null });
  }

  const loadedModel = statusRes?.loadedModel || null;
  renderWebllmRegistry(loadedModel);
  dialoguePanel?.onSettingsChanged();
}

// --- RAG embed model pickers -------------------------------------------------

const CUSTOM_EMBED_MODEL_VALUE = "__custom__";

/** Fill a <select> with known embed models for one provider; falls back to a "Custom…" entry + companion text input when allowed. */
function renderEmbedModelSelect(select, models, currentValue, { allowCustom = true } = {}) {
  if (!select) return;
  select.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.approxSizeMB ? `${m.label || m.id} (${sizeLabel(m.approxSizeMB)})` : m.label || m.id;
    select.appendChild(opt);
  }
  const known = new Set(models.map((m) => m.id));
  if (allowCustom) {
    const opt = document.createElement("option");
    opt.value = CUSTOM_EMBED_MODEL_VALUE;
    opt.textContent = "Custom…";
    select.appendChild(opt);
  }
  const hasCurrent = known.has(currentValue);
  select.value = hasCurrent ? currentValue : allowCustom ? CUSTOM_EMBED_MODEL_VALUE : models[0]?.id || "";

  const customInput = document.getElementById(`${select.id}-custom`);
  if (!customInput) return;
  const showCustom = select.value === CUSTOM_EMBED_MODEL_VALUE;
  customInput.classList.toggle("hidden", !showCustom);
  if (showCustom) customInput.value = hasCurrent ? "" : currentValue || "";
}

/** Wire a "provider select + custom text input" pair: selecting "Custom…" reveals the input, and either one saves on change. */
function wireEmbedModelSelect(select, customInput, onSave) {
  if (!select) return;
  select.addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === CUSTOM_EMBED_MODEL_VALUE) {
      customInput?.classList.remove("hidden");
      customInput?.focus();
      return;
    }
    customInput?.classList.add("hidden");
    onSave(v);
  });
  customInput?.addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) onSave(v);
  });
}

/** Single-entry fallback so a <select> never ends up fully empty when a provider is unreachable. */
function fallbackEmbedModelList(modelId) {
  return modelId ? [{ id: modelId, label: modelId }] : [];
}

/** Populate embed-model <select>s in Settings → LLM. Best-effort per provider — one failing shouldn't block the others. */
async function refreshRagEmbedModelOptions() {
  await Promise.all([
    (async () => {
      const current = settings.ragOnnxEmbedModel || DEFAULT_ONNX_EMBED_MODEL;
      try {
        const res = await sendMessage({ type: "onnx.relay", engineType: "engine.models", task: "feature-extraction" });
        renderEmbedModelSelect($("#rag-onnx-embed-model"), res?.models || [], current);
      } catch (err) {
        console.warn("[rag] failed to load ONNX embed model list:", err);
        renderEmbedModelSelect($("#rag-onnx-embed-model"), fallbackEmbedModelList(current), current);
      }
    })(),
    (async () => {
      const current = settings.ragWebllmEmbedModel || DEFAULT_WEBLLM_EMBED_MODEL;
      try {
        const res = await sendMessage({ type: "webllm.relay", engineType: "engine.embedModels" });
        renderEmbedModelSelect($("#rag-webllm-embed-model"), res?.models || [], current, { allowCustom: false });
      } catch (err) {
        console.warn("[rag] failed to load WebLLM embed model list:", err);
        renderEmbedModelSelect($("#rag-webllm-embed-model"), fallbackEmbedModelList(current), current, { allowCustom: false });
      }
    })(),
    (async () => {
      const current = settings.ragOllamaEmbedModel || DEFAULT_OLLAMA_EMBED_MODEL;
      try {
        const installed = await listOllamaModelsWithMeta(ollamaBaseUrl());
        const embedModels = installed.filter((m) => (m.capabilities || []).map((c) => String(c).toLowerCase()).includes("embedding"));
        renderEmbedModelSelect($("#rag-ollama-embed-model"), embedModels, current);
      } catch (err) {
        console.warn("[rag] failed to load Ollama embed model list:", err);
        renderEmbedModelSelect($("#rag-ollama-embed-model"), fallbackEmbedModelList(current), current);
      }
    })(),
    (async () => {
      const current = settings.ragOpenaiEmbedModel || DEFAULT_OPENAI_EMBED_MODEL;
      renderEmbedModelSelect($("#rag-openai-embed-model"), listOpenAiEmbedModels(), current, { allowCustom: false });
    })(),
    (async () => {
      const current = settings.ragGeminiEmbedModel || DEFAULT_GEMINI_EMBED_MODEL;
      renderEmbedModelSelect($("#rag-gemini-embed-model"), listGeminiEmbedModels(), current, { allowCustom: false });
    })(),
    (async () => {
      const current = settings.ragNvidiaEmbedModel || DEFAULT_NVIDIA_EMBED_MODEL;
      renderEmbedModelSelect($("#rag-nvidia-embed-model"), listNvidiaEmbedModels(), current, { allowCustom: false });
    })(),
    (async () => {
      const current = settings.ragOpenaiCompatibleEmbedModel || DEFAULT_OPENAI_COMPATIBLE_EMBED_MODEL;
      renderEmbedModelSelect($("#rag-openai-compatible-embed-model"), listOpenAiEmbedModels(), current);
    })(),
  ]);
}

function webllmMetaLabel(entry) {
  return formatWebllmRegistryMeta(entry, { sizeLabel });
}

function renderWebllmRegistry(loadedModel) {
  const list = $("#webllm-registry");
  if (!list) return;
  list.innerHTML = "";
  const models = webllmRegistry;
  const selectedId = settings.webllmModel || models.find((m) => m.tier === "default")?.id || models[0]?.id;

  for (const m of models) {
    const li = document.createElement("li");
    li.className = m.id === selectedId ? "selected" : "";
    const isDownloaded = !!downloadedWebllmModels[m.id];
    li.innerHTML = `
      <span class="model-info">
        <span class="model-name">${m.label}</span>
        <small class="model-meta">${webllmMetaLabel(m)}</small>
      </span>
      <span class="badge ${isDownloaded ? "downloaded" : ""}">${isDownloaded ? "Downloaded" : "Not downloaded"}</span>
    `;
    const actions = document.createElement("span");
    actions.className = "model-actions";
    const btn = document.createElement("button");
    btn.textContent = m.id === loadedModel ? "Loaded" : isDownloaded ? "Load" : "Download";
    btn.disabled = m.id === loadedModel;
    btn.addEventListener("click", async () => {
      await saveSettings({ webllmModel: m.id });
      startWebllmDownload(m.id);
      renderWebllmRegistry(loadedModel);
    });
    actions.appendChild(btn);
    if (isDownloaded) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.className = "danger";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete cached weights for ${m.label}?`)) return;
        delBtn.disabled = true;
        const res = await sendMessage({ type: "webllm.relay", engineType: "engine.deleteModel", model: m.id });
        if (res?.error) {
          delBtn.disabled = false;
          alert(`Delete failed: ${res.error.message}`);
          return;
        }
        const { webllmModels } = await chrome.storage.local.get("webllmModels");
        const next = { ...(webllmModels || {}) };
        delete next[m.id];
        await chrome.storage.local.set({ webllmModels: next });
        downloadedWebllmModels = next;
        await refreshWebllmSettings();
      });
      actions.appendChild(delBtn);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
}

function sizeLabel(mb) {
  if (mb >= 1000) return `~${(mb / 1000).toFixed(1)} GB`;
  return `~${mb} MB`;
}

function formatTokenCount(n) {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function contextEstimateText(est) {
  if (!est) return "Context: checking…";
  if (est.error) return "Context: unknown";
  const trained = formatTokenCount(est.trainedMaxContext);
  if (!trained) return "Context: unknown";
  const memoryBinds =
    est.effectiveMaxContext != null &&
    est.trainedMaxContext != null &&
    est.effectiveMaxContext < est.trainedMaxContext;
  if (memoryBinds) {
    const wasmCap = est.bindingConstraint === "wasm" ? " · WASM 4GB cap" : "";
    return `Context: ${trained} max · ~${formatTokenCount(est.effectiveMaxContext)} usable (est.${wasmCap})`;
  }
  return `Context: ${trained} max`;
}

function contextEstimateTitle(est) {
  if (!est || est.error) return "";
  const parts = [...(est.caveats || [])];
  if (est.deviceMemoryGB != null) {
    parts.push(`Assumes ~${(est.deviceMemoryGB * est.assumedFreeFraction).toFixed(1)}GB free of ${est.deviceMemoryGB}GB reported device memory, running on ${est.device || "unknown device"}.`);
  }
  if (est.wasmMemoryLimitedTokens != null) {
    parts.push(`WASM heap estimate: ~${formatTokenCount(est.wasmMemoryLimitedTokens)} KV tokens after weights + ${est.wasmHeapReserveMB ?? 768}MB runtime reserve.`);
  }
  return parts.join("\n");
}

/** HF Hub pipeline_tag → display label (mirrors engine.PIPELINE_TAG_LABELS). */
const PIPELINE_TAG_LABELS = {
  "text-generation": "Text Generation",
  "image-text-to-text": "Image-Text-to-Text",
  "any-to-any": "Any-to-Any",
  "image-to-text": "Image-to-Text",
  "image-classification": "Image Classification",
  "automatic-speech-recognition": "Automatic Speech Recognition",
};

function pipelineTagLabel(entry) {
  const tag = entry?.pipeline_tag || entry?.task || "text-generation";
  return (
    PIPELINE_TAG_LABELS[tag] ||
    tag.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function modelMetaLabel(entry) {
  if (!entry) return "";
  return `${pipelineTagLabel(entry)} · ${sizeLabel(entry.approxSizeMB)}`;
}

function llmLoadedModel(loadedByTask) {
  return loadedByTask["text-generation"] || loadedByTask["image-text-to-text"] || null;
}

function llmModels() {
  if (settings.provider === "webllm") return webllmRegistry;
  if (settings.provider === "ollama") return ollamaRegistry;
  return registry.filter((m) => m.modality === "llm");
}

function renderRegistrySection(listId, task, settingsKey, loadedModel, { modality } = {}) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = "";
  const models = modality === "llm" ? llmModels() : registry.filter((m) => (m.task || "text-generation") === task);
  const selectedId = settings[settingsKey] || models.find((m) => m.tier === "default")?.id || models[0]?.id;

  for (const m of models) {
    const li = document.createElement("li");
    li.className = m.id === selectedId ? "selected" : "";
    const isDownloaded = !!downloadedModels[m.id];
    li.innerHTML = `
      <span class="model-info">
        <span class="model-name">${m.label}</span>
        <small class="model-meta">${modelMetaLabel(m)}</small>
        ${modality === "llm" ? `<small class="model-context"></small>` : ""}
      </span>
      <span class="badge ${isDownloaded ? "downloaded" : ""}">${isDownloaded ? "Downloaded" : "Not downloaded"}</span>
    `;
    if (modality === "llm") {
      const contextEl = li.querySelector(".model-context");
      const cached = contextEstimateCache.get(m.id);
      contextEl.textContent = contextEstimateText(cached);
      contextEl.title = contextEstimateTitle(cached);
      if (!cached) {
        sendMessage({ type: "onnx.relay", engineType: "engine.contextEstimate", model: m.id })
          .then((est) => {
            if (!est) return;
            contextEstimateCache.set(m.id, est);
            contextEl.textContent = contextEstimateText(est);
            contextEl.title = contextEstimateTitle(est);
          })
          .catch(() => {});
      }
    }
    const actions = document.createElement("span");
    actions.className = "model-actions";
    const btn = document.createElement("button");
    btn.textContent = m.id === loadedModel ? "Loaded" : isDownloaded ? "Load" : "Download";
    btn.disabled = m.id === loadedModel;
    btn.addEventListener("click", async () => {
      await saveSettings({ [settingsKey]: m.id });
      startOnnxDownload(m.id, m.task || "text-generation");
      renderRegistrySection(listId, task, settingsKey, loadedModel, { modality });
    });
    actions.appendChild(btn);
    if (isDownloaded) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.className = "danger";
      delBtn.title = "Delete this model's cached weights from IndexedDB";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete cached weights for ${m.label} (${modelMetaLabel(m)})? You'll need to re-download it to use it again.`)) return;
        delBtn.disabled = true;
        const res = await sendMessage({ type: "onnx.relay", engineType: "engine.deleteModel", model: m.id });
        if (res?.error) {
          delBtn.disabled = false;
          alert(`Delete failed: ${res.error.message}`);
          return;
        }
        const { onnxModels } = await chrome.storage.local.get("onnxModels");
        const next = { ...(onnxModels || {}) };
        delete next[m.id];
        await chrome.storage.local.set({ onnxModels: next });
        downloadedModels = next;
        await refreshOnnxSettings();
      });
      actions.appendChild(delBtn);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
}

function startDownload(modelId, task) {
  const provider = settings.provider || "onnx";
  if (provider === "webllm") startWebllmDownload(modelId);
  else if (provider === "ollama") startOllamaPull(modelId);
  else startOnnxDownload(modelId, task);
}

function startOnnxDownload(modelId, task) {
  $("#onnx-progress-wrap").classList.remove("hidden");
  $("#onnx-progress-label").textContent = `Loading ${modelId}…`;
  const payload = { type: "onnx.relay", engineType: "engine.load", model: modelId };
  if (task) payload.task = task;
  sendMessage(payload)
    .then(async (res) => {
      if (res?.error) {
        $("#onnx-progress-fill").style.width = "0%";
        $("#onnx-progress-label").textContent = `✗ ${res.error.message}`;
      } else {
        $("#onnx-progress-wrap").classList.add("hidden");
      }
      await refreshOnnxSettings();
      renderModelBadge();
    })
    .catch((err) => {
      // e.g. "The message port closed before a response was received" if the
      // background worker died mid-load — the offscreen doc may still finish.
      $("#onnx-progress-fill").style.width = "0%";
      $("#onnx-progress-label").textContent = `✗ ${err.message} — reopen Settings to check if the model finished loading.`;
    });
}

function startWebllmDownload(modelId) {
  $("#webllm-progress-wrap").classList.remove("hidden");
  $("#webllm-progress-label").textContent = `Loading ${modelId}…`;
  sendMessage({ type: "webllm.relay", engineType: "engine.load", model: modelId })
    .then(async (res) => {
      if (res?.error) {
        $("#webllm-progress-fill").style.width = "0%";
        $("#webllm-progress-label").textContent = `✗ ${res.error.message}`;
      } else {
        $("#webllm-progress-wrap").classList.add("hidden");
      }
      await refreshWebllmSettings();
    })
    .catch((err) => {
      $("#webllm-progress-fill").style.width = "0%";
      $("#webllm-progress-label").textContent = `✗ ${err.message}`;
    });
}

function onOnnxProgress(event) {
  const wrap = $("#onnx-progress-wrap");
  wrap.classList.remove("hidden");
  const pct = event.total ? Math.round(((event.loaded || 0) / event.total) * 100) : 0;
  $("#onnx-progress-fill").style.width = `${pct}%`;
  $("#onnx-progress-label").textContent = `${event.status || "downloading"} ${event.file || ""} ${event.total ? pct + "%" : ""}`.trim();
}

function onWebllmProgress(event) {
  const wrap = $("#webllm-progress-wrap");
  wrap.classList.remove("hidden");
  const pct = event.total ? Math.round(((event.loaded || 0) / event.total) * 100) : 0;
  $("#webllm-progress-fill").style.width = `${pct}%`;
  $("#webllm-progress-label").textContent = `${event.status || "downloading"} ${event.file || ""} ${event.total ? pct + "%" : ""}`.trim();
}

async function testConnection() {
  const out = $("#test-connection-result");
  const provider = settings.provider || "onnx";
  out.textContent =
    provider === "nvidia-nim"
      ? "Testing… (GLM and other NIM models can take 60+ seconds)"
      : provider === "gemini"
        ? "Testing…"
        : "Testing…";
  try {
    let res;
    if ((settings.provider || "onnx") === "onnx") {
      if (!settings.onnxModel) throw new Error("Pick a model first");
      res = await sendMessage({
        type: "onnx.relay",
        engineType: "chat.completions",
        request: { model: settings.onnxModel, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 },
      });
    } else if (settings.provider === "webllm") {
      if (!settings.webllmModel) throw new Error("Pick a model first");
      res = await sendMessage({
        type: "webllm.relay",
        engineType: "chat.completions",
        request: { model: settings.webllmModel, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 },
      });
    } else {
      res = await sendMessage({ type: "llm.test" });
    }
    out.textContent = res?.error ? `✗ ${res.error.message}` : "✓ Connected";
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  }
}

function renderModelBadge() {
  const provider = settings.provider || "onnx";
  const model =
    provider === "onnx"
      ? settings.onnxModel
      : provider === "webllm"
        ? settings.webllmModel
        : settings.model;
  const shortModel = (model || "no model").split("/").pop();
  const deviceSuffix =
    (provider === "onnx" || provider === "webllm") && lastKnownDevice ? ` · ${lastKnownDevice}` : "";
  const text = `${provider} · ${shortModel}${deviceSuffix}`;
  document.querySelectorAll(".model-badge").forEach((el) => (el.textContent = text));
}

// --- Agent tab (systems + automation + component editor) --------------------

function wireSystemsUi() {
  $("#system-select").addEventListener("change", async (e) => {
    await saveComponentIfDirty();
    currentSystemId = e.target.value;
    await chrome.storage.local.set({ currentSystemId });
    applyCurrentSystem();
  });
  $("#system-add-btn").addEventListener("click", async () => {
    const name = prompt("Name for the new agent system:", "My system");
    if (name == null) return;
    try {
      await saveComponentIfDirty();
      const system = await createSystem(name);
      currentSystemId = system.id;
      await chrome.storage.local.set({ currentSystemId });
      await refreshSystems();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  $("#system-delete-btn").addEventListener("click", async () => {
    const system = systems.find((s) => s.id === currentSystemId);
    if (!system || system.isBuiltin) {
      alert("Built-in systems cannot be deleted.");
      return;
    }
    if (!confirm(`Delete system "${system.name}"?`)) return;
    try {
      await deleteSystem(currentSystemId);
      currentSystemId = BUILTIN_CURVE_PLOTTER_ID;
      await chrome.storage.local.set({ currentSystemId });
      await refreshSystems();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  $("#system-render-btn").addEventListener("click", () => {
    renderSystemInTab().catch((err) => alert(err.message || String(err)));
  });
}

function formatComponentBytes(n) {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function setComponentMeta(text, isError = false) {
  const el = $("#component-meta");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function setComponentDirty(dirty) {
  componentDirty = dirty;
  $("#component-save-btn").disabled = !dirty || !currentSystemId;
  renderComponentKindTabs();
}

function renderComponentKindTabs() {
  const tabs = $("#component-kind-tabs");
  tabs.innerHTML = "";
  for (const kind of COMPONENT_KINDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `component-kind-tab${kind === activeComponentKind ? " active" : ""}${
      kind === activeComponentKind && componentDirty ? " dirty" : ""
    }`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", kind === activeComponentKind ? "true" : "false");
    const bytes = componentMetaByKind[kind]?.bytes ?? 0;
    btn.innerHTML = `${kind}<span class="bytes">${formatComponentBytes(bytes)}</span>`;
    btn.addEventListener("click", () => selectComponentKind(kind));
    tabs.appendChild(btn);
  }
}

function wireComponentEditor() {
  renderComponentKindTabs();
  $("#component-editor-input").addEventListener("input", () => {
    if (componentLoading) return;
    setComponentDirty($("#component-editor-input").value !== componentBaseline);
  });
  $("#component-save-btn").addEventListener("click", () => {
    saveComponentIfDirty().catch((err) => setComponentMeta(err.message, true));
  });
  $("#component-editor-input").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveComponentIfDirty().catch((err) => setComponentMeta(err.message, true));
    }
  });
}

async function selectComponentKind(kind) {
  if (kind === activeComponentKind) return;
  await saveComponentIfDirty();
  activeComponentKind = kind;
  await loadActiveComponent();
}

async function refreshComponentEditor({ keepDirty = false } = {}) {
  if (!currentSystemId) {
    componentBaseline = "";
    componentDirty = false;
    componentMetaByKind = {};
    const input = $("#component-editor-input");
    componentLoading = true;
    input.value = "";
    input.disabled = true;
    componentLoading = false;
    $("#component-save-btn").disabled = true;
    renderComponentKindTabs();
    setComponentMeta("Select a system");
    return;
  }

  const listed = await listComponents(currentSystemId);
  componentMetaByKind = {};
  for (const c of listed) componentMetaByKind[c.kind] = { bytes: c.bytes, updatedAt: c.updatedAt };

  if (keepDirty && componentDirty) {
    renderComponentKindTabs();
    return;
  }
  await loadActiveComponent();
}

async function loadActiveComponent() {
  if (!currentSystemId) return;
  const input = $("#component-editor-input");
  componentLoading = true;
  try {
    const comp = await getComponent(currentSystemId, activeComponentKind);
    const content = comp?.content || "";
    input.value = content;
    input.disabled = false;
    componentBaseline = content;
    setComponentDirty(false);
    const bytes = (content || "").length;
    componentMetaByKind[activeComponentKind] = {
      bytes,
      updatedAt: comp?.updatedAt,
    };
    renderComponentKindTabs();
    setComponentMeta(
      comp?.updatedAt
        ? `${activeComponentKind} · ${formatComponentBytes(bytes)} · updated ${new Date(comp.updatedAt).toLocaleString()}`
        : `${activeComponentKind} · empty`
    );
  } catch (err) {
    input.disabled = true;
    setComponentMeta(err.message || String(err), true);
  } finally {
    componentLoading = false;
  }
}

async function saveComponentIfDirty() {
  if (!componentDirty || !currentSystemId) return false;
  const content = $("#component-editor-input").value;
  const record = await writeComponent(currentSystemId, activeComponentKind, content);
  componentBaseline = content;
  componentMetaByKind[activeComponentKind] = {
    bytes: content.length,
    updatedAt: record.updatedAt,
  };
  setComponentDirty(false);
  setComponentMeta(
    `${activeComponentKind} · ${formatComponentBytes(content.length)} · saved ${new Date(record.updatedAt).toLocaleString()}`
  );
  chrome.runtime.sendMessage({ type: "system.updated", systemId: currentSystemId, kind: activeComponentKind }).catch(
    () => {}
  );
  return true;
}

function hostUrlForSystem(systemId) {
  return chrome.runtime.getURL(`system-host.html?id=${encodeURIComponent(systemId)}`);
}

async function findHostTabs(systemId) {
  const prefix = hostUrlForSystem(systemId);
  const matches = (tab) => {
    const url = tab.url || tab.pendingUrl || "";
    return url === prefix || url.startsWith(`${prefix}&`) || url.startsWith(`${prefix}#`);
  };
  try {
    const tabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL("system-host.html")}*` });
    const found = tabs.filter(matches);
    if (found.length) return found;
  } catch {
    /* url pattern may be rejected; fall through */
  }
  const all = await chrome.tabs.query({});
  return all.filter(matches);
}

function requestHostReload() {
  if (!currentSystemId) return;
  chrome.runtime.sendMessage({ type: "system.reload", systemId: currentSystemId }).catch(() => {});
}

async function reloadOpenHostTabs() {
  requestHostReload();
}

async function renderSystemInTab() {
  if (!currentSystemId) return;
  await saveComponentIfDirty();
  const url = hostUrlForSystem(currentSystemId);
  const existing = await findHostTabs(currentSystemId);
  if (existing.length) {
    await chrome.tabs.remove(existing.map((tab) => tab.id));
  }
  await chrome.tabs.create({ url });
}

async function refreshSystems() {
  await ensureSeeded();
  systems = await listSystems();
  const { currentSystemId: stored } = await chrome.storage.local.get("currentSystemId");
  currentSystemId =
    stored && systems.some((s) => s.id === stored)
      ? stored
      : systems.find((s) => s.id === BUILTIN_CURVE_PLOTTER_ID)?.id || systems[0]?.id || null;

  const select = $("#system-select");
  select.innerHTML = "";
  for (const s of systems) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.isBuiltin ? `${s.name}` : s.name;
    select.appendChild(opt);
  }
  if (currentSystemId) select.value = currentSystemId;
  applyCurrentSystem();
}

function applyCurrentSystem() {
  const system = systems.find((s) => s.id === currentSystemId);
  const isBrowser = currentSystemId === BUILTIN_BROWSER_AGENT_ID;
  $("#browser-agent-run").classList.toggle("hidden", !isBrowser);
  $("#system-delete-btn").disabled = !system || !!system.isBuiltin;

  $("#system-render-btn").disabled = !currentSystemId;
  refreshComponentEditor().catch((err) => setComponentMeta(err.message, true));
  refreshHistory();
}

function wireAgentForm() {
  $("#agent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const task = $("#task-input").value.trim();
    if (!task || running || editing) return;
    runAgentTask(task);
  });
}

function wireEditorForm() {
  $("#editor-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const task = $("#editor-input").value.trim();
    if (!task || editing || running || !currentSystemId) return;
    runEditorTask(task);
  });
}

function runAgentTask(task) {
  running = true;
  $("#run-btn").disabled = true;
  $("#editor-run-btn").disabled = true;
  const trace = $("#trace");
  trace.innerHTML = "";
  addTraceEvent("event", `Automation: ${task}`);

  agentPort = chrome.runtime.connect({ name: "agent" });
  agentPort.onMessage.addListener((event) => {
    if (event.type === "thinking") addTraceEvent("thinking", event.content);
    else if (event.type === "tool_start") addTraceEvent("tool", `→ ${event.tool}(${JSON.stringify(event.args)})`);
    else if (event.type === "tool_end") addTraceEvent("tool", `← ${event.tool}: ${truncateForDisplay(event.result)}`);
    else if (event.type === "final") addTraceEvent("final", event.content);
    else if (event.type === "error") {
      addTraceEvent("error", event.message);
      finishRun();
    } else if (event.type === "done") {
      finishRun();
    }
  });
  agentPort.postMessage({ type: "run", task });
}

function runEditorTask(task) {
  editing = true;
  $("#editor-run-btn").disabled = true;
  $("#run-btn").disabled = true;
  const trace = $("#trace");
  trace.innerHTML = "";
  addTraceEvent("event", `Edit system: ${task}`);

  editorPort = chrome.runtime.connect({ name: "system-editor" });
  editorPort.onMessage.addListener((event) => {
    if (event.type === "thinking") addTraceEvent("thinking", event.content);
    else if (event.type === "tool_start") addTraceEvent("tool", `→ ${event.tool}(${JSON.stringify(event.args)})`);
    else if (event.type === "tool_end") addTraceEvent("tool", `← ${event.tool}: ${truncateForDisplay(event.result)}`);
    else if (event.type === "final") addTraceEvent("final", event.content);
    else if (event.type === "error") {
      addTraceEvent("error", event.message);
      finishEdit();
    } else if (event.type === "done") {
      finishEdit();
      refreshComponentEditor().catch((err) => setComponentMeta(err.message, true));
      reloadOpenHostTabs().catch(() => {});
    }
  });
  editorPort.postMessage({ type: "run", task, systemId: currentSystemId });
}

function finishRun() {
  running = false;
  $("#run-btn").disabled = false;
  $("#editor-run-btn").disabled = editing;
  agentPort?.disconnect();
  agentPort = null;
}

function finishEdit() {
  editing = false;
  $("#editor-run-btn").disabled = false;
  $("#run-btn").disabled = running;
  editorPort?.disconnect();
  editorPort = null;
}

function addTraceEvent(cls, text) {
  const div = document.createElement("div");
  div.className = `event ${cls}`;
  div.textContent = text;
  $("#trace").appendChild(div);
  $("#trace").scrollTop = $("#trace").scrollHeight;
}

function truncateForDisplay(value) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > 400 ? str.slice(0, 400) + "…" : str;
}

// --- Conversation history (per-system LLM transcripts) ----------------------

function wireHistory() {
  $("#history-clear-btn").addEventListener("click", async () => {
    if (!currentSystemId) return;
    const system = systems.find((s) => s.id === currentSystemId);
    if (!confirm(`Delete all stored conversations for "${system?.name || "this system"}"?`)) return;
    await clearConversations(currentSystemId);
    await refreshHistory();
  });
  $("#history-modal-close-btn").addEventListener("click", closeTranscript);
  $("#history-modal").addEventListener("click", (e) => {
    if (e.target.id === "history-modal") closeTranscript();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#history-modal").classList.contains("hidden")) closeTranscript();
  });
}

async function refreshHistory() {
  const list = $("#history-list");
  if (!list || !currentSystemId) return;
  const items = await listConversations(currentSystemId);
  list.innerHTML = "";
  $("#history-clear-btn").disabled = items.length === 0;

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No runs stored yet. Automation and editor runs are saved here.";
    list.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "history-item";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "history-item-main";
    const tag =
      item.source === "automation" ? "Automation" : item.kinds?.length ? `Edit · ${item.kinds.join(", ")}` : "Edit";
    main.innerHTML = `
      <span class="history-item-task">${escapeHtml(item.task || "(no task)")}</span>
      <span class="history-item-meta">${tag} · ${formatTime(item.createdAt)} · ${item.messageCount} msgs</span>
    `;
    main.addEventListener("click", () => openTranscript(item.id));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-item-del icon-btn";
    del.title = "Delete this run";
    del.textContent = "🗑";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteConversation(item.id);
      await refreshHistory();
    });

    row.appendChild(main);
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function openTranscript(id) {
  const conv = await getConversation(id);
  if (!conv) return;
  const body = $("#history-modal-body");
  body.innerHTML = "";
  $("#history-modal-title").textContent = conv.task ? truncateForDisplay(conv.task) : "Transcript";

  for (const m of conv.messages || []) {
    const block = document.createElement("div");
    block.className = `transcript-msg role-${m.role || "unknown"}`;
    const label = document.createElement("div");
    label.className = "transcript-role";
    label.textContent = m.role || "unknown";
    const content = document.createElement("pre");
    content.className = "transcript-content";
    content.textContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2);
    block.appendChild(label);
    block.appendChild(content);
    body.appendChild(block);
  }

  $("#history-modal").classList.remove("hidden");
}

function closeTranscript() {
  $("#history-modal").classList.add("hidden");
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

