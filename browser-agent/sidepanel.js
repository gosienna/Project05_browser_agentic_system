// Side panel UI: Agent chat, Trackers, Settings (incl. the ONNX model picker).

const $ = (sel) => document.querySelector(sel);

let settings = {};
let registry = [];
let downloadedModels = {};
let agentPort = null;
let running = false;
let lastKnownDevice = null;
let dialogueSystemPrompt = "";
let dialogueTurns = []; // {role: "user"|"assistant", content, raw?: {request, response}}
let dialogueSending = false;

init();

async function init() {
  settings = await sendMessage({ type: "settings.get" });
  wireTabs();
  wireOnboarding();
  wireSettingsForm();
  wireSettingsModal();
  wireAgentForm();
  wireTrackers();
  wireDialogue();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "onnx-progress") onProgress(msg);
  });

  if (!settings || Object.keys(settings).length === 0) {
    $("#onboarding").classList.remove("hidden");
    probeOllama();
  } else {
    applySettingsToForm();
  }

  renderModelBadge();
  refreshTrackerList();
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

  const loadedByTask = {};
  for (const entry of statusRes?.loaded || []) {
    loadedByTask[entry.task] = entry.model;
  }
  // Back-compat if older engine only returns loadedModel
  if (!loadedByTask["text-generation"] && statusRes?.loadedModel) {
    loadedByTask["text-generation"] = statusRes.loadedModel;
  }

  renderRegistrySection("onnx-registry", "text-generation", "onnxModel", loadedByTask["text-generation"]);
  renderRegistrySection("onnx-registry-caption", "image-to-text", "onnxCaptionModel", loadedByTask["image-to-text"]);
  renderRegistrySection("onnx-registry-classify", "image-classification", "onnxClassifyModel", loadedByTask["image-classification"]);
  renderRegistrySection("onnx-registry-asr", "automatic-speech-recognition", "onnxAsrModel", loadedByTask["automatic-speech-recognition"]);
  refreshDialogueModelSelect();
}

function sizeLabel(mb) {
  if (mb >= 1000) return `~${(mb / 1000).toFixed(1)} GB`;
  return `~${mb} MB`;
}

function renderRegistrySection(listId, task, settingsKey, loadedModel) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = "";
  const models = registry.filter((m) => (m.task || "text-generation") === task);
  const selectedId = settings[settingsKey] || models.find((m) => m.tier === "default")?.id || models[0]?.id;

  for (const m of models) {
    const li = document.createElement("li");
    li.className = m.id === selectedId ? "selected" : "";
    const isDownloaded = !!downloadedModels[m.id];
    li.innerHTML = `
      <span>${m.label} <small>(${sizeLabel(m.approxSizeMB)})</small></span>
      <span class="badge ${isDownloaded ? "downloaded" : ""}">${isDownloaded ? "Downloaded" : "Not downloaded"}</span>
    `;
    const btn = document.createElement("button");
    btn.textContent = m.id === loadedModel ? "Loaded" : isDownloaded ? "Load" : "Download";
    btn.disabled = m.id === loadedModel;
    btn.addEventListener("click", async () => {
      await saveSettings({ [settingsKey]: m.id });
      startDownload(m.id, task);
      renderRegistrySection(listId, task, settingsKey, loadedModel);
    });
    li.appendChild(btn);
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

// --- Agent tab --------------------------------------------------------------

function wireAgentForm() {
  $("#agent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const task = $("#task-input").value.trim();
    if (!task || running) return;
    runAgentTask(task);
  });
}

function runAgentTask(task) {
  running = true;
  $("#run-btn").disabled = true;
  const trace = $("#trace");
  trace.innerHTML = "";
  addTraceEvent("event", `Task: ${task}`);

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

function finishRun() {
  running = false;
  $("#run-btn").disabled = false;
  agentPort?.disconnect();
  agentPort = null;
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

// --- Dialogue (raw LLM I/O, back-and-forth chat with expandable raw panel) -

function wireDialogue() {
  $("#dialogue-system-toggle").addEventListener("click", () => {
    $("#dialogue-system-wrap").classList.toggle("hidden");
  });
  $("#dialogue-system-input").addEventListener("input", (e) => {
    dialogueSystemPrompt = e.target.value;
  });
  $("#dialogue-model-select").addEventListener("change", onDialogueModelChange);
  $("#dialogue-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendDialogue();
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
    options = registry
      .filter((m) => (m.task || "text-generation") === "text-generation")
      .map((m) => ({ id: m.id, label: `${m.label} (${sizeLabel(m.approxSizeMB)})` }));
    selected =
      settings.onnxModel ||
      registry.find((m) => (m.task || "text-generation") === "text-generation" && m.tier === "default")?.id ||
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
    startDownload(modelId, "text-generation");
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
  const size = entry ? sizeLabel(entry.approxSizeMB) : "unknown size";
  return confirm(
    `"${label}" is not downloaded yet (${size}).\n\nDownload it now? This uses the network and may take a few minutes.`
  );
}

function renderDialogue() {
  const chat = $("#dialogue-chat");
  chat.innerHTML = "";
  for (const turn of dialogueTurns) {
    const bubble = document.createElement("div");
    bubble.className = `dialogue-bubble ${turn.role}`;
    bubble.textContent = turn.content;

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
  if (!text) return;

  const provider = settings.provider || "onnx";
  if (provider === "onnx" && settings.onnxModel && !downloadedModels[settings.onnxModel]) {
    if (!confirmOnnxDownload(settings.onnxModel)) return;
  }

  const requestMessages = [
    ...(dialogueSystemPrompt.trim() ? [{ role: "system", content: dialogueSystemPrompt }] : []),
    ...dialogueTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: text },
  ];

  dialogueTurns.push({ role: "user", content: text, raw: { request: requestMessages } });
  input.value = "";
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

// --- Trackers -----------------------------------------------------------

function wireTrackers() {
  $("#tracker-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tracker = {
      label: $("#tracker-label").value.trim(),
      prompt: $("#tracker-prompt").value.trim(),
      intervalMinutes: Number($("#tracker-interval").value) || 60,
    };
    if (!tracker.label || !tracker.prompt) return;
    await sendMessage({ type: "tracker.create", tracker });
    e.target.reset();
    $("#tracker-interval").value = 60;
    refreshTrackerList();
  });
}

async function refreshTrackerList() {
  const trackers = (await sendMessage({ type: "tracker.list" })) || [];
  const list = $("#tracker-list");
  list.innerHTML = "";
  for (const t of trackers) {
    const li = document.createElement("li");
    li.innerHTML = `<span><strong>${t.label}</strong> — every ${t.intervalMinutes}m</span>`;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await sendMessage({ type: "tracker.delete", id: t.id });
      refreshTrackerList();
    });
    li.appendChild(del);
    list.appendChild(li);
  }
}
