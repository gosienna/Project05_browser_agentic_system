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
  getConversation,
  getEditableKinds,
  listConversations,
  listSystems,
  updateSystemEditorConfig,
} from "./system-store.js";
import { L1_DEFAULT_PERSONA, L1_PROTOCOL } from "./l1-prompt.js";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, getMaxTokens } from "./agent-config.js";
import { createDialoguePanel } from "./dialogue/index.js";
import {
  deleteOllamaModel,
  fetchOllamaCatalog,
  formatOllamaCatalogMeta,
  getInstalledVariants,
  isOllamaModelInstalled,
  listOllamaInstalled,
  ollamaInstalledDownloadMap,
  pullOllamaModel,
} from "./ollama-models.js";
import { formatWebllmPickerLabel, formatWebllmRegistryMeta } from "./webllm-models.js";

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
/** @type {Map<string, object>} client-side cache of engine.contextEstimate results, keyed by model id. */
const contextEstimateCache = new Map();

init();

async function init() {
  settings = await sendMessage({ type: "settings.get" });
  wireTabs();
  wireOnboarding();
  wireSettingsForm();
  wireSettingsModal();
  wireAgentForm();
  wireEditorForm();
  wireSystemsUi();
  wireL1Config();
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
      reloadHomeFrame();
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

function sendMessage(msg) {
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
}

function openSettingsModal() {
  $("#settings-modal").classList.remove("hidden");
  if (settings.provider === "onnx") refreshOnnxSettings();
  if (settings.provider === "webllm") refreshWebllmSettings();
  if (settings.provider === "ollama") refreshOllamaSettings();
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
    await saveSettings({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3.2" });
    $("#onboarding").classList.add("hidden");
    openSettingsModal();
    await refreshOllamaSettings();
  });
  $("#ob-api").addEventListener("click", async () => {
    await saveSettings({ provider: "openai" });
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
    await saveSettings({ provider: next });
    if (prev === "onnx" && next !== "onnx") {
      await sendMessage({ type: "onnx.relay", engineType: "engine.unloadLlm" });
    }
    if (prev === "webllm" && next !== "webllm") {
      await sendMessage({ type: "webllm.relay", engineType: "engine.unload" });
    }
    applySettingsToForm();
  });
  $("#base-url").addEventListener("change", (e) => saveSettings({ baseUrl: e.target.value }));
  $("#api-key").addEventListener("change", (e) => saveSettings({ apiKey: e.target.value }));
  $("#model-name").addEventListener("change", (e) => saveSettings({ model: e.target.value }));
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
  $("#enable-thinking-input")?.addEventListener("change", (e) => {
    saveSettings({ enableThinking: e.target.checked });
  });
  $("#tavily-api-key").addEventListener("change", (e) => saveSettings({ tavilyApiKey: e.target.value.trim() }));
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

function applySettingsToForm() {
  $("#provider-select").value = settings.provider || "onnx";
  $("#base-url").value = settings.baseUrl || "";
  $("#api-key").value = settings.apiKey || "";
  $("#model-name").value = settings.model || "";
  $("#max-steps-input").value = settings.maxSteps || DEFAULT_MAX_STEPS;
  $("#max-tokens-input").value = getMaxTokens(settings);
  const thinkingCb = $("#enable-thinking-input");
  if (thinkingCb) thinkingCb.checked = settings.enableThinking !== false;
  $("#tavily-api-key").value = settings.tavilyApiKey || "";
  const webSearchCb = $("#dialogue-web-search-enabled");
  if (webSearchCb) webSearchCb.checked = settings.dialogueWebSearch !== false;
  const browserToolsCb = $("#dialogue-browser-tools-enabled");
  if (browserToolsCb) browserToolsCb.checked = settings.dialogueBrowserTools !== false;

  const provider = settings.provider || "onnx";
  const isOnnx = provider === "onnx";
  const isWebllm = provider === "webllm";
  const isOllama = provider === "ollama";
  const isLocalEngine = isOnnx || isWebllm;
  $("#onnx-settings").classList.toggle("hidden", !isOnnx);
  $("#webllm-settings").classList.toggle("hidden", !isWebllm);
  $("#ollama-settings").classList.toggle("hidden", !isOllama);
  $("#remote-settings").classList.toggle("hidden", isLocalEngine || isOllama);
  if (isOnnx) refreshOnnxSettings();
  if (isWebllm) refreshWebllmSettings();
  if (isOllama) {
    const baseInput = $("#ollama-base-url");
    if (baseInput) baseInput.value = settings.baseUrl || "http://127.0.0.1:11434";
    refreshOllamaSettings();
  }
  const noteEl = $("#remote-context-note");
  if (noteEl) {
    noteEl.textContent = isLocalEngine || isOllama
      ? ""
      : "Context-length estimate not available for remote providers — check the provider's docs for this model's context window.";
  }
  renderModelBadge();
  dialoguePanel?.onSettingsChanged();
}

function ollamaBaseUrl() {
  return (settings.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
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

async function refreshOllamaSettings() {
  const base = ollamaBaseUrl();
  const statusEl = $("#ollama-server-status");
  const hintEl = $("#ollama-cache-hint");
  const searchInput = $("#ollama-catalog-search");
  const filterSelect = $("#ollama-catalog-filter");

  if (searchInput && searchInput.value !== ollamaCatalogSearch) searchInput.value = ollamaCatalogSearch;
  if (filterSelect && filterSelect.value !== ollamaCatalogFilter) filterSelect.value = ollamaCatalogFilter;

  const { installed, reachable, error } = await listOllamaInstalled(base);
  ollamaInstalled = installed;

  if (statusEl) {
    if (!reachable) {
      statusEl.textContent = `Server: not reachable — is Ollama running at ${base}?`;
    } else if (error) {
      statusEl.textContent = `Server: reachable but ${error}`;
    } else {
      const n = installed.size;
      statusEl.textContent = n ? `Server: connected ✓ — ${n} model(s) pulled` : "Server: connected ✓ — no models pulled yet";
    }
  }
  if (hintEl) {
    hintEl.textContent = installed.size
      ? `Active model: ${settings.model || "(none selected)"}`
      : "Pull a model below to use Ollama with this extension.";
  }

  if (ollamaRegistry.length === 0 && ollamaCatalogSkip === 0) {
    await reloadOllamaCatalog();
  } else {
    renderOllamaRegistry();
  }
  dialoguePanel?.onSettingsChanged();
}

function buildOllamaRegistryRows() {
  const rows = [...ollamaRegistry];
  const seenBases = new Set(rows.map((r) => r.id));
  for (const name of ollamaInstalled) {
    const base = name.split(":")[0];
    if (!seenBases.has(base) && !seenBases.has(name)) {
      rows.push({
        id: name,
        label: name,
        description: "Installed locally (not in catalog)",
        labels: [],
        installedOnly: true,
      });
      seenBases.add(name);
    }
  }
  return rows;
}

function renderOllamaRegistry() {
  const list = $("#ollama-registry");
  if (!list) return;
  list.innerHTML = "";
  const rows = buildOllamaRegistryRows();
  const selectedId = settings.model || rows.find((m) => m.tier === "default")?.id || "";

  for (const m of rows) {
    const li = document.createElement("li");
    const installed = isOllamaModelInstalled(ollamaInstalled, m.id);
    const isSelected = installed && (m.id === selectedId || getInstalledVariants(ollamaInstalled, m.id).includes(selectedId));
    li.className = isSelected || m.id === selectedId ? "selected" : "";

    li.innerHTML = `
      <span class="model-info">
        <span class="model-name">${escapeHtml(m.label || m.id)}</span>
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
      btn.textContent = m.id === selectedId ? "Selected" : "Use";
      btn.disabled = m.id === selectedId;
      btn.addEventListener("click", async () => {
        const pick = getInstalledVariants(ollamaInstalled, m.id)[0] || m.id;
        await saveSettings({ model: pick });
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
  ollamaPulling = true;
  ollamaPullAbort?.abort();
  ollamaPullAbort = new AbortController();
  const wrap = $("#ollama-progress-wrap");
  wrap?.classList.remove("hidden");
  $("#ollama-progress-fill").style.width = "0%";
  $("#ollama-progress-label").textContent = `Pulling ${modelId}…`;
  renderOllamaRegistry();

  try {
    await pullOllamaModel(ollamaBaseUrl(), modelId, {
      signal: ollamaPullAbort.signal,
      onProgress: onOllamaProgress,
    });
    const variants = getInstalledVariants(
      (await listOllamaInstalled(ollamaBaseUrl())).installed,
      modelId
    );
    await saveSettings({ model: variants[0] || modelId });
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
  out.textContent = "Testing…";
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
    currentSystemId = e.target.value;
    await chrome.storage.local.set({ currentSystemId });
    applyCurrentSystem();
  });
  $("#system-add-btn").addEventListener("click", async () => {
    const name = prompt("Name for the new agent system:", "My system");
    if (name == null) return;
    // The access level is fixed at creation and cannot be changed later.
    const levelAnswer = prompt(
      "Editor access level for this system (cannot be changed later):\n1 = restricted to chosen scripts\n2 = full system",
      "2"
    );
    if (levelAnswer == null) return;
    const level = Number(levelAnswer.trim()) === 1 ? 1 : 2;
    // Level 1 starts scoped to "ui" only; use the "⚙ Level 1 access" panel
    // afterwards to grant more scripts or set a custom persona prompt.
    try {
      const system = await createSystem(name, { level, editableKinds: ["ui"] });
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
}

function wireL1Config() {
  const checksEl = $("#l1-kind-checks");
  checksEl.innerHTML = "";
  for (const kind of COMPONENT_KINDS) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "l1-kind-check";
    cb.value = kind;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${kind}`));
    checksEl.appendChild(label);
  }
  $("#l1-config-toggle").addEventListener("click", () => {
    $("#l1-config-wrap").classList.toggle("hidden");
  });
  $("#l1-prompt-input").addEventListener("input", renderL1PromptPreview);
  renderL1PromptPreview();
  $("#l1-config-save-btn").addEventListener("click", async () => {
    if (!currentSystemId) return;
    const editableKinds = Array.from(document.querySelectorAll(".l1-kind-check"))
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);
    if (editableKinds.length === 0) {
      alert("Select at least one component.");
      return;
    }
    const systemPrompt = $("#l1-prompt-input").value;
    try {
      await updateSystemEditorConfig(currentSystemId, { editableKinds, systemPrompt });
      await refreshSystems();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  $("#l1-config-reset-btn").addEventListener("click", async () => {
    if (!currentSystemId) return;
    $("#l1-prompt-input").value = "";
    try {
      await updateSystemEditorConfig(currentSystemId, { systemPrompt: "" });
      await refreshSystems();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
}

function renderL1PromptPreview() {
  const persona = $("#l1-prompt-input").value.trim() || L1_DEFAULT_PERSONA;
  $("#l1-prompt-preview").innerHTML =
    `${escapeHtml(persona)}\n\n` +
    `<span class="l1-prompt-fixed">— always appended, not editable —\n${escapeHtml(L1_PROTOCOL)}</span>`;
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
  $("#editor-level-badge").textContent = !system
    ? ""
    : system.level === 1
      ? `Level 1 — LLM may edit: ${getEditableKinds(system).join(", ")}`
      : "Level 2 — LLM has full control over all components";

  $("#l1-config").classList.toggle("hidden", !system || system.level !== 1);
  if (system && system.level === 1) {
    const kinds = getEditableKinds(system);
    document.querySelectorAll(".l1-kind-check").forEach((cb) => {
      cb.checked = kinds.includes(cb.value);
    });
    $("#l1-prompt-input").value = system.systemPrompt || "";
    renderL1PromptPreview();
  }

  const open = $("#system-open-link");
  const compsLink = $("#system-components-link");
  if (currentSystemId) {
    const url = chrome.runtime.getURL(`system-host.html?id=${encodeURIComponent(currentSystemId)}`);
    open.href = url;
    open.classList.remove("hidden");
    compsLink.href = chrome.runtime.getURL(`system-components.html?id=${encodeURIComponent(currentSystemId)}`);
    compsLink.classList.remove("hidden");
  } else {
    open.removeAttribute("href");
    open.classList.add("hidden");
    compsLink.removeAttribute("href");
    compsLink.classList.add("hidden");
  }
  reloadHomeFrame();
  refreshHistory();
}

function reloadHomeFrame() {
  const frame = $("#system-home-frame");
  if (!currentSystemId) {
    frame.removeAttribute("src");
    return;
  }
  const url = chrome.runtime.getURL(`system-host.html?id=${encodeURIComponent(currentSystemId)}`);
  // Bust cache so component edits show up immediately
  frame.src = `${url}&t=${Date.now()}`;
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
  const system = systems.find((s) => s.id === currentSystemId);
  const trace = $("#trace");
  trace.innerHTML = "";
  addTraceEvent(
    "event",
    system?.level === 1
      ? `Edit [${getEditableKinds(system).join(", ")}] (level 1): ${task}`
      : `Edit system (level 2): ${task}`
  );

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
      reloadHomeFrame();
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

