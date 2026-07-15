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
    startDownload("onnx-community/Qwen2.5-1.5B-Instruct");
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
}

async function saveSettings(patch) {
  settings = await sendMessage({ type: "settings.set", patch });
  renderModelBadge();
  return settings;
}

async function refreshOnnxSettings() {
  const { onnxModels } = await chrome.storage.local.get("onnxModels");
  downloadedModels = onnxModels || {};

  const statusRes = await sendMessage({ type: "onnx.relay", engineType: "engine.status" });
  if (statusRes?.error) {
    $("#onnx-device").textContent = "Device: not started yet";
  } else {
    const deviceLabel = statusRes.device === "webgpu" ? "GPU (WebGPU)" : statusRes.device === "wasm" ? "CPU (slow)" : "unknown";
    $("#onnx-device").textContent = `Device: ${statusRes.device ? deviceLabel : "not started yet"}`;
    registry = statusRes.registry || registry;
    lastKnownDevice = statusRes.device || lastKnownDevice;
    renderModelBadge();
  }

  if (registry.length === 0) {
    const modelsRes = await sendMessage({ type: "onnx.relay", engineType: "engine.models" });
    registry = modelsRes?.models || [];
  }

  renderRegistry(statusRes?.loadedModel);
}

function renderRegistry(loadedModel) {
  const list = $("#onnx-registry");
  list.innerHTML = "";
  for (const m of registry) {
    const li = document.createElement("li");
    li.className = m.id === settings.onnxModel ? "selected" : "";
    const isDownloaded = !!downloadedModels[m.id];
    li.innerHTML = `
      <span>${m.label} <small>(~${(m.approxSizeMB / 1000).toFixed(1)} GB)</small></span>
      <span class="badge ${isDownloaded ? "downloaded" : ""}">${isDownloaded ? "Downloaded" : "Not downloaded"}</span>
    `;
    const btn = document.createElement("button");
    btn.textContent = m.id === loadedModel ? "Loaded" : isDownloaded ? "Load" : "Download";
    btn.disabled = m.id === loadedModel;
    btn.addEventListener("click", async () => {
      await saveSettings({ onnxModel: m.id });
      startDownload(m.id);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function startDownload(modelId) {
  $("#onnx-progress-wrap").classList.remove("hidden");
  $("#onnx-progress-label").textContent = `Loading ${modelId}…`;
  sendMessage({ type: "onnx.relay", engineType: "engine.load", model: modelId })
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
  $("#dialogue-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendDialogue();
  });
  renderDialogue();
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
