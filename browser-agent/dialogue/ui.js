// Dialogue tab: chat UI, sessions, tool loop, and Tavily web search.

import {
  deleteDialogueSession,
  getDialogueSession,
  listDialogueSessions,
  putDialogueSession,
} from "../system-store.js";
import {
  PARAM_TYPES,
  draftsToOpenAiTools,
  draftsToToolsJson,
  emptyParamDraft,
  emptyToolDraft,
  openAiToolsToDrafts,
} from "../tools/schema.js";
import {
  formatAssistantToolCallDisplay,
  MCP_TOOL_HINT,
  normalizeAssistantToolCalls,
  toOpenAiToolCall,
} from "./tool-runtime.js";

const DIALOGUE_MAX_TOOL_ROUNDS = 5;
/** Keep tool payloads small — large HTML + local ONNX (esp. WebGPU) can OOM or crash the next inference. */
const DIALOGUE_TOOL_RESULT_CHARS = 8000;
const DIALOGUE_HTML_FIELD_CHARS = 6000;

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
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  if (text.length <= DIALOGUE_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, DIALOGUE_TOOL_RESULT_CHARS)}\n...[truncated for LLM context]`;
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
let startDownload;
let formatTime;
let escapeHtml;

let dialogueSystemPrompt = "";
let dialogueToolDrafts = [];
let dialogueTurns = [];
let dialogueImages = [];
let dialogueSending = false;
let dialogueSessionId = null;

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
  startDownload = deps.startDownload;
  formatTime = deps.formatTime;
  escapeHtml = deps.escapeHtml;

  return {
    wire,
    onTabActivate() {
      refreshDialogueModelSelect();
      refreshDialogueSessionsList();
    },
    onSettingsChanged() {
      refreshDialogueModelSelect();
      syncDialogueMcpTogglesFromSettings();
      renderDialogueToolsForm();
    },
  };
}

function wire() {
  $("#dialogue-sessions-toggle").addEventListener("click", () => {
    const panel = $("#dialogue-sessions-panel");
    const collapsed = panel.classList.toggle("collapsed");
    $("#dialogue-sessions-toggle").setAttribute("aria-expanded", String(!collapsed));
    if (!collapsed) refreshDialogueSessionsList();
  });
  $("#dialogue-new-btn").addEventListener("click", () => startNewDialogueSession());
  $("#dialogue-system-toggle").addEventListener("click", () => {
    $("#dialogue-system-wrap").classList.toggle("hidden");
  });
  $("#dialogue-system-input").addEventListener("input", (e) => {
    dialogueSystemPrompt = e.target.value;
  });
  $("#dialogue-tools-toggle").addEventListener("click", () => {
    const wrap = $("#dialogue-tools-wrap");
    wrap.classList.toggle("hidden");
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
    });
  }
  const browserToolsCb = $("#dialogue-browser-tools-enabled");
  if (browserToolsCb) {
    browserToolsCb.addEventListener("change", (e) => {
      saveSettings({ dialogueBrowserTools: e.target.checked });
      renderDialogueToolsForm();
    });
  }
  renderDialogue();
  renderDialogueToolsForm();
  refreshDialogueModelSelect();
  refreshDialogueSessionsList();
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
    $("#dialogue-system-input").value = dialogueSystemPrompt;
    clearDialogueToolsError();
    renderDialogueToolsForm();
    renderDialogueAttachments();
    renderDialogue();
    await refreshDialogueSessionsList();
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
  $("#dialogue-system-input").value = "";
  clearDialogueToolsError();
  renderDialogueToolsForm();
  renderDialogueAttachments();
  renderDialogue();
  refreshDialogueSessionsList();
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
}

function dialogueMcpSettingsOverrides() {
  return {
    dialogueWebSearch: isDialogueWebSearchEnabled(),
    dialogueBrowserTools: isDialogueBrowserToolsEnabled(),
  };
}

async function fetchMcpDialogueTools() {
  const res = await sendMessage({
    type: "mcp.tools.list",
    groups: ["dialogue"],
    settings: dialogueMcpSettingsOverrides(),
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
  const parts = [];
  if (dialogueSystemPrompt.trim()) parts.push(dialogueSystemPrompt.trim());
  if (mcpToolNames.length) {
    parts.push(`${MCP_TOOL_HINT}\nAvailable MCP tools: ${mcpToolNames.join(", ")}`);
  }
  if (!parts.length) return [];
  return [{ role: "system", content: parts.join("\n\n") }];
}

async function runDialogueTool(name, args) {
  const res = await sendMessage({ type: "dialogue.tool.run", name, args });
  if (res?.error) throw new Error(res.error);
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

function formatDialogueRawJson(raw) {
  const requestPayload =
    raw.request !== undefined
      ? raw.tools?.length > 0
        ? { messages: raw.request, tools: raw.tools }
        : raw.request
      : undefined;

  if (requestPayload !== undefined && raw.response !== undefined) {
    return JSON.stringify({ request: requestPayload, response: raw.response }, null, 2);
  }
  if (requestPayload !== undefined) return JSON.stringify(requestPayload, null, 2);
  if (raw.response !== undefined) return JSON.stringify(raw.response, null, 2);
  const { prompt: _prompt, tools: _tools, ...rest } = raw;
  return JSON.stringify(rest, null, 2);
}

async function executeDialogueToolTurn(call, btn) {
  const toolTurn = {
    role: "tool",
    toolName: call.name,
    args: call.args || {},
    pending: true,
    content: "",
  };
  dialogueTurns.push(toolTurn);
  renderDialogue();

  if (btn) btn.textContent = `Running ${call.name}…`;
  let result = null;
  let errMsg = null;
  try {
    result = await runDialogueTool(call.name, call.args || {});
  } catch (err) {
    errMsg = err.message;
  }

  toolTurn.pending = false;
  toolTurn.result = result;
  toolTurn.error = errMsg;
  toolTurn.content = formatToolTurnDisplay(call.name, result, errMsg);
  renderDialogue();

  const resultText = errMsg ? `Error: ${errMsg}` : stringifyToolResultForLlm(call.name, result);
  return { toolTurn, resultText };
}

async function dialogueChatCompletion(messages, tools) {
  return sendMessage({
    type: "dialogue.send",
    messages,
    ...(tools.length ? { tools } : {}),
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

  const pre = document.createElement("pre");
  pre.className = "dialogue-tool-json";
  pre.textContent = JSON.stringify(tool, null, 2);

  card.appendChild(header);
  card.appendChild(hint);
  card.appendChild(jsonLabel);
  card.appendChild(pre);
  return card;
}

async function renderDialogueToolsForm() {
  const list = $("#dialogue-tools-list");
  if (!list) return;
  list.innerHTML = "";

  const status = $("#dialogue-mcp-status");
  const webOn = isDialogueWebSearchEnabled();
  const browserOn = isDialogueBrowserToolsEnabled();
  if (status) {
    const parts = [];
    if (webOn) parts.push("web search");
    if (browserOn) parts.push("browser automation");
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
    list.appendChild(card);
  });
}

async function listOllamaModels() {
  const base = (getSettings().baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal, targetAddressSpace: "loopback" });
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

  const provider = getSettings().provider || "onnx";
  let options = [];
  let selected = "";

  if (provider === "onnx") {
    if (getRegistry().length === 0) {
      try {
        const modelsRes = await sendMessage({ type: "onnx.relay", engineType: "engine.models" });
        if (modelsRes?.models?.length) setRegistry(modelsRes.models);
      } catch {
        // engine may not be started yet
      }
    }
    options = llmModels().map((m) => ({ id: m.id, label: `${m.label} (${modelMetaLabel(m)})` }));
    selected =
      getSettings().onnxModel ||
      llmModels().find((m) => m.tier === "default")?.id ||
      options[0]?.id ||
      "";
  } else if (provider === "ollama") {
    options = await listOllamaModels();
    selected = getSettings().model || options[0]?.id || "";
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
  const provider = getSettings().provider || "onnx";
  const previous = provider === "onnx" ? getSettings().onnxModel || "" : getSettings().model || "";

  if (provider === "onnx") {
    if (!getDownloadedModels()[modelId]) {
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
  const entry = getRegistry().find((m) => m.id === modelId);
  const label = entry?.label || modelId.split("/").pop();
  const meta = entry ? modelMetaLabel(entry) : "unknown size";
  return confirm(
    `"${label}" is not downloaded yet (${meta}).\n\nDownload it now? This uses the network and may take a few minutes.`
  );
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

  const panel = document.createElement("pre");
  panel.className = "dialogue-raw-panel";

  let mode = "json";
  const renderPanel = () => {
    if (mode === "prompt") {
      // Processed chat-template string (ONNX tokenizer or Ollama _debug_render_only).
      panel.textContent =
        typeof raw.prompt === "string" && raw.prompt.length > 0
          ? raw.prompt
          : "(No processed prompt for this turn. ONNX and Ollama fill this after a reply; other API providers send JSON only.)";
    } else {
      // Original JSON input (messages ± tools) and/or assistant response — never the processed prompt.
      panel.textContent = formatDialogueRawJson(raw);
    }
    jsonBtn.classList.toggle("active", mode === "json");
    promptBtn.classList.toggle("active", mode === "prompt");
  };
  renderPanel();

  jsonBtn.addEventListener("click", () => {
    mode = "json";
    renderPanel();
  });
  promptBtn.addEventListener("click", () => {
    mode = "prompt";
    renderPanel();
  });
  toggle.addEventListener("click", () => {
    wrap.classList.toggle("hidden");
    toggle.textContent = wrap.classList.contains("hidden") ? "Show raw" : "Hide raw";
  });

  wrap.appendChild(modes);
  wrap.appendChild(panel);
  bubble.appendChild(toggle);
  bubble.appendChild(wrap);
}

async function sendDialogue() {
  if (dialogueSending) return;
  const input = $("#dialogue-input");
  const text = input.value.trim();
  const images = dialogueImages.slice();
  if (!text && images.length === 0) return;

  const userTools = syncDialogueToolsFromUi();
  if (userTools === null) {
    $("#dialogue-tools-wrap").classList.remove("hidden");
    return;
  }

  const tools = await buildDialogueTools(userTools);
  const mcpToolNames = tools.map((t) => t.function?.name).filter(Boolean);
  if (isDialogueWebSearchEnabled() && !getSettings().tavilyApiKey?.trim()) {
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
    if (!confirmOnnxDownload(getSettings().onnxModel)) return;
  }

  const userTurn = { role: "user", content: text, images };
  let messages = [
    ...buildDialogueSystemMessages(mcpToolNames),
    ...turnsToChatMessages(dialogueTurns),
    turnToMessage(userTurn),
  ];

  userTurn.raw = snapshotDialogueRawInput(messages, tools);
  dialogueTurns.push(userTurn);
  input.value = "";
  dialogueImages = [];
  renderDialogueAttachments();
  renderDialogue();

  dialogueSending = true;
  const btn = $("#dialogue-send-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  let gotAssistantReply = false;

  try {
    for (let round = 0; round < DIALOGUE_MAX_TOOL_ROUNDS; round++) {
      btn.textContent = round === 0 ? "Sending…" : "Thinking…";
      const inputRaw = snapshotDialogueRawInput(messages, tools);
      const res = await dialogueChatCompletion(messages, tools);
      if (res?.error) throw new Error(res.error.message);

      const msg = res.choices?.[0]?.message ?? {};
      if (round === 0 && typeof res?.prompt === "string") userTurn.raw.prompt = res.prompt;

      const calls = normalizeAssistantToolCalls(msg, tools);
      if (!calls.length) {
        dialogueTurns.push({
          role: "assistant",
          content: msg.content || "(empty response)",
          raw: buildDialogueRawFromCompletion(inputRaw, res),
        });
        gotAssistantReply = true;
        break;
      }

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
        messages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: nativeCalls.map(toOpenAiToolCall),
        });
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
      const content = res.choices?.[0]?.message?.content || "(stopped: tool round limit)";
      dialogueTurns.push({
        role: "assistant",
        content,
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

