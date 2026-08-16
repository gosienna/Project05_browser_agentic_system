// Dialogue tab: chat UI, sessions, tool loop, and Tavily web search.

import {
  clearAllDialogueSessions,
  deleteDialogueSession,
  getDialogueSession,
  listDialogueSessions,
  putDialogueSession,
} from "../WebApp/system-store.js";
import {
  PARAM_TYPES,
  draftsToOpenAiTools,
  draftsToToolsJson,
  emptyParamDraft,
  emptyToolDraft,
  openAiToolsToDrafts,
} from "./tools/schema.js";
import {
  isNvidiaNimProvider,
  resolveLlmBaseUrl,
  resolveOllamaBaseUrl,
} from "../llm-providers.js";
import {
  extractDialogueRawPayload,
  mountCollapsibleJsonTree,
  parseDialogueRawPayload,
  serializeDialogueRawPayload,
} from "./raw-json-view.js";
import { listOllamaModelsWithMeta, resolveOllamaInstalledName } from "../ollama-models.js";
import { getDialogueMaxToolRounds } from "../agent-config.js";
import { DEFAULT_GEMINI_MODEL, formatGeminiPickerLabel, listGeminiModels, resolveGeminiModel } from "../gemini-models.js";
import {
  DEFAULT_OPENAI_MODEL,
  formatOpenAiPickerLabel,
  listOpenAiFlagshipModels,
  resolveOpenAiModel,
} from "../openai-models.js";
import { DEFAULT_NVIDIA_NIM_MODEL, listNvidiaNimModels } from "../nvidia-nim-models.js";
import { isWebllmToolModel } from "../webllm-models.js";
import { initPdfViewer } from "../rag/pdf-viewer.js";
import {
  bindPdfCitationOpener,
  citationsFromSearchResult,
  formatSearchDocumentsDisplay,
  renderCitationChips,
} from "./pdf-citations.js";
import {
  initRagUi,
  refreshDocumentsPanel,
  syncRagChunkInputs,
  wireRagUi,
} from "./rag-ui.js";
import { initDialoguePanelResize } from "./panel-resize.js";
import { buildWebAppSystemMessages } from "../WebApp/prompt.js";
import {
  formatAssistantToolCallDisplay,
  MCP_TOOL_HINT,
  normalizeAssistantToolCalls,
  prepareSearchToolArgs,
  resolveDialogueToolCalls,
  toOpenAiToolCall,
} from "./tool-runtime.js";

let pdfViewer = null;

/** Keep tool payloads small — large HTML + local ONNX (esp. WebGPU) can OOM or crash the next inference. */
const DIALOGUE_TOOL_RESULT_CHARS = 8000;
const DIALOGUE_WEBLLM_TOOL_RESULT_CHARS = 3000;
const DIALOGUE_HTML_FIELD_CHARS = 6000;
const DIALOGUE_SNAPSHOT_FIELD_CHARS = 6000;
const UNTRUNCATED_TOOL_RESULTS = new Set(["list_components", "read_component"]);

function dialogueToolResultCharLimit() {
  return (getSettings?.().provider || "onnx") === "webllm"
    ? DIALOGUE_WEBLLM_TOOL_RESULT_CHARS
    : DIALOGUE_TOOL_RESULT_CHARS;
}

function stringifyToolResultForLlm(toolName, result) {
  if (result == null) return "";
  let payload = result;
  if (toolName === "get_page_html" && result && typeof result === "object" && typeof result.html === "string") {
    const html = result.html;
    if (html.length > DIALOGUE_HTML_FIELD_CHARS) {
      payload = {
        ...result,
        html: html.slice(0, DIALOGUE_HTML_FIELD_CHARS),
        truncatedForContext: true,
        totalChars: html.length,
        shownChars: DIALOGUE_HTML_FIELD_CHARS,
      };
    }
  }
  if (toolName === "browser_snapshot" && result && typeof result === "object" && typeof result.snapshot === "string") {
    const snapshot = result.snapshot;
    if (snapshot.length > DIALOGUE_SNAPSHOT_FIELD_CHARS) {
      payload = {
        ...result,
        snapshot: snapshot.slice(0, DIALOGUE_SNAPSHOT_FIELD_CHARS),
        truncatedForContext: true,
        totalChars: snapshot.length,
        shownChars: DIALOGUE_SNAPSHOT_FIELD_CHARS,
      };
    }
  }
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  if (UNTRUNCATED_TOOL_RESULTS.has(toolName)) return text;
  const limit = dialogueToolResultCharLimit();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated for LLM context]`;
}

let $;
let sendMessage;
let getSettings;
let saveSettings;
let getRegistry;
let setRegistry;
let getDownloadedModels;
let llmModels;
let modelMetaLabel;
let webllmPickerLabel;
let webllmMetaLabel;
let ollamaMetaLabel;
let startDownload;
let formatTime;
let escapeHtml;
let getCurrentSystemId;

let dialogueSystemPrompt = "";
let dialogueToolDrafts = [];
let dialogueTurns = [];
/** User message text for the in-flight send (search tool query fallback). */
let dialogueTriggerQuery = "";
let dialogueImages = [];
let dialogueSending = false;
let dialogueSessionId = null;
let dialogueLastUsage = null;
let dialogueContextEstimate = null;
let dialogueContextEstimateModelId = null;
let dialogueInputPreviewMode = "json";
let dialogueInputPreviewGeneration = 0;
let dialogueInputPreviewTimer = null;
let dialogueInputPayloadOverride = null;
let dialogueInputJsonViewMode = "edit";
let dialogueInputJsonDirty = false;

const DIALOGUE_RAW_PROMPT_PLACEHOLDER =
  "(No processed prompt for this turn. ONNX and Ollama fill this after a reply; other API providers send JSON only.)";

/** Wire Dialogue tab UI; call once from sidepanel init. */
export function createDialoguePanel(deps) {
  $ = deps.$;
  sendMessage = deps.sendMessage;
  getSettings = deps.getSettings;
  saveSettings = deps.saveSettings;
  getRegistry = deps.getRegistry;
  setRegistry = deps.setRegistry;
  getDownloadedModels = deps.getDownloadedModels;
  llmModels = deps.llmModels;
  modelMetaLabel = deps.modelMetaLabel;
  webllmPickerLabel = deps.webllmPickerLabel;
  webllmMetaLabel = deps.webllmMetaLabel;
  ollamaMetaLabel = deps.ollamaMetaLabel;
  startDownload = deps.startDownload;
  formatTime = deps.formatTime;
  escapeHtml = deps.escapeHtml;
  getCurrentSystemId = deps.getCurrentSystemId;

  return {
    wire,
    onTabActivate() {
      applyWebAppDockChrome();
      refreshDialogueModelSelect();
      refreshDialogueSessionsList();
      refreshDialogueContextEstimate();
      syncRagChunkInputs();
      refreshDocumentsPanel();
      renderDialogueToolsForm();
    },
    onSettingsChanged() {
      refreshDialogueModelSelect();
      syncDialogueMcpTogglesFromSettings();
      syncRagChunkInputs();
      renderDialogueToolsForm();
      refreshDialogueContextEstimate();
      refreshDocumentsPanel();
    },
    onWebAppContextChanged() {
      renderDialogueToolsForm();
      notifyDialogueInputChanged();
    },
  };
}

function setDialogueToolbarBtnActive(id, active) {
  const btn = $(id);
  if (btn) btn.classList.toggle("active", active);
}

function syncDialogueToolbarHighlights() {
  setDialogueToolbarBtnActive(
    "#dialogue-sessions-toggle",
    !$("#dialogue-sessions-panel")?.classList.contains("collapsed")
  );
  setDialogueToolbarBtnActive(
    "#dialogue-documents-toggle",
    !$("#dialogue-documents-panel")?.classList.contains("collapsed")
  );
  setDialogueToolbarBtnActive(
    "#dialogue-pdf-toggle",
    !$("#dialogue-pdf-panel")?.classList.contains("collapsed")
  );
  setDialogueToolbarBtnActive("#dialogue-system-toggle", !$("#dialogue-system-wrap")?.classList.contains("hidden"));
  setDialogueToolbarBtnActive("#dialogue-tools-toggle", !$("#dialogue-tools-wrap")?.classList.contains("hidden"));
  setDialogueToolbarBtnActive(
    "#dialogue-preview-toggle",
    !$("#dialogue-preview-wrap")?.classList.contains("hidden")
  );
}

function wire() {
  $("#dialogue-sessions-toggle").addEventListener("click", () => {
    const panel = $("#dialogue-sessions-panel");
    const collapsed = panel.classList.toggle("collapsed");
    $("#dialogue-sessions-toggle").setAttribute("aria-expanded", String(!collapsed));
    syncDialogueToolbarHighlights();
    if (!collapsed) refreshDialogueSessionsList();
  });
  $("#dialogue-new-btn").addEventListener("click", () => startNewDialogueSession());
  $("#dialogue-sessions-clear-btn").addEventListener("click", () => clearAllDialogueSessionsUi());
  $("#dialogue-system-toggle").addEventListener("click", () => {
    $("#dialogue-system-wrap").classList.toggle("hidden");
    syncDialogueToolbarHighlights();
  });
  $("#dialogue-system-input").addEventListener("input", (e) => {
    dialogueSystemPrompt = e.target.value;
    notifyDialogueInputChanged();
  });
  $("#dialogue-tools-toggle").addEventListener("click", () => {
    const wrap = $("#dialogue-tools-wrap");
    wrap.classList.toggle("hidden");
    syncDialogueToolbarHighlights();
    if (!wrap.classList.contains("hidden")) renderDialogueToolsForm();
  });
  $("#dialogue-tools-add-btn").addEventListener("click", () => {
    dialogueToolDrafts.push(emptyToolDraft());
    renderDialogueToolsForm();
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
  $("#dialogue-input").addEventListener("input", () => notifyDialogueInputChanged());
  $("#dialogue-attach-btn").addEventListener("click", () => $("#dialogue-image-input").click());
  $("#dialogue-image-input").addEventListener("change", async (e) => {
    await addDialogueImages(e.target.files);
    e.target.value = ""; // allow re-picking the same file
  });
  syncDialogueMcpTogglesFromSettings();
  const webSearchCb = $("#dialogue-web-search-enabled");
  if (webSearchCb) {
    webSearchCb.addEventListener("change", (e) => {
      saveSettings({ dialogueWebSearch: e.target.checked });
      renderDialogueToolsForm();
      notifyDialogueInputChanged();
    });
  }
  const browserToolsCb = $("#dialogue-browser-tools-enabled");
  if (browserToolsCb) {
    browserToolsCb.addEventListener("change", (e) => {
      saveSettings({ dialogueBrowserTools: e.target.checked });
      renderDialogueToolsForm();
      notifyDialogueInputChanged();
    });
  }
  const ragToolsCb = $("#dialogue-rag-tools-enabled");
  if (ragToolsCb) {
    ragToolsCb.addEventListener("change", (e) => {
      saveSettings({ dialogueRagTools: e.target.checked });
      renderDialogueToolsForm();
      notifyDialogueInputChanged();
    });
  }
  const webAppToolsCb = $("#dialogue-webapp-tools-enabled");
  if (webAppToolsCb) {
    webAppToolsCb.addEventListener("change", (e) => {
      saveSettings({ dialogueWebAppTools: e.target.checked });
      renderDialogueToolsForm();
      notifyDialogueInputChanged();
    });
  }
  initRagUi({
    $,
    sendMessage,
    saveSettings,
    getSettings,
    escapeHtml,
    onOpenPdf: (opts) => pdfViewer?.openDoc(opts.docId),
    syncToolbarHighlights: syncDialogueToolbarHighlights,
  });
  wireRagUi();
  initDialoguePanelResize({ $ });
  pdfViewer = initPdfViewer($("#dialogue-pdf-viewer"), {
    panel: $("#dialogue-pdf-panel"),
    onPanelChange: syncDialogueToolbarHighlights,
  });
  bindPdfCitationOpener((opts) => pdfViewer?.openCitation(opts));
  syncRagChunkInputs();
  wireDialogueInputPreview();
  applyWebAppDockChrome();
  renderDialogue();
  renderDialogueToolsForm();
  refreshDialogueModelSelect();
  refreshDialogueSessionsList();
  syncDialogueToolbarHighlights();
}

async function refreshDialogueSessionsList() {
  const list = $("#dialogue-sessions-list");
  if (!list) return;
  let items = [];
  try {
    items = await listDialogueSessions();
  } catch (err) {
    console.error("[dialogue] list sessions failed", err);
  }
  list.innerHTML = "";
  const clearBtn = $("#dialogue-sessions-clear-btn");
  if (clearBtn) clearBtn.disabled = items.length === 0;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "dialogue-sessions-empty";
    empty.textContent = "No saved chats yet.";
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "dialogue-session-item" + (item.id === dialogueSessionId ? " active" : "");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "dialogue-session-main";
    main.title = item.title;
    const imgHint = item.hasImages ? " · 🖼" : "";
    main.innerHTML =
      `<span class="dialogue-session-title">${escapeHtml(item.title)}</span>` +
      `<span class="dialogue-session-meta">${formatTime(item.updatedAt)} · ${item.turnCount} msgs${imgHint}</span>`;
    main.addEventListener("click", () => openDialogueSession(item.id));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "dialogue-session-del";
    del.title = "Delete session";
    del.setAttribute("aria-label", "Delete session");
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDialogueSessionUi(item.id, item.title);
    });

    row.appendChild(main);
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function persistDialogueSession() {
  if (!dialogueTurns.length) return null;
  try {
    const record = await putDialogueSession({
      id: dialogueSessionId,
      systemPrompt: dialogueSystemPrompt,
      toolsJson: draftsToToolsJson(dialogueToolDrafts) || "",
      turns: dialogueTurns,
      lastUsage: dialogueLastUsage,
    });
    dialogueSessionId = record.id;
    await refreshDialogueSessionsList();
    return record;
  } catch (err) {
    console.error("[dialogue] save session failed", err);
    return null;
  }
}

async function openDialogueSession(id) {
  if (dialogueSending) return;
  try {
    const session = await getDialogueSession(id);
    if (!session) return;
    dialogueSessionId = session.id;
    dialogueSystemPrompt = session.systemPrompt || "";
    dialogueToolDrafts = openAiToolsToDrafts(session.toolsJson || "");
    dialogueTurns = Array.isArray(session.turns) ? session.turns : [];
    dialogueImages = [];
    dialogueLastUsage = session.lastUsage || null;
    clearDialogueInputPayloadOverride();
    dialogueInputJsonViewMode = "edit";
    dialogueInputJsonDirty = false;
    $("#dialogue-system-input").value = dialogueSystemPrompt;
    clearDialogueToolsError();
    renderDialogueToolsForm();
    renderDialogueAttachments();
    renderDialogue();
    await refreshDialogueSessionsList();
    await refreshDialogueContextEstimate();
    notifyDialogueInputChanged();
  } catch (err) {
    console.error("[dialogue] open session failed", err);
  }
}

function startNewDialogueSession() {
  if (dialogueSending) return;
  dialogueSessionId = null;
  dialogueSystemPrompt = "";
  dialogueToolDrafts = [];
  dialogueTurns = [];
  dialogueImages = [];
  dialogueLastUsage = null;
  clearDialogueInputPayloadOverride();
  dialogueInputJsonViewMode = "edit";
  dialogueInputJsonDirty = false;
  $("#dialogue-system-input").value = "";
  clearDialogueToolsError();
  renderDialogueToolsForm();
  renderDialogueAttachments();
  renderDialogue();
  renderDialogueContextBar();
  refreshDialogueSessionsList();
  notifyDialogueInputChanged();
}

async function deleteDialogueSessionUi(id, title) {
  if (dialogueSending) return;
  if (!confirm(`Delete chat "${title || "this session"}"?`)) return;
  try {
    await deleteDialogueSession(id);
    if (dialogueSessionId === id) startNewDialogueSession();
    else await refreshDialogueSessionsList();
  } catch (err) {
    console.error("[dialogue] delete session failed", err);
  }
}

async function clearAllDialogueSessionsUi() {
  if (dialogueSending) return;
  if (!confirm("Delete all saved chats? This cannot be undone.")) return;
  try {
    await clearAllDialogueSessions();
    startNewDialogueSession();
  } catch (err) {
    console.error("[dialogue] clear all sessions failed", err);
  }
}

function clearDialogueToolsError() {
  const el = $("#dialogue-tools-error");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

/** Build OpenAI-shaped tools from the form; null if invalid. */
function syncDialogueToolsFromUi() {
  const { tools, error } = draftsToOpenAiTools(dialogueToolDrafts);
  const el = $("#dialogue-tools-error");
  if (error) {
    if (el) {
      el.textContent = error;
      el.classList.remove("hidden");
    }
    return null;
  }
  clearDialogueToolsError();
  return tools;
}

/** Lenient tool sync for live preview — shows current drafts even when invalid. */
function syncDialogueToolsFromUiLenient() {
  const { tools } = draftsToOpenAiTools(dialogueToolDrafts);
  return tools || [];
}

function isDialogueInputPreviewOpen() {
  const wrap = $("#dialogue-preview-wrap");
  return wrap && !wrap.classList.contains("hidden");
}

function clearDialogueInputPayloadOverride() {
  dialogueInputPayloadOverride = null;
  updateDialogueInputOverrideStatus();
}

function updateDialogueInputOverrideStatus() {
  const status = $("#dialogue-preview-json-status");
  if (!status) return;
  if (dialogueInputPayloadOverride) {
    status.textContent = "Custom payload (used on Send)";
    status.className = "dialogue-raw-json-status override";
    status.classList.remove("hidden");
  } else if (!status.classList.contains("error")) {
    status.textContent = "";
    status.className = "dialogue-raw-json-status hidden";
  }
}

function notifyDialogueInputChanged() {
  if (dialogueInputJsonViewMode === "edit" && document.activeElement === $("#dialogue-preview-json-edit")) {
    scheduleDialogueInputPreviewRefresh();
    return;
  }
  dialogueInputJsonDirty = false;
  clearDialogueInputPayloadOverride();
  scheduleDialogueInputPreviewRefresh();
}

function scheduleDialogueInputPreviewRefresh() {
  if (!isDialogueInputPreviewOpen()) return;
  if (dialogueInputPreviewTimer) clearTimeout(dialogueInputPreviewTimer);
  if (dialogueInputPreviewMode === "json") {
    refreshDialogueInputPreview();
  } else {
    dialogueInputPreviewTimer = setTimeout(() => refreshDialogueInputPreview(), 400);
  }
}

async function buildPendingDialogueLlmInput() {
  const userTools = syncDialogueToolsFromUiLenient();
  const tools = await buildDialogueTools(userTools);
  const mcpToolNames = tools.map((t) => t.function?.name).filter(Boolean);
  const text = $("#dialogue-input")?.value.trim() || "";
  const images = dialogueImages.slice();
  const messages = [
    ...buildDialogueSystemMessages(mcpToolNames),
    ...turnsToChatMessages(dialogueTurns),
  ];
  if (text || images.length) {
    messages.push(turnToMessage({ role: "user", content: text, images }));
  }
  return { messages, tools };
}

async function fetchDialoguePromptPreview(messages, tools) {
  const res = await sendMessage({
    type: "dialogue.renderPrompt",
    messages,
    ...(tools.length ? { tools } : {}),
  });
  return res?.prompt ?? null;
}

async function refreshDialogueInputPreview() {
  if (!isDialogueInputPreviewOpen()) return;

  const jsonRoot = $("#dialogue-preview-json-root");
  const promptPanel = $("#dialogue-preview-panel");
  const editEl = $("#dialogue-preview-json-edit");
  if (!jsonRoot || !promptPanel) return;

  const generation = ++dialogueInputPreviewGeneration;

  try {
    if (dialogueInputPreviewMode === "prompt") {
      jsonRoot.classList.add("hidden");
      editEl?.classList.add("hidden");
      $(".dialogue-raw-json-actions")?.classList.add("hidden");
      promptPanel.classList.remove("hidden");

      const { messages, tools } = dialogueInputPayloadOverride
        ? { messages: dialogueInputPayloadOverride.messages, tools: dialogueInputPayloadOverride.tools ?? [] }
        : await buildPendingDialogueLlmInput();
      const raw = snapshotDialogueRawInput(messages, tools);

      promptPanel.textContent = "Rendering…";
      const prompt = await fetchDialoguePromptPreview(messages, tools);
      if (generation !== dialogueInputPreviewGeneration) return;
      raw.prompt = prompt;
      renderDialoguePromptPanel(promptPanel, raw);
      return;
    }

    promptPanel.classList.add("hidden");
    $(".dialogue-raw-json-actions")?.classList.remove("hidden");

    if (dialogueInputJsonViewMode === "edit") {
      jsonRoot.classList.add("hidden");
      editEl?.classList.remove("hidden");
      setDialogueInputJsonViewUi("edit");

      if (!dialogueInputJsonDirty && document.activeElement !== editEl) {
        const payload = await getDialogueInputPreviewPayloadForEdit();
        if (editEl) editEl.value = serializeDialogueRawPayload(payload);
      }
      updateDialogueInputOverrideStatus();
      return;
    }

    editEl?.classList.add("hidden");
    jsonRoot.classList.remove("hidden");
    setDialogueInputJsonViewUi("tree");

    if (dialogueInputPayloadOverride) {
      mountCollapsibleJsonTree(jsonRoot, dialogueInputPayloadOverride);
      return;
    }

    const { messages, tools } = await buildPendingDialogueLlmInput();
    const raw = snapshotDialogueRawInput(messages, tools);
    mountCollapsibleJsonTree(jsonRoot, extractDialogueRawPayload(raw));
  } catch (err) {
    if (generation !== dialogueInputPreviewGeneration) return;
    if (dialogueInputJsonViewMode === "edit" && editEl) {
      editEl.value = `Preview error: ${err.message || String(err)}`;
    } else {
      jsonRoot.textContent = `Preview error: ${err.message || String(err)}`;
    }
  }
}

function renderDialoguePromptPanel(panel, raw) {
  panel.textContent =
    typeof raw.prompt === "string" && raw.prompt.length > 0
      ? raw.prompt
      : DIALOGUE_RAW_PROMPT_PLACEHOLDER;
}

function renderDialogueRawJsonTree(container, raw) {
  mountCollapsibleJsonTree(container, extractDialogueRawPayload(raw), {
    collapsedKeys: ["reasoning", "thinking", "reasoning_content"],
  });
}

async function getDialogueInputPreviewPayloadForEdit() {
  if (dialogueInputPayloadOverride) return dialogueInputPayloadOverride;
  const { messages, tools } = await buildPendingDialogueLlmInput();
  const raw = snapshotDialogueRawInput(messages, tools);
  return extractDialogueRawPayload(raw);
}

function setDialogueInputJsonViewUi(mode) {
  const editBtn = $("#dialogue-preview-json-edit-btn");
  const applyBtn = $("#dialogue-preview-json-apply-btn");
  const cancelBtn = $("#dialogue-preview-json-cancel-btn");
  if (mode === "edit") {
    editBtn.textContent = "Tree view";
    applyBtn?.classList.remove("hidden");
    cancelBtn?.classList.remove("hidden");
  } else {
    editBtn.textContent = "Edit JSON";
    applyBtn?.classList.add("hidden");
    cancelBtn?.classList.add("hidden");
  }
}

function setDialogueInputJsonViewMode(mode) {
  dialogueInputJsonViewMode = mode;
  refreshDialogueInputPreview();
}

function showDialogueInputJsonEditView() {
  if (dialogueInputJsonViewMode === "edit") {
    setDialogueInputJsonViewMode("tree");
    return;
  }
  dialogueInputJsonViewMode = "edit";
  if (!dialogueInputJsonDirty) {
    getDialogueInputPreviewPayloadForEdit().then((payload) => {
      const editEl = $("#dialogue-preview-json-edit");
      if (editEl) editEl.value = serializeDialogueRawPayload(payload);
    });
  }
  refreshDialogueInputPreview();
}

function cancelDialogueInputJsonEdit() {
  dialogueInputJsonDirty = false;
  clearDialogueInputPayloadOverride();
  const editEl = $("#dialogue-preview-json-edit");
  getDialogueInputPreviewPayloadForEdit().then((payload) => {
    if (editEl) editEl.value = serializeDialogueRawPayload(payload);
  });
  updateDialogueInputOverrideStatus();
}

function applyDialogueInputJsonEdit() {
  const editEl = $("#dialogue-preview-json-edit");
  const status = $("#dialogue-preview-json-status");
  if (!editEl) return;

  const { data, error } = parseDialogueRawPayload(editEl.value);
  if (error) {
    if (status) {
      status.textContent = error;
      status.className = "dialogue-raw-json-status error";
      status.classList.remove("hidden");
    }
    return;
  }

  dialogueInputPayloadOverride = data;
  dialogueInputJsonDirty = false;
  updateDialogueInputOverrideStatus();
}

/** Extract last user message from override messages for bubble display. */
function userTurnFromMessage(msg) {
  const turn = { role: "user", content: "", images: [] };
  if (!msg) return turn;

  const c = msg.content;
  if (typeof c === "string") {
    turn.content = c;
    return turn;
  }
  if (Array.isArray(c)) {
    const textParts = c.filter((p) => p?.type === "text").map((p) => p.text || "");
    turn.content = textParts.join("\n");
    turn.images = c
      .filter((p) => p?.type === "image_url" && p.image_url?.url)
      .map((p) => p.image_url.url);
    return turn;
  }
  turn.content = c != null ? String(c) : "";
  return turn;
}

function findLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return null;
}

function wireDialogueInputPreview() {
  const toggle = $("#dialogue-preview-toggle");
  const wrap = $("#dialogue-preview-wrap");
  const jsonBtn = $("#dialogue-preview-json-btn");
  const promptBtn = $("#dialogue-preview-prompt-btn");
  if (!toggle || !wrap) return;

  toggle.addEventListener("click", () => {
    wrap.classList.toggle("hidden");
    const open = !wrap.classList.contains("hidden");
    toggle.textContent = open ? "Hide raw" : "Show raw";
    syncDialogueToolbarHighlights();
    if (open) refreshDialogueInputPreview();
  });

  const setMode = (mode) => {
    if (mode === "prompt" && dialogueInputJsonViewMode === "edit") {
      dialogueInputJsonViewMode = "edit";
    }
    dialogueInputPreviewMode = mode;
    jsonBtn?.classList.toggle("active", mode === "json");
    promptBtn?.classList.toggle("active", mode === "prompt");
  };

  jsonBtn?.addEventListener("click", () => {
    setMode("json");
    dialogueInputJsonViewMode = "edit";
    refreshDialogueInputPreview();
  });
  promptBtn?.addEventListener("click", () => {
    setMode("prompt");
    refreshDialogueInputPreview();
  });

  $("#dialogue-preview-json-edit-btn")?.addEventListener("click", () => showDialogueInputJsonEditView());
  $("#dialogue-preview-json-apply-btn")?.addEventListener("click", () => applyDialogueInputJsonEdit());
  $("#dialogue-preview-json-cancel-btn")?.addEventListener("click", () => cancelDialogueInputJsonEdit());
  $("#dialogue-preview-json-edit")?.addEventListener("input", () => {
    dialogueInputJsonDirty = true;
    const status = $("#dialogue-preview-json-status");
    if (status?.classList.contains("error")) {
      status.textContent = "";
      status.className = "dialogue-raw-json-status hidden";
    }
  });
}

function renderDialogueRawPanelContent(jsonRoot, promptPanel, raw, mode) {
  if (mode === "prompt") {
    jsonRoot?.classList.add("hidden");
    promptPanel?.classList.remove("hidden");
    renderDialoguePromptPanel(promptPanel, raw);
  } else {
    promptPanel?.classList.add("hidden");
    jsonRoot?.classList.remove("hidden");
    renderDialogueRawJsonTree(jsonRoot, raw);
  }
}

function createDialogueRawModeSwitcher({ getMode, setMode, onModeChange }) {
  const modes = document.createElement("div");
  modes.className = "dialogue-raw-modes";
  const jsonBtn = document.createElement("button");
  jsonBtn.type = "button";
  jsonBtn.className = "dialogue-raw-mode active";
  jsonBtn.textContent = "JSON";
  const promptBtn = document.createElement("button");
  promptBtn.type = "button";
  promptBtn.className = "dialogue-raw-mode";
  promptBtn.textContent = "Prompt";
  modes.appendChild(jsonBtn);
  modes.appendChild(promptBtn);

  const syncActive = () => {
    const mode = getMode();
    jsonBtn.classList.toggle("active", mode === "json");
    promptBtn.classList.toggle("active", mode === "prompt");
  };

  jsonBtn.addEventListener("click", () => {
    setMode("json");
    syncActive();
    onModeChange?.();
  });
  promptBtn.addEventListener("click", () => {
    setMode("prompt");
    syncActive();
    onModeChange?.();
  });

  return { modes, syncActive };
}

function isWebAppDock() {
  return $("#tab-dialogue")?.classList.contains("webapp-dock");
}

function applyWebAppDockChrome() {
  if (!isWebAppDock()) return;
  $("#dialogue-documents-panel")?.classList.add("collapsed");
  $("#dialogue-pdf-panel")?.classList.add("collapsed");
  $("#dialogue-documents-toggle")?.setAttribute("aria-expanded", "false");
  $("#dialogue-pdf-toggle")?.setAttribute("aria-expanded", "false");
  syncDialogueToolbarHighlights();
}

function isDialogueWebSearchEnabled() {
  return getSettings().dialogueWebSearch !== false && $("#dialogue-web-search-enabled")?.checked !== false;
}

function isDialogueBrowserToolsEnabled() {
  return getSettings().dialogueBrowserTools !== false && $("#dialogue-browser-tools-enabled")?.checked !== false;
}

function syncDialogueMcpTogglesFromSettings() {
  const webSearchCb = $("#dialogue-web-search-enabled");
  if (webSearchCb) webSearchCb.checked = getSettings().dialogueWebSearch !== false;
  const browserToolsCb = $("#dialogue-browser-tools-enabled");
  if (browserToolsCb) browserToolsCb.checked = getSettings().dialogueBrowserTools !== false;
  const ragToolsCb = $("#dialogue-rag-tools-enabled");
  if (ragToolsCb) ragToolsCb.checked = getSettings().dialogueRagTools !== false;
  const webAppToolsCb = $("#dialogue-webapp-tools-enabled");
  if (webAppToolsCb) webAppToolsCb.checked = getSettings().dialogueWebAppTools !== false;
}

function isDialogueRagToolsEnabled() {
  return getSettings().dialogueRagTools !== false && $("#dialogue-rag-tools-enabled")?.checked !== false;
}

function isDialogueWebAppToolsEnabled() {
  return getSettings().dialogueWebAppTools !== false && $("#dialogue-webapp-tools-enabled")?.checked !== false;
}

function dialogueMcpSettingsOverrides() {
  const dock = isWebAppDock();
  const systemId = dock ? getCurrentSystemId?.() || "" : "";
  return {
    dialogueWebSearch: isDialogueWebSearchEnabled(),
    dialogueBrowserTools: isDialogueBrowserToolsEnabled(),
    dialogueRagTools: dock ? false : isDialogueRagToolsEnabled(),
    dialogueWebAppTools: dock && isDialogueWebAppToolsEnabled(),
    webAppSystemId: systemId,
  };
}

async function fetchMcpDialogueTools() {
  const overrides = dialogueMcpSettingsOverrides();
  const res = await sendMessage({
    type: "mcp.tools.list",
    groups: ["dialogue"],
    settings: overrides,
    ...(overrides.webAppSystemId ? { systemId: overrides.webAppSystemId } : {}),
  });
  return res || { tools: [], openAiTools: [] };
}

/** User-defined tools plus MCP server tools enabled in settings. */
async function buildDialogueTools(userTools) {
  const tools = [...(userTools || [])];
  const { openAiTools } = await fetchMcpDialogueTools();
  for (const t of openAiTools) {
    if (!tools.some((x) => x.function?.name === t.function?.name)) tools.unshift(t);
  }
  return tools;
}

function buildDialogueSystemMessages(mcpToolNames = []) {
  if (isWebAppDock()) {
    return buildWebAppSystemMessages({
      customPrompt: dialogueSystemPrompt,
      mcpToolNames,
    });
  }
  const parts = [];
  if (dialogueSystemPrompt.trim()) parts.push(dialogueSystemPrompt.trim());
  if (mcpToolNames.length) {
    parts.push(`${MCP_TOOL_HINT}\nAvailable MCP tools: ${mcpToolNames.join(", ")}`);
  }
  if (!parts.length) return [];
  return [{ role: "system", content: parts.join("\n\n") }];
}

async function runDialogueTool(name, args) {
  const overrides = dialogueMcpSettingsOverrides();
  const res = await sendMessage({
    type: "dialogue.tool.run",
    name,
    args,
    userQuery: dialogueTriggerQuery,
    settings: overrides,
    ...(overrides.webAppSystemId ? { systemId: overrides.webAppSystemId } : {}),
  });
  if (!res) {
    throw new Error("Tool runner did not respond — reload the extension and try again.");
  }
  if (res?.error) {
    const err = res.error;
    throw new Error(typeof err === "string" ? err : err?.message || String(err));
  }
  return res.result;
}

/** Map stored turns → LLM messages (tool turns become user-role result messages). */
function turnsToChatMessages(turns) {
  const out = [];
  for (const t of turns) {
    if (t.role === "tool") {
      if (t.pending) continue;
      const body = t.error ? `Error: ${t.error}` : stringifyToolResultForLlm(t.toolName, t.result);
      out.push({ role: "user", content: `Tool ${t.toolName} result:\n${body}` });
      continue;
    }
    out.push(turnToMessage(t));
  }
  return out;
}

/** Tool-result bubble body only (the LLM call is shown in a separate assistant turn). */
function formatToolTurnDisplay(toolName, result, error) {
  if (error) return `Error: ${error}`;
  if (toolName === "web_search" && result?.results) {
    const lines = [];
    for (const r of result.results) {
      lines.push(`• ${r.title || "(no title)"}`);
      if (r.snippet) lines.push(`  ${r.snippet}`);
      if (r.url) lines.push(`  ${r.url}`);
    }
    return lines.join("\n") || "(no results)";
  }
  if (toolName === "search_documents") {
    return formatSearchDocumentsDisplay(result);
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function stripPromptFromResponse(res) {
  if (!res || typeof res !== "object") return res;
  const copy = { ...res };
  delete copy.prompt;
  return copy;
}

/** Deep-copy messages/tools so each raw panel keeps that round's LLM input (not a shared mutable array). */
function snapshotDialogueRawInput(messages, tools) {
  const raw = { request: structuredClone(messages) };
  if (tools?.length) raw.tools = structuredClone(tools);
  return raw;
}

function buildDialogueRawFromCompletion(inputRaw, res) {
  const raw = { ...inputRaw, response: stripPromptFromResponse(res) };
  if (typeof res?.prompt === "string") raw.prompt = res.prompt;
  return raw;
}

async function executeDialogueToolTurn(call, btn) {
  const resolvedArgs = prepareSearchToolArgs(call.name, call.args || {}, dialogueTriggerQuery);
  call.args = resolvedArgs;

  const toolTurn = {
    role: "tool",
    toolName: call.name,
    args: resolvedArgs,
    pending: true,
    content: "",
  };
  dialogueTurns.push(toolTurn);
  renderDialogue();

  if (btn) btn.textContent = `Running ${call.name}…`;
  let result = null;
  let errMsg = null;
  try {
    result = await runDialogueTool(call.name, resolvedArgs);
  } catch (err) {
    errMsg = err.message;
  }

  toolTurn.pending = false;
  toolTurn.result = result;
  toolTurn.error = errMsg;
  toolTurn.content = formatToolTurnDisplay(call.name, result, errMsg);
  if (call.name === "search_documents" && result && !errMsg) {
    toolTurn.citations = citationsFromSearchResult(result);
  }
  renderDialogue();

  const resultText = errMsg ? `Error: ${errMsg}` : stringifyToolResultForLlm(call.name, result);
  return { toolTurn, resultText };
}

function activeDialogueChatModelId() {
  const provider = getSettings().provider || "onnx";
  const fromSelect = $("#dialogue-model-select")?.value || "";
  if (provider === "onnx") return fromSelect || getSettings().onnxModel || "";
  if (provider === "webllm") return fromSelect || getSettings().webllmModel || "";
  return fromSelect || getSettings().model || "";
}

/** Native OpenAI-style tools — only for providers/models that support them. */
function dialogueCompletionTools(tools) {
  if (!tools?.length) return [];
  const settings = getSettings();
  const provider = settings.provider || "onnx";
  if (provider === "onnx") return [];
  // NIM's OpenAI shim rejects tools with tool_choice:auto on many models (llama.cpp backend).
  if (provider === "nvidia-nim" || isNvidiaNimProvider(provider, resolveLlmBaseUrl(settings))) return [];
  if (provider === "webllm") {
    return isWebllmToolModel(activeDialogueChatModelId()) ? tools : [];
  }
  return tools;
}

async function dialogueChatCompletion(messages, tools) {
  const apiTools = dialogueCompletionTools(tools);
  return sendMessage({
    type: "dialogue.send",
    messages,
    ...(apiTools.length ? { tools: apiTools } : {}),
  });
}

function noteWebllmContextTrim(res) {
  const trim = res?.context_trimmed;
  if (!trim?.droppedTurns) return;
  dialogueTurns.push({
    role: "assistant",
    content:
      `ℹ WebLLM context limit (${formatDialogueTokenCount(trim.contextLimit)} tokens): ` +
      `dropped ${trim.droppedTurns} older message(s) from this request.`,
  });
}

function createMcpToolCard(tool) {
  const card = document.createElement("div");
  card.className = "dialogue-tool-card dialogue-tool-card-builtin";

  const header = document.createElement("div");
  header.className = "dialogue-tool-card-header";
  const title = document.createElement("span");
  title.className = "dialogue-tool-card-title";
  title.textContent = `MCP: ${tool.name}`;
  const badge = document.createElement("span");
  badge.className = "dialogue-tool-builtin-badge";
  badge.textContent = "MCP server";
  header.appendChild(title);
  header.appendChild(badge);

  const hint = document.createElement("p");
  hint.className = "dialogue-tool-builtin-hint";
  hint.textContent = tool.description || "Registered on the extension MCP server; executed in the background when the model calls it.";

  const jsonLabel = document.createElement("div");
  jsonLabel.className = "dialogue-tool-json-label";
  jsonLabel.textContent = "MCP tool JSON (tools/list)";

  const jsonRoot = document.createElement("div");
  jsonRoot.className = "dialogue-raw-json-root dialogue-tool-json";
  mountCollapsibleJsonTree(jsonRoot, tool);

  card.appendChild(header);
  card.appendChild(hint);
  card.appendChild(jsonLabel);
  card.appendChild(jsonRoot);
  return card;
}

async function renderDialogueToolsForm() {
  const list = $("#dialogue-tools-list");
  if (!list) return;
  list.innerHTML = "";

  const status = $("#dialogue-mcp-status");
  const webOn = isDialogueWebSearchEnabled();
  const browserOn = isDialogueBrowserToolsEnabled();
  const ragOn = !isWebAppDock() && isDialogueRagToolsEnabled();
  const webAppOn = isWebAppDock() && isDialogueWebAppToolsEnabled();
  if (status) {
    const parts = [];
    if (webOn) parts.push("web search");
    if (browserOn) parts.push("browser automation");
    if (ragOn) parts.push("document RAG");
    if (webAppOn) parts.push("WebApp components");
    status.textContent = parts.length
      ? `MCP enabled: ${parts.join(" + ")}`
      : "No MCP tools enabled — check the boxes above.";
  }

  const { tools: mcpTools } = await fetchMcpDialogueTools();
  for (const tool of mcpTools) {
    list.appendChild(createMcpToolCard(tool));
  }

  if (!browserOn && webOn) {
    const note = document.createElement("p");
    note.className = "dialogue-mcp-status";
    note.textContent =
      "Browser tools (read_page, click, list_tabs, …) are off. Enable “Browser tools (MCP)” above to show them.";
    list.appendChild(note);
  }

  if (!dialogueToolDrafts.length) {
    if (!mcpTools.length) {
      const empty = document.createElement("div");
      empty.className = "dialogue-tools-empty";
      empty.textContent = "No tools yet. Enable MCP tools below or click “+ Add tool” for schema-only custom tools.";
      list.appendChild(empty);
    }
    notifyDialogueInputChanged();
    return;
  }

  dialogueToolDrafts.forEach((tool, ti) => {
    const card = document.createElement("div");
    card.className = "dialogue-tool-card";

    const header = document.createElement("div");
    header.className = "dialogue-tool-card-header";
    const title = document.createElement("span");
    title.className = "dialogue-tool-card-title";
    title.textContent = `Tool ${ti + 1}`;
    const removeTool = document.createElement("button");
    removeTool.type = "button";
    removeTool.className = "icon-btn";
    removeTool.title = "Remove tool";
    removeTool.textContent = "✕";
    removeTool.addEventListener("click", () => {
      dialogueToolDrafts.splice(ti, 1);
      clearDialogueToolsError();
      renderDialogueToolsForm();
    });
    header.appendChild(title);
    header.appendChild(removeTool);

    const fields = document.createElement("div");
    fields.className = "dialogue-tool-fields";

    const nameLabel = document.createElement("label");
    nameLabel.className = "full";
    nameLabel.innerHTML = `Name<input type="text" data-field="name" placeholder="get_weather" autocomplete="off" />`;
    nameLabel.querySelector("input").value = tool.name || "";
    nameLabel.querySelector("input").addEventListener("input", (e) => {
      dialogueToolDrafts[ti].name = e.target.value;
      clearDialogueToolsError();
    });

    const descLabel = document.createElement("label");
    descLabel.className = "full";
    descLabel.innerHTML = `Description<textarea rows="2" data-field="description" placeholder="Get the current weather for a location."></textarea>`;
    descLabel.querySelector("textarea").value = tool.description || "";
    descLabel.querySelector("textarea").addEventListener("input", (e) => {
      dialogueToolDrafts[ti].description = e.target.value;
      clearDialogueToolsError();
    });

    fields.appendChild(nameLabel);
    fields.appendChild(descLabel);

    const paramsWrap = document.createElement("div");
    paramsWrap.className = "dialogue-tool-params";
    const paramsLabel = document.createElement("div");
    paramsLabel.className = "dialogue-tool-params-label";
    const paramsTitle = document.createElement("span");
    paramsTitle.textContent = `Parameters (${(tool.parameters || []).length})`;
    const addParam = document.createElement("button");
    addParam.type = "button";
    addParam.className = "secondary-btn dialogue-tool-add-param";
    addParam.textContent = "+ Add parameter";
    addParam.addEventListener("click", () => {
      if (!dialogueToolDrafts[ti].parameters) dialogueToolDrafts[ti].parameters = [];
      dialogueToolDrafts[ti].parameters.push(emptyParamDraft());
      renderDialogueToolsForm();
    });
    paramsLabel.appendChild(paramsTitle);
    paramsLabel.appendChild(addParam);
    paramsWrap.appendChild(paramsLabel);

    (tool.parameters || []).forEach((param, pi) => {
      const row = document.createElement("div");
      row.className = "dialogue-tool-param";
      const rowTitle = document.createElement("div");
      rowTitle.className = "dialogue-tool-param-title param-span-2";
      rowTitle.textContent = `Parameter ${pi + 1}`;

      const nameIn = document.createElement("input");
      nameIn.type = "text";
      nameIn.placeholder = "name";
      nameIn.value = param.name || "";
      nameIn.addEventListener("input", (e) => {
        dialogueToolDrafts[ti].parameters[pi].name = e.target.value;
        clearDialogueToolsError();
      });

      const typeSel = document.createElement("select");
      for (const t of PARAM_TYPES) {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        if ((param.type || "string") === t) opt.selected = true;
        typeSel.appendChild(opt);
      }
      typeSel.addEventListener("change", (e) => {
        dialogueToolDrafts[ti].parameters[pi].type = e.target.value;
      });

      const descIn = document.createElement("input");
      descIn.type = "text";
      descIn.className = "param-span-2";
      descIn.placeholder = "description";
      descIn.title = "Parameter description";
      descIn.value = param.description || "";
      descIn.addEventListener("input", (e) => {
        dialogueToolDrafts[ti].parameters[pi].description = e.target.value;
      });

      const enumIn = document.createElement("input");
      enumIn.type = "text";
      enumIn.className = "param-span-2";
      enumIn.placeholder = "enum values (optional, comma-separated)";
      enumIn.value = param.enumValues || "";
      enumIn.title = "Optional enum values, comma-separated";
      enumIn.addEventListener("input", (e) => {
        dialogueToolDrafts[ti].parameters[pi].enumValues = e.target.value;
      });

      const actions = document.createElement("div");
      actions.className = "param-actions";
      const reqLabel = document.createElement("label");
      reqLabel.className = "dialogue-tool-param-req";
      const req = document.createElement("input");
      req.type = "checkbox";
      req.checked = !!param.required;
      req.addEventListener("change", (e) => {
        dialogueToolDrafts[ti].parameters[pi].required = e.target.checked;
      });
      reqLabel.appendChild(req);
      reqLabel.appendChild(document.createTextNode("Required"));

      const removeParam = document.createElement("button");
      removeParam.type = "button";
      removeParam.className = "icon-btn";
      removeParam.title = "Remove parameter";
      removeParam.textContent = "✕";
      removeParam.addEventListener("click", () => {
        dialogueToolDrafts[ti].parameters.splice(pi, 1);
        renderDialogueToolsForm();
      });
      actions.appendChild(reqLabel);
      actions.appendChild(removeParam);

      row.appendChild(rowTitle);
      row.appendChild(nameIn);
      row.appendChild(typeSel);
      row.appendChild(descIn);
      row.appendChild(enumIn);
      row.appendChild(actions);
      paramsWrap.appendChild(row);
    });

    card.appendChild(header);
    card.appendChild(fields);
    card.appendChild(paramsWrap);

    const jsonLabel = document.createElement("div");
    jsonLabel.className = "dialogue-tool-json-label";
    jsonLabel.textContent = "Tool JSON (OpenAI shape)";

    const jsonRoot = document.createElement("div");
    jsonRoot.className = "dialogue-raw-json-root dialogue-tool-json";
    const { tools: previewTools } = draftsToOpenAiTools([tool]);
    mountCollapsibleJsonTree(
      jsonRoot,
      previewTools?.[0] ?? {
        type: "function",
        function: {
          name: tool.name || "(name required)",
          description: tool.description || "",
          parameters: { type: "object", properties: {} },
        },
      }
    );

    card.appendChild(jsonLabel);
    card.appendChild(jsonRoot);
    list.appendChild(card);
  });
  notifyDialogueInputChanged();
}

async function listOllamaModels() {
  return listOllamaModelsWithMeta(resolveOllamaBaseUrl(getSettings()));
}

/** Bubble text for a non-tool assistant message; warns on token-limit truncation. */
function formatAssistantDisplayContent(msg, choice) {
  const content = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (content) return content;
  if (choice?.finish_reason === "length") {
    return (
      "⚠ Response truncated: hit the max token limit before completing. " +
      "Increase max tokens in Settings and try again."
    );
  }
  return "(empty response)";
}

function assistantReasoningFromMessage(msg) {
  return typeof msg?.reasoning === "string" ? msg.reasoning.trim() : "";
}

function appendDialogueThinkingBlock(bubble, reasoning) {
  if (!reasoning) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dialogue-thinking-toggle";
  toggle.textContent = "Show thinking";

  const wrap = document.createElement("div");
  wrap.className = "dialogue-thinking-wrap hidden";

  const pre = document.createElement("pre");
  pre.className = "dialogue-thinking-content";
  pre.textContent = reasoning;
  wrap.appendChild(pre);

  toggle.addEventListener("click", () => {
    wrap.classList.toggle("hidden");
    toggle.textContent = wrap.classList.contains("hidden") ? "Show thinking" : "Hide thinking";
  });

  bubble.appendChild(toggle);
  bubble.appendChild(wrap);
}

function assistantTurnFromCompletion(msg, choice) {
  return {
    role: "assistant",
    content: formatAssistantDisplayContent(msg, choice),
    ...(assistantReasoningFromMessage(msg) ? { reasoning: assistantReasoningFromMessage(msg) } : {}),
  };
}

function formatDialogueTokenCount(n) {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function dialogueContextLimit(est) {
  if (!est || est.error) return null;
  return est.effectiveMaxContext ?? est.trainedMaxContext ?? null;
}

/** Reflects context usage into the bar under the input (local ONNX / WebLLM). */
function renderDialogueContextBar() {
  const bar = $("#dialogue-context-bar");
  if (!bar) return;
  const provider = getSettings().provider || "onnx";
  const est = dialogueContextEstimate;
  const limit = dialogueContextLimit(est);
  if ((provider !== "onnx" && provider !== "webllm") || !est || est.error || limit == null) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");

  const used = (dialogueLastUsage?.prompt_tokens ?? 0) + (dialogueLastUsage?.completion_tokens ?? 0);
  const pct = Math.min(100, (used / limit) * 100);
  const fill = $("#dialogue-context-fill");
  fill.style.width = `${pct}%`;
  const memoryBinds =
    est.effectiveMaxContext != null && est.trainedMaxContext != null && est.effectiveMaxContext < est.trainedMaxContext;
  fill.classList.toggle("warn", pct >= 90 || (memoryBinds && pct >= 75));

  const wasmCap = provider === "onnx" && est.bindingConstraint === "wasm" ? ", WASM 4GB cap" : "";
  const limitLabel = memoryBinds
    ? `~${formatDialogueTokenCount(limit)} tokens (model max ${formatDialogueTokenCount(est.trainedMaxContext)}${wasmCap})`
    : `${formatDialogueTokenCount(limit)} tokens`;
  $("#dialogue-context-label").textContent = `Context: ${formatDialogueTokenCount(used)} / ${limitLabel}`;
  bar.title = (est.caveats || []).join("\n");
}

/** Fetch context estimate for the active local dialogue model, then render. */
async function refreshDialogueContextEstimate() {
  const provider = getSettings().provider || "onnx";
  if (provider !== "onnx" && provider !== "webllm") {
    dialogueContextEstimate = null;
    dialogueContextEstimateModelId = null;
    renderDialogueContextBar();
    return;
  }
  const modelId = provider === "webllm" ? getSettings().webllmModel || "" : getSettings().onnxModel || "";
  if (!modelId) {
    dialogueContextEstimate = null;
    dialogueContextEstimateModelId = null;
    renderDialogueContextBar();
    return;
  }
  if (dialogueContextEstimateModelId === modelId && dialogueContextEstimate) {
    renderDialogueContextBar();
    return;
  }
  try {
    const relay = provider === "webllm" ? "webllm.relay" : "onnx.relay";
    const est = await sendMessage({ type: relay, engineType: "engine.contextEstimate", model: modelId });
    dialogueContextEstimate = est || null;
    dialogueContextEstimateModelId = modelId;
  } catch {
    dialogueContextEstimate = null;
    dialogueContextEstimateModelId = null;
  }
  renderDialogueContextBar();
}

async function refreshDialogueModelSelect() {
  const select = $("#dialogue-model-select");
  if (!select) return;

  const provider = getSettings().provider || "onnx";
  let options = [];
  let selected = "";
  const downloaded = getDownloadedModels();

  function downloadedLlmModels() {
    return llmModels().filter((m) => downloaded[m.id]);
  }

  if (provider === "onnx") {
    if (getRegistry().length === 0) {
      try {
        const modelsRes = await sendMessage({ type: "onnx.relay", engineType: "engine.models" });
        if (modelsRes?.models?.length) setRegistry(modelsRes.models);
      } catch {
        // engine may not be started yet
      }
    }
    const models = downloadedLlmModels();
    options = models.map((m) => ({ id: m.id, label: `${m.label} (${modelMetaLabel(m)})` }));
    const settingsModel = getSettings().onnxModel || "";
    selected =
      (settingsModel && downloaded[settingsModel] ? settingsModel : "") ||
      models.find((m) => m.tier === "default")?.id ||
      models[0]?.id ||
      "";
  } else if (provider === "webllm") {
    if (getRegistry().length === 0) {
      try {
        const modelsRes = await sendMessage({ type: "webllm.relay", engineType: "engine.models" });
        if (modelsRes?.models?.length) setRegistry(modelsRes.models);
      } catch {
        // engine may not be started yet
      }
    }
    const models = downloadedLlmModels();
    options = models.map((m) => ({
      id: m.id,
      label: webllmPickerLabel ? webllmPickerLabel(m) : `${m.label} (${modelMetaLabel(m)})`,
    }));
    const settingsModel = getSettings().webllmModel || "";
    selected =
      (settingsModel && downloaded[settingsModel] ? settingsModel : "") ||
      models.find((m) => m.tier === "default")?.id ||
      models[0]?.id ||
      "";
  } else if (provider === "ollama") {
    const all = await listOllamaModels();
    options = all.filter((m) => downloaded[m.id]);
    const settingsModel = getSettings().model || "";
    selected =
      resolveOllamaInstalledName(
        settingsModel,
        options.map((m) => m.id)
      ) ||
      options[0]?.id ||
      "";
  } else if (provider === "nvidia-nim") {
    options = listNvidiaNimModels().map((m) => ({ id: m.id, label: m.label }));
    const settingsModel = getSettings().model || "";
    selected = settingsModel || DEFAULT_NVIDIA_NIM_MODEL;
  } else if (provider === "gemini") {
    options = listGeminiModels().map((m) => ({ id: m.id, label: formatGeminiPickerLabel(m) }));
    const settingsModel = getSettings().model || "";
    selected = resolveGeminiModel(settingsModel || DEFAULT_GEMINI_MODEL).model;
  } else if (provider === "openai") {
    options = listOpenAiFlagshipModels().map((m) => ({ id: m.id, label: formatOpenAiPickerLabel(m) }));
    const settingsModel = getSettings().model || "";
    selected = resolveOpenAiModel(settingsModel || DEFAULT_OPENAI_MODEL).model;
  } else {
    const m = getSettings().model || "";
    if (m) options = [{ id: m, label: m }];
    selected = m;
  }

  const prev = select.value;
  select.innerHTML = "";

  if (options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent =
      provider === "ollama"
        ? "No pulled models — open Settings"
        : provider === "onnx" || provider === "webllm"
          ? "No downloaded models — open Settings"
          : "Set model in Settings";
    select.appendChild(opt);
    select.disabled = true;
    updateDialogueAttachUI();
    return;
  }

  select.disabled =
    provider !== "onnx" &&
    provider !== "webllm" &&
    provider !== "ollama" &&
    provider !== "nvidia-nim" &&
    provider !== "gemini" &&
    provider !== "openai";
  if (
    (provider === "ollama" ||
      provider === "openai" ||
      provider === "anthropic" ||
      provider === "openai-compatible" ||
      provider === "nvidia-nim" ||
      provider === "gemini") &&
    selected &&
    !options.some((o) => o.id === selected)
  ) {
    options = [{ id: selected, label: selected.split("/").pop() }, ...options];
  }
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.label;
    opt.title = o.label;
    select.appendChild(opt);
  }
  select.value = selected || options[0].id;
  // Avoid clobbering a mid-change selection if the list rebuild races
  if (prev && options.some((o) => o.id === prev) && document.activeElement === select) {
    select.value = prev;
  }

  const chosen = select.value;
  if (provider === "onnx" && chosen && getSettings().onnxModel !== chosen) {
    await saveSettings({ onnxModel: chosen });
  } else if (provider === "webllm" && chosen && getSettings().webllmModel !== chosen) {
    await saveSettings({ webllmModel: chosen });
  }

  updateDialogueAttachUI();
}

async function onDialogueModelChange(e) {
  const select = e.target;
  const modelId = select.value;
  if (!modelId) return;
  const provider = getSettings().provider || "onnx";
  const previous =
    provider === "onnx"
      ? getSettings().onnxModel || ""
      : provider === "webllm"
        ? getSettings().webllmModel || ""
        : getSettings().model || "";

  if (provider === "onnx") {
    if (!getDownloadedModels()[modelId]) {
      if (!confirmLocalModelDownload(modelId)) {
        select.value = previous;
        return;
      }
    }
    await saveSettings({ onnxModel: modelId });
    const entry = llmModels().find((m) => m.id === modelId);
    startDownload(modelId, entry?.task || "text-generation");
  } else if (provider === "webllm") {
    if (!getDownloadedModels()[modelId]) {
      if (!confirmLocalModelDownload(modelId)) {
        select.value = previous;
        return;
      }
    }
    await saveSettings({ webllmModel: modelId });
    startDownload(modelId);
  } else if (provider === "ollama") {
    if (!getDownloadedModels()[modelId]) {
      if (!confirmLocalModelDownload(modelId)) {
        select.value = previous;
        return;
      }
      await saveSettings({ model: modelId });
      startDownload(modelId);
    } else {
      await saveSettings({ model: modelId });
    }
  } else {
    await saveSettings({ model: modelId });
    const modelInput = $("#model-name");
    if (modelInput) modelInput.value = modelId;
  }
  notifyDialogueInputChanged();
}

/** Ask before fetching weights that are not yet in IndexedDB. */
function confirmLocalModelDownload(modelId) {
  const entry = getRegistry().find((m) => m.id === modelId);
  const label = entry?.label || modelId.split("/").pop();
  const provider = getSettings().provider || "onnx";
  const meta = entry
    ? provider === "webllm" && webllmMetaLabel
      ? webllmMetaLabel(entry)
      : provider === "ollama" && ollamaMetaLabel
        ? ollamaMetaLabel(entry)
        : entry.contextWindow
          ? `${formatDialogueTokenCount(entry.contextWindow)} ctx`
          : modelMetaLabel(entry)
    : "unknown size";
  const verb = provider === "ollama" ? "pulled" : "downloaded";
  const action = provider === "ollama" ? "Pull" : "Download";
  return confirm(
    `"${label}" is not ${verb} yet (${meta}).\n\n${action} it now? This uses the network and may take a few minutes.`
  );
}

/** @deprecated use confirmLocalModelDownload */
function confirmOnnxDownload(modelId) {
  return confirmLocalModelDownload(modelId);
}

/** Whether the current dialogue model can take image input. */
function dialogueModelSupportsImages() {
  const provider = getSettings().provider || "onnx";
  if (provider === "onnx") {
    const modelId = $("#dialogue-model-select")?.value || getSettings().onnxModel || "";
    return getRegistry().find((m) => m.id === modelId)?.task === "image-text-to-text";
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
  notifyDialogueInputChanged();
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
      notifyDialogueInputChanged();
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
    bubble.className = `dialogue-bubble ${turn.role}${turn.toolCall ? " tool-call" : ""}${turn.pending ? " pending" : ""}`;

    if (turn.role === "tool") {
      const header = document.createElement("div");
      header.className = "dialogue-turn-label tool-result";
      header.textContent = turn.pending ? `Tool result · ${turn.toolName}…` : `Tool result · ${turn.toolName}`;
      bubble.appendChild(header);

      if (!turn.pending) {
        const resultEl = document.createElement("pre");
        resultEl.className = "dialogue-tool-call-result";
        resultEl.textContent = turn.content || (turn.error ? `Error: ${turn.error}` : "");
        bubble.appendChild(resultEl);
        if (turn.citations?.length) renderCitationChips(turn.citations, bubble);
      } else {
        const pendingEl = document.createElement("div");
        pendingEl.className = "dialogue-tool-pending";
        pendingEl.textContent = "Running…";
        bubble.appendChild(pendingEl);
      }

      if (turn.raw) appendDialogueRawPanel(bubble, turn.raw);
      chat.appendChild(bubble);
      continue;
    }

    if (turn.toolCall) {
      const label = document.createElement("div");
      label.className = "dialogue-turn-label tool-request";
      label.textContent = "Tool request";
      bubble.appendChild(label);
    }

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
    if (turn.citations?.length) renderCitationChips(turn.citations, bubble);
    if (turn.reasoning) appendDialogueThinkingBlock(bubble, turn.reasoning);

    if (turn.raw) appendDialogueRawPanel(bubble, turn.raw);

    chat.appendChild(bubble);
  }
  chat.scrollTop = chat.scrollHeight;
}

/** Expandable raw I/O panel with JSON vs chat-template Prompt modes. */
function appendDialogueRawPanel(bubble, raw) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dialogue-raw-toggle";
  toggle.textContent = "Show raw";

  const wrap = document.createElement("div");
  wrap.className = "dialogue-raw-wrap hidden";

  const jsonRoot = document.createElement("div");
  jsonRoot.className = "dialogue-raw-json-root";

  const promptPanel = document.createElement("pre");
  promptPanel.className = "dialogue-raw-panel hidden";

  let mode = "json";
  const { modes, syncActive } = createDialogueRawModeSwitcher({
    getMode: () => mode,
    setMode: (m) => {
      mode = m;
    },
    onModeChange: () => renderDialogueRawPanelContent(jsonRoot, promptPanel, raw, mode),
  });
  syncActive();
  renderDialogueRawPanelContent(jsonRoot, promptPanel, raw, mode);

  toggle.addEventListener("click", () => {
    wrap.classList.toggle("hidden");
    toggle.textContent = wrap.classList.contains("hidden") ? "Show raw" : "Hide raw";
  });

  wrap.appendChild(modes);
  wrap.appendChild(jsonRoot);
  wrap.appendChild(promptPanel);
  bubble.appendChild(toggle);
  bubble.appendChild(wrap);
}

async function sendDialogue() {
  if (dialogueSending) return;
  const input = $("#dialogue-input");
  const text = input.value.trim();
  const images = dialogueImages.slice();

  if (
    dialogueInputPreviewMode === "json" &&
    dialogueInputJsonViewMode === "edit" &&
    isDialogueInputPreviewOpen()
  ) {
    const editEl = $("#dialogue-preview-json-edit");
    if (editEl?.value.trim()) {
      const { data, error } = parseDialogueRawPayload(editEl.value);
      if (error) {
        alert(error);
        $("#dialogue-preview-wrap")?.classList.remove("hidden");
        return;
      }
      dialogueInputPayloadOverride = data;
      dialogueInputJsonDirty = false;
    }
  }

  let messages;
  let tools;
  let userTurn;

  if (dialogueInputPayloadOverride) {
    messages = structuredClone(dialogueInputPayloadOverride.messages);
    tools = structuredClone(dialogueInputPayloadOverride.tools ?? []);
    const lastUser = findLastUserMessage(messages);
    if (!lastUser) {
      alert("Custom payload must include at least one user message.");
      return;
    }
    userTurn = userTurnFromMessage(lastUser);
  } else {
    if (!text && images.length === 0) return;

    const userTools = syncDialogueToolsFromUi();
    if (userTools === null) {
      $("#dialogue-tools-wrap").classList.remove("hidden");
      return;
    }

    tools = await buildDialogueTools(userTools);
    const mcpToolNames = tools.map((t) => t.function?.name).filter(Boolean);
    userTurn = { role: "user", content: text, images };
    const systemMessages = buildDialogueSystemMessages(mcpToolNames);
    messages = [
      ...systemMessages,
      ...turnsToChatMessages(dialogueTurns),
      turnToMessage(userTurn),
    ];
  }

  const hasWebSearchTool = tools.some((t) => t.function?.name === "web_search");
  if (hasWebSearchTool && isDialogueWebSearchEnabled() && !getSettings().tavilyApiKey?.trim()) {
    if (
      !confirm(
        "Web search is enabled but no Tavily API key is set in Settings. " +
          "The model can still request web_search, but results will fail until you add a key. Continue?"
      )
    ) {
      return;
    }
  }

  const provider = getSettings().provider || "onnx";
  if (provider === "onnx" && getSettings().onnxModel && !getDownloadedModels()[getSettings().onnxModel]) {
    if (!confirmLocalModelDownload(getSettings().onnxModel)) return;
  }
  if (provider === "webllm" && getSettings().webllmModel && !getDownloadedModels()[getSettings().webllmModel]) {
    if (!confirmLocalModelDownload(getSettings().webllmModel)) return;
  }

  dialogueTriggerQuery = String(userTurn.content || "").trim();
  userTurn.raw = snapshotDialogueRawInput(messages, tools);
  dialogueTurns.push(userTurn);
  input.value = "";
  dialogueImages = [];
  renderDialogueAttachments();
  clearDialogueInputPayloadOverride();
  dialogueInputJsonDirty = false;
  dialogueInputJsonViewMode = "edit";
  renderDialogue();

  dialogueSending = true;
  const btn = $("#dialogue-send-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  let gotAssistantReply = false;

  try {
    const maxToolRounds = getDialogueMaxToolRounds(getSettings());
    for (let round = 0; round < maxToolRounds; round++) {
      btn.textContent = round === 0 ? "Sending…" : "Thinking…";
      const inputRaw = snapshotDialogueRawInput(messages, tools);
      const res = await dialogueChatCompletion(messages, tools);
      if (res?.error) throw new Error(res.error.message);
      noteWebllmContextTrim(res);
      if (res.usage) {
        dialogueLastUsage = res.usage;
        renderDialogueContextBar();
      }

      const choice = res.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      if (round === 0 && typeof res?.prompt === "string") userTurn.raw.prompt = res.prompt;

      let calls = normalizeAssistantToolCalls(msg, tools);
      if (!calls.length && choice.rawMessage) {
        const rawText = [
          choice.rawMessage.content,
          choice.rawMessage.thinking,
          choice.rawMessage.reasoning,
          choice.rawMessage.reasoning_content,
        ]
          .filter((x) => typeof x === "string" && x.trim())
          .join("\n");
        calls = normalizeAssistantToolCalls(
          { content: rawText, tool_calls: choice.rawMessage.tool_calls },
          tools
        );
      }
      if (!calls.length) {
        dialogueTurns.push({
          ...assistantTurnFromCompletion(msg, choice),
          raw: buildDialogueRawFromCompletion(inputRaw, res),
        });
        gotAssistantReply = true;
        break;
      }

      calls = resolveDialogueToolCalls(calls, dialogueTriggerQuery);
      const callDisplay = formatAssistantToolCallDisplay(msg, calls);
      dialogueTurns.push({
        role: "assistant",
        content: callDisplay,
        toolCall: true,
        raw: buildDialogueRawFromCompletion(inputRaw, res),
      });
      renderDialogue();

      const nativeCalls = calls.filter((c) => c.source === "native");
      const textCalls = calls.filter((c) => c.source === "text");

      if (nativeCalls.length) {
        const assistantMsg = {
          role: "assistant",
          content: msg.content || null,
          tool_calls: nativeCalls.map((c) => toOpenAiToolCall(c)),
        };
        if (Array.isArray(msg.gemini_parts) && msg.gemini_parts.length) {
          assistantMsg.gemini_parts = msg.gemini_parts;
        }
        messages.push(assistantMsg);
      } else {
        messages.push({ role: "assistant", content: msg.content || callDisplay });
      }

      const textResultBlocks = [];
      for (const call of calls) {
        const { resultText } = await executeDialogueToolTurn(call, btn);
        if (call.source === "native") {
          messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
        } else {
          textResultBlocks.push(`Tool ${call.name} result:\n${resultText}`);
        }
      }

      if (textCalls.length) {
        messages.push({ role: "user", content: textResultBlocks.join("\n\n") });
      }
    }

    if (!gotAssistantReply) {
      btn.textContent = "Sending…";
      const inputRaw = snapshotDialogueRawInput(messages, tools);
      const res = await dialogueChatCompletion(messages, tools);
      if (res?.error) throw new Error(res.error.message);
      noteWebllmContextTrim(res);
      if (res.usage) {
        dialogueLastUsage = res.usage;
        renderDialogueContextBar();
      }
      const finalChoice = res.choices?.[0] ?? {};
      const finalMsg = finalChoice.message ?? {};
      let turn = assistantTurnFromCompletion(finalMsg, finalChoice);
      if (turn.content === "(empty response)") turn = { ...turn, content: "(stopped: tool round limit)" };
      dialogueTurns.push({
        ...turn,
        raw: buildDialogueRawFromCompletion(inputRaw, res),
      });
    }
  } catch (err) {
    dialogueTurns.push({ role: "assistant", content: `✗ ${err.message}` });
  } finally {
    renderDialogue();
    await persistDialogueSession();
    dialogueSending = false;
    btn.disabled = false;
    btn.textContent = "Send";
  }
}

