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
import { DEFAULT_MAX_STEPS } from "./agent-config.js";

const $ = (sel) => document.querySelector(sel);

let settings = {};
let registry = [];
let downloadedModels = {};
let agentPort = null;
let editorPort = null;
let running = false;
let editing = false;
let lastKnownDevice = null;
let dialogueSystemPrompt = "";
let dialogueTurns = []; // {role: "user"|"assistant", content, images?: dataUrl[], raw?: {request, response}}
let dialogueImages = []; // pending image attachments (data URLs) for the next message
let dialogueSending = false;
let systems = [];
let currentSystemId = null;

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
  wireDialogue();
  wireHistory();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "onnx-progress") onProgress(msg);
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
      if (btn.dataset.tab === "dialogue") refreshDialogueModelSelect();
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
    startDownload("onnx-community/Qwen2.5-1.5B-Instruct", "text-generation");
  });
  $("#ob-ollama").addEventListener("click", async () => {
    await saveSettings({ provider: "ollama", baseUrl: "http://localhost:11434", model: "llama3.2" });
    $("#onboarding").classList.add("hidden");
    applySettingsToForm();
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
    const res = await fetch("http://localhost:11434/api/tags", { signal: ctrl.signal });
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
  label.textContent = "Not detected — install from ollama.com and pull a model first.";
}

// --- Settings ---------------------------------------------------------------

function wireSettingsForm() {
  $("#provider-select").addEventListener("change", async (e) => {
    await saveSettings({ provider: e.target.value });
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
  $("#test-connection-btn").addEventListener("click", testConnection);
}

function applySettingsToForm() {
  $("#provider-select").value = settings.provider || "onnx";
  $("#base-url").value = settings.baseUrl || "";
  $("#api-key").value = settings.apiKey || "";
  $("#model-name").value = settings.model || "";
  $("#max-steps-input").value = settings.maxSteps || DEFAULT_MAX_STEPS;

  const isOnnx = (settings.provider || "onnx") === "onnx";
  $("#onnx-settings").classList.toggle("hidden", !isOnnx);
  $("#remote-settings").classList.toggle("hidden", isOnnx);
  if (isOnnx) refreshOnnxSettings();
  renderModelBadge();
  refreshDialogueModelSelect();
}

async function saveSettings(patch) {
  settings = await sendMessage({ type: "settings.set", patch });
  renderModelBadge();
  refreshDialogueModelSelect();
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
  refreshDialogueModelSelect();
}

function sizeLabel(mb) {
  if (mb >= 1000) return `~${(mb / 1000).toFixed(1)} GB`;
  return `~${mb} MB`;
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
      </span>
      <span class="badge ${isDownloaded ? "downloaded" : ""}">${isDownloaded ? "Downloaded" : "Not downloaded"}</span>
    `;
    const actions = document.createElement("span");
    actions.className = "model-actions";
    const btn = document.createElement("button");
    btn.textContent = m.id === loadedModel ? "Loaded" : isDownloaded ? "Load" : "Download";
    btn.disabled = m.id === loadedModel;
    btn.addEventListener("click", async () => {
      await saveSettings({ [settingsKey]: m.id });
      startDownload(m.id, m.task || "text-generation");
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

function onProgress(event) {
  const wrap = $("#onnx-progress-wrap");
  wrap.classList.remove("hidden");
  const pct = event.total ? Math.round(((event.loaded || 0) / event.total) * 100) : 0;
  $("#onnx-progress-fill").style.width = `${pct}%`;
  $("#onnx-progress-label").textContent = `${event.status || "downloading"} ${event.file || ""} ${event.total ? pct + "%" : ""}`.trim();
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
  const model = provider === "onnx" ? settings.onnxModel : settings.model;
  const shortModel = (model || "no model").split("/").pop();
  const deviceSuffix = provider === "onnx" && lastKnownDevice ? ` · ${lastKnownDevice}` : "";
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

// --- Dialogue (raw LLM I/O, back-and-forth chat with expandable raw panel) -

function wireDialogue() {
  $("#dialogue-system-toggle").addEventListener("click", () => {
    $("#dialogue-system-wrap").classList.toggle("hidden");
  });
  $("#dialogue-system-input").addEventListener("input", (e) => {
    dialogueSystemPrompt = e.target.value;
  });
  $("#dialogue-model-select").addEventListener("change", async (e) => {
    await onDialogueModelChange(e);
    updateDialogueAttachUI();
  });
  $("#dialogue-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendDialogue();
  });
  // Enter sends; Shift+Enter inserts a newline. Skip while composing (IME).
  $("#dialogue-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendDialogue();
    }
  });
  $("#dialogue-attach-btn").addEventListener("click", () => $("#dialogue-image-input").click());
  $("#dialogue-image-input").addEventListener("change", async (e) => {
    await addDialogueImages(e.target.files);
    e.target.value = ""; // allow re-picking the same file
  });
  renderDialogue();
  refreshDialogueModelSelect();
}

async function listOllamaModels() {
  const base = (settings.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const body = await res.json();
    return (body.models || []).map((m) => ({ id: m.name, label: m.name }));
  } catch {
    return [];
  }
}

async function refreshDialogueModelSelect() {
  const select = $("#dialogue-model-select");
  if (!select) return;

  const provider = settings.provider || "onnx";
  let options = [];
  let selected = "";

  if (provider === "onnx") {
    if (registry.length === 0) {
      try {
        const modelsRes = await sendMessage({ type: "onnx.relay", engineType: "engine.models" });
        if (modelsRes?.models?.length) registry = modelsRes.models;
      } catch {
        // engine may not be started yet
      }
    }
    options = llmModels().map((m) => ({ id: m.id, label: `${m.label} (${modelMetaLabel(m)})` }));
    selected =
      settings.onnxModel ||
      llmModels().find((m) => m.tier === "default")?.id ||
      options[0]?.id ||
      "";
  } else if (provider === "ollama") {
    options = await listOllamaModels();
    selected = settings.model || options[0]?.id || "";
  } else {
    const m = settings.model || "";
    if (m) options = [{ id: m, label: m }];
    selected = m;
  }

  const prev = select.value;
  select.innerHTML = "";

  if (options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent =
      provider === "onnx"
        ? "No models — open Settings"
        : provider === "ollama"
          ? "No Ollama models found"
          : "Set model in Settings";
    select.appendChild(opt);
    select.disabled = true;
    updateDialogueAttachUI();
    return;
  }

  select.disabled = provider !== "onnx" && provider !== "ollama";
  if (!options.some((o) => o.id === selected) && selected) {
    options = [{ id: selected, label: selected.split("/").pop() }, ...options];
  }
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = selected || options[0].id;
  // Avoid clobbering a mid-change selection if the list rebuild races
  if (prev && options.some((o) => o.id === prev) && document.activeElement === select) {
    select.value = prev;
  }
  updateDialogueAttachUI();
}

async function onDialogueModelChange(e) {
  const select = e.target;
  const modelId = select.value;
  if (!modelId) return;
  const provider = settings.provider || "onnx";
  const previous = provider === "onnx" ? settings.onnxModel || "" : settings.model || "";

  if (provider === "onnx") {
    if (!downloadedModels[modelId]) {
      if (!confirmOnnxDownload(modelId)) {
        select.value = previous;
        return;
      }
    }
    await saveSettings({ onnxModel: modelId });
    const entry = llmModels().find((m) => m.id === modelId);
    startDownload(modelId, entry?.task || "text-generation");
  } else {
    await saveSettings({ model: modelId });
    const modelInput = $("#model-name");
    if (modelInput) modelInput.value = modelId;
  }
}

/** Ask before fetching weights that are not yet in IndexedDB. */
function confirmOnnxDownload(modelId) {
  const entry = registry.find((m) => m.id === modelId);
  const label = entry?.label || modelId.split("/").pop();
  const meta = entry ? modelMetaLabel(entry) : "unknown size";
  return confirm(
    `"${label}" is not downloaded yet (${meta}).\n\nDownload it now? This uses the network and may take a few minutes.`
  );
}

/** Whether the current dialogue model can take image input. */
function dialogueModelSupportsImages() {
  const provider = settings.provider || "onnx";
  if (provider === "onnx") {
    const modelId = $("#dialogue-model-select")?.value || settings.onnxModel || "";
    return registry.find((m) => m.id === modelId)?.task === "image-text-to-text";
  }
  // OpenAI-shaped providers pass content parts through untouched; the
  // Anthropic converter doesn't translate image parts, so hide there.
  return provider !== "anthropic";
}

function updateDialogueAttachUI() {
  const btn = $("#dialogue-attach-btn");
  if (!btn) return;
  const supported = dialogueModelSupportsImages();
  btn.classList.toggle("hidden", !supported);
  if (!supported && dialogueImages.length > 0) {
    dialogueImages = [];
    renderDialogueAttachments();
  }
}

async function addDialogueImages(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
  for (const file of files) {
    dialogueImages.push(await fileToDataUrl(file));
  }
  renderDialogueAttachments();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderDialogueAttachments() {
  const wrap = $("#dialogue-attachments");
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", dialogueImages.length === 0);
  dialogueImages.forEach((url, i) => {
    const item = document.createElement("div");
    item.className = "dialogue-attachment";
    const img = document.createElement("img");
    img.src = url;
    img.alt = `attachment ${i + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.title = "Remove image";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      dialogueImages.splice(i, 1);
      renderDialogueAttachments();
    });
    item.appendChild(img);
    item.appendChild(remove);
    wrap.appendChild(item);
  });
}

/** OpenAI-shaped message for a stored turn (image parts + text part, or plain string). */
function turnToMessage(t) {
  if (!t.images?.length) return { role: t.role, content: t.content };
  return {
    role: t.role,
    content: [
      ...t.images.map((url) => ({ type: "image_url", image_url: { url } })),
      ...(t.content ? [{ type: "text", text: t.content }] : []),
    ],
  };
}

function renderDialogue() {
  const chat = $("#dialogue-chat");
  chat.innerHTML = "";
  for (const turn of dialogueTurns) {
    const bubble = document.createElement("div");
    bubble.className = `dialogue-bubble ${turn.role}`;
    if (turn.images?.length) {
      const imgs = document.createElement("div");
      imgs.className = "dialogue-bubble-images";
      for (const url of turn.images) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "attached image";
        imgs.appendChild(img);
      }
      bubble.appendChild(imgs);
    }
    if (turn.content) {
      const text = document.createElement("div");
      text.textContent = turn.content;
      bubble.appendChild(text);
    }

    if (turn.raw) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "dialogue-raw-toggle";
      toggle.textContent = "Show raw";
      const panel = document.createElement("pre");
      panel.className = "dialogue-raw-panel hidden";
      panel.textContent = JSON.stringify(turn.raw, null, 2);
      toggle.addEventListener("click", () => {
        panel.classList.toggle("hidden");
        toggle.textContent = panel.classList.contains("hidden") ? "Show raw" : "Hide raw";
      });
      bubble.appendChild(toggle);
      bubble.appendChild(panel);
    }

    chat.appendChild(bubble);
  }
  chat.scrollTop = chat.scrollHeight;
}

async function sendDialogue() {
  if (dialogueSending) return;
  const input = $("#dialogue-input");
  const text = input.value.trim();
  const images = dialogueImages.slice();
  if (!text && images.length === 0) return;

  const provider = settings.provider || "onnx";
  if (provider === "onnx" && settings.onnxModel && !downloadedModels[settings.onnxModel]) {
    if (!confirmOnnxDownload(settings.onnxModel)) return;
  }

  const userTurn = { role: "user", content: text, images };
  const requestMessages = [
    ...(dialogueSystemPrompt.trim() ? [{ role: "system", content: dialogueSystemPrompt }] : []),
    ...dialogueTurns.map(turnToMessage),
    turnToMessage(userTurn),
  ];

  userTurn.raw = { request: requestMessages };
  dialogueTurns.push(userTurn);
  input.value = "";
  dialogueImages = [];
  renderDialogueAttachments();
  renderDialogue();

  dialogueSending = true;
  const btn = $("#dialogue-send-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    const res = await sendMessage({ type: "dialogue.send", messages: requestMessages });
    const replyText = res?.choices?.[0]?.message?.content ?? (res?.error ? `✗ ${res.error.message}` : "(empty response)");
    dialogueTurns.push({ role: "assistant", content: replyText, raw: { response: res } });
  } catch (err) {
    dialogueTurns.push({ role: "assistant", content: `✗ ${err.message}` });
  } finally {
    renderDialogue();
    dialogueSending = false;
    btn.disabled = false;
    btn.textContent = "Send";
  }
}

