// Flow tab: session picker, ordered node cards, run controls.

import {
  BUILTIN_WEATHER_TAIPEI_ID,
  addFlowNode,
  createFlowSession,
  deleteFlowNode,
  deleteFlowSession,
  ensureFlowSeeded,
  getFlowSession,
  listFlowSessions,
  reorderFlowNodes,
  writeFlowNode,
} from "./flow-store.js";
import { assistantTextFromCompletion, createFlowApi, executeFlowNode } from "./runner.js";

const SAVE_DEBOUNCE_MS = 400;

export function createFlowPanel({ $, sendMessage, onFlowChanged } = {}) {
  let sessions = [];
  let currentFlowId = null;
  let session = null;
  let saveTimers = new Map();
  let running = false;

  function notifyChanged() {
    onFlowChanged?.();
  }

  function getCurrentFlowId() {
    return currentFlowId;
  }

  async function persistCurrentFlowId(id) {
    currentFlowId = id;
    await chrome.storage.local.set({ currentFlowId: id || "" });
    notifyChanged();
  }

  function setRunBusy(busy) {
    running = busy;
    const runBtn = $("#flow-run-btn");
    if (runBtn) runBtn.disabled = busy || !currentFlowId;
    $("#flow-nodes")?.querySelectorAll("[data-run-node]").forEach((btn) => {
      btn.disabled = busy;
    });
  }

  function buildPanelApi(nodeModel = "") {
    return createFlowApi({
      model: nodeModel,
      callTool: async (name, args) => {
        const res = await sendMessage({
          type: "dialogue.tool.run",
          name,
          args: args || {},
          settings: {
            dialogueBrowserTools: true,
            dialogueWebSearch: false,
            dialogueRagTools: false,
            dialogueWebAppTools: false,
            dialogueFlowTools: false,
          },
        });
        if (res?.error) {
          const err = res.error;
          throw new Error(typeof err === "string" ? err : err?.message || String(err));
        }
        return res?.result;
      },
      llm: async (prompt, model) => {
        const res = await sendMessage({
          type: "dialogue.send",
          messages: [{ role: "user", content: prompt }],
          ...(model ? { model } : {}),
        });
        return assistantTextFromCompletion(res);
      },
    });
  }

  async function refreshSessions() {
    await ensureFlowSeeded();
    sessions = await listFlowSessions();
    const stored = await chrome.storage.local.get("currentFlowId");
    let nextId = stored.currentFlowId || currentFlowId;
    if (!nextId || !sessions.some((s) => s.id === nextId)) {
      nextId = sessions.find((s) => s.id === BUILTIN_WEATHER_TAIPEI_ID)?.id || sessions[0]?.id || null;
    }
    currentFlowId = nextId;
    await chrome.storage.local.set({ currentFlowId: nextId || "" });
    renderSessionSelect();
    await loadSession(currentFlowId);
    notifyChanged();
  }

  function renderSessionSelect() {
    const sel = $("#flow-session-select");
    if (!sel) return;
    sel.innerHTML = "";
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.isBuiltin ? `${s.title} (builtin)` : s.title;
      sel.appendChild(opt);
    }
    if (currentFlowId) sel.value = currentFlowId;
  }

  async function loadSession(id) {
    session = id ? await getFlowSession(id) : null;
    renderNodes();
  }

  function scheduleNodeSave(nodeId, patchBuilder) {
    const prev = saveTimers.get(nodeId);
    if (prev) clearTimeout(prev);
    saveTimers.set(
      nodeId,
      setTimeout(() => {
        saveTimers.delete(nodeId);
        flushNodeSave(nodeId, patchBuilder).catch((err) => console.error("[flow] save failed", err));
      }, SAVE_DEBOUNCE_MS)
    );
  }

  async function flushNodeSave(nodeId, patchBuilder) {
    if (!currentFlowId || !session) return;
    const card = $("#flow-nodes")?.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!card) return;
    const patch = patchBuilder(card);
    const { session: updated } = await writeFlowNode(currentFlowId, nodeId, patch);
    session = updated;
  }

  function parseInputsJson(text, fallback = {}) {
    const raw = String(text || "").trim();
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      throw new Error("inputs must be a JSON object");
    } catch (err) {
      throw new Error(err.message || "Invalid inputs JSON");
    }
  }

  function formatJson(value) {
    if (value == null) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function renderNodes() {
    const root = $("#flow-nodes");
    if (!root) return;
    root.innerHTML = "";
    if (!session) {
      const empty = document.createElement("p");
      empty.className = "flow-hint";
      empty.textContent = "Select or create a Flow session.";
      root.appendChild(empty);
      return;
    }

    session.nodes.forEach((node, index) => {
      root.appendChild(createNodeCard(node, index));
    });
  }

  function patchFromCard(card) {
    return {
      title: card.querySelector(".flow-node-title")?.value || "",
      model: card.querySelector(".flow-node-model")?.value || "",
      inputs: safeInputsFromCard(card),
      script: card.querySelector(".flow-node-script")?.value || "",
    };
  }

  function dialogueModelOptions() {
    const select = $("#dialogue-model-select");
    const opts = [];
    if (!select) return opts;
    for (const o of select.options) {
      if (o.value) opts.push({ id: o.value, label: o.textContent || o.value });
    }
    return opts;
  }

  function fillNodeModelSelect(select, selectedModel) {
    const options = dialogueModelOptions();
    const selected = selectedModel != null ? String(selectedModel) : "";
    select.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Default (dialogue)";
    select.appendChild(def);
    for (const m of options) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      select.appendChild(opt);
    }
    if (selected && !options.some((m) => m.id === selected)) {
      const opt = document.createElement("option");
      opt.value = selected;
      opt.textContent = `${selected} (saved)`;
      select.appendChild(opt);
    }
    select.value = selected && [...select.options].some((o) => o.value === selected) ? selected : "";
  }

  function createNodeCard(node, index) {
    const card = document.createElement("article");
    card.className = `flow-node-card status-${node.status || "idle"}`;
    card.dataset.nodeId = node.id;

    const header = document.createElement("div");
    header.className = "flow-node-header";

    const order = document.createElement("span");
    order.className = "flow-node-order";
    order.textContent = String(index + 1);

    const title = document.createElement("input");
    title.type = "text";
    title.className = "flow-node-title";
    title.value = node.title || "";
    title.placeholder = "Node title";
    title.addEventListener("input", () => {
      scheduleNodeSave(node.id, patchFromCard);
    });

    const status = document.createElement("span");
    status.className = "flow-node-status";
    status.textContent = node.status || "idle";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "secondary-btn";
    runBtn.dataset.runNode = node.id;
    runBtn.title = "Run this node";
    runBtn.textContent = "▶";
    runBtn.addEventListener("click", () => {
      runOneNode(node.id).catch((err) => alert(err.message || String(err)));
    });

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "icon-btn";
    upBtn.title = "Move up";
    upBtn.textContent = "↑";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => moveNode(node.id, -1));

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "icon-btn";
    downBtn.title = "Move down";
    downBtn.textContent = "↓";
    downBtn.disabled = index >= (session?.nodes.length || 0) - 1;
    downBtn.addEventListener("click", () => moveNode(node.id, 1));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn";
    delBtn.title = "Delete node";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete node "${node.title || node.id}"?`)) return;
      session = (await deleteFlowNode(currentFlowId, node.id)).session;
      renderNodes();
    });

    header.append(order, title, status, runBtn, upBtn, downBtn, delBtn);

    const modelRow = document.createElement("div");
    modelRow.className = "flow-node-model-row";
    const modelLabel = document.createElement("label");
    modelLabel.className = "flow-field-label";
    modelLabel.textContent = "LLM model (api.llm)";
    const modelSelect = document.createElement("select");
    modelSelect.className = "flow-node-model";
    modelSelect.title = "Model for api.llm — same provider/backend as dialogue; empty uses dialogue default";
    fillNodeModelSelect(modelSelect, node.model || "");
    modelSelect.addEventListener("change", () => {
      scheduleNodeSave(node.id, patchFromCard);
    });
    modelRow.append(modelLabel, modelSelect);

    const inputsLabel = document.createElement("label");
    inputsLabel.className = "flow-field-label";
    inputsLabel.textContent = "Inputs (JSON)";
    const inputs = document.createElement("textarea");
    inputs.className = "flow-node-inputs";
    inputs.spellcheck = false;
    inputs.rows = 3;
    inputs.value = formatJson(node.inputs || {});
    inputs.addEventListener("input", () => {
      scheduleNodeSave(node.id, patchFromCard);
    });

    const scriptLabel = document.createElement("label");
    scriptLabel.className = "flow-field-label";
    scriptLabel.textContent = "Script (async JS — inputs, outputs, api)";
    const script = document.createElement("textarea");
    script.className = "flow-node-script";
    script.spellcheck = false;
    script.rows = 8;
    script.value = node.script || "";
    script.addEventListener("input", () => {
      scheduleNodeSave(node.id, patchFromCard);
    });

    const outputsLabel = document.createElement("label");
    outputsLabel.className = "flow-field-label";
    outputsLabel.textContent = "Outputs";
    const outputs = document.createElement("pre");
    outputs.className = "flow-node-outputs";
    outputs.textContent = formatJson(node.outputs) || "(none)";

    const err = document.createElement("p");
    err.className = `flow-node-error${node.error ? "" : " hidden"}`;
    err.textContent = node.error || "";

    card.append(header, modelRow, inputsLabel, inputs, scriptLabel, script, outputsLabel, outputs, err);
    return card;
  }

  function safeInputsFromCard(card) {
    try {
      return parseInputsJson(card.querySelector(".flow-node-inputs")?.value);
    } catch {
      return session?.nodes.find((n) => n.id === card.dataset.nodeId)?.inputs || {};
    }
  }

  async function flushAllPendingSaves() {
    const pending = [...saveTimers.entries()];
    for (const [nodeId, timer] of pending) {
      clearTimeout(timer);
      saveTimers.delete(nodeId);
      await flushNodeSave(nodeId, patchFromCard);
    }
  }

  async function moveNode(nodeId, delta) {
    if (!session) return;
    await flushAllPendingSaves();
    const ids = session.nodes.map((n) => n.id);
    const idx = ids.indexOf(nodeId);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= ids.length) return;
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    session = await reorderFlowNodes(currentFlowId, ids);
    renderNodes();
  }

  async function runOneNode(nodeId) {
    if (!currentFlowId || running) return;
    await flushAllPendingSaves();
    setRunBusy(true);
    try {
      await writeFlowNode(currentFlowId, nodeId, { status: "running", error: null });
      session = await getFlowSession(currentFlowId);
      renderNodes();
      const node = session.nodes.find((n) => n.id === nodeId);
      const result = await executeFlowNode(node, buildPanelApi(node?.model));
      const { session: updated } = await writeFlowNode(currentFlowId, nodeId, {
        outputs: result.outputs,
        status: result.status,
        error: result.error,
      });
      session = updated;
      renderNodes();
      if (result.status === "error") {
        throw new Error(result.error || "Node failed");
      }
    } finally {
      setRunBusy(false);
    }
  }

  async function runSession() {
    if (!currentFlowId || running) return;
    await flushAllPendingSaves();
    setRunBusy(true);
    try {
      session = await getFlowSession(currentFlowId);
      for (const node of session.nodes) {
        await writeFlowNode(currentFlowId, node.id, { status: "running", error: null });
        session = await getFlowSession(currentFlowId);
        renderNodes();
        const fresh = session.nodes.find((n) => n.id === node.id);
        const result = await executeFlowNode(fresh, buildPanelApi(fresh?.model));
        const { session: updated } = await writeFlowNode(currentFlowId, node.id, {
          outputs: result.outputs,
          status: result.status,
          error: result.error,
        });
        session = updated;
        renderNodes();
        if (result.status === "error") {
          throw new Error(`Node "${fresh.title || fresh.id}" failed: ${result.error}`);
        }
      }
    } finally {
      setRunBusy(false);
    }
  }

  function wire() {
    $("#flow-session-select")?.addEventListener("change", async (e) => {
      await flushAllPendingSaves();
      await persistCurrentFlowId(e.target.value);
      await loadSession(currentFlowId);
    });
    $("#flow-add-session-btn")?.addEventListener("click", async () => {
      const name = prompt("Name for the new Flow session:", "My flow");
      if (name == null) return;
      try {
        await flushAllPendingSaves();
        const created = await createFlowSession(name.trim() || "Untitled flow");
        await persistCurrentFlowId(created.id);
        await refreshSessions();
      } catch (err) {
        alert(err.message || String(err));
      }
    });
    $("#flow-delete-session-btn")?.addEventListener("click", async () => {
      const meta = sessions.find((s) => s.id === currentFlowId);
      if (!meta) return;
      if (meta.isBuiltin) {
        alert("Built-in flow sessions cannot be deleted.");
        return;
      }
      if (!confirm(`Delete flow "${meta.title}"?`)) return;
      try {
        await deleteFlowSession(currentFlowId);
        await persistCurrentFlowId(BUILTIN_WEATHER_TAIPEI_ID);
        await refreshSessions();
      } catch (err) {
        alert(err.message || String(err));
      }
    });
    $("#flow-run-btn")?.addEventListener("click", () => {
      runSession().catch((err) => alert(err.message || String(err)));
    });
    $("#flow-add-node-btn")?.addEventListener("click", async () => {
      if (!currentFlowId) return;
      try {
        await flushAllPendingSaves();
        const { session: updated } = await addFlowNode(currentFlowId, {
          title: `Node ${(session?.nodes.length || 0) + 1}`,
        });
        session = updated;
        renderNodes();
      } catch (err) {
        alert(err.message || String(err));
      }
    });
  }

  function onRuntimeMessage(msg) {
    if (!msg || (msg.type !== "flow.reload" && msg.type !== "flow.updated")) return;
    if (msg.flowSessionId && msg.flowSessionId !== currentFlowId) return;
    loadSession(currentFlowId).catch((err) => console.error("[flow] reload failed", err));
  }

  function refreshModelPickers() {
    if (!session) return;
    const root = $("#flow-nodes");
    if (!root) return;
    root.querySelectorAll(".flow-node-card").forEach((card) => {
      const select = card.querySelector(".flow-node-model");
      if (!select) return;
      const node = session.nodes.find((n) => n.id === card.dataset.nodeId);
      fillNodeModelSelect(select, select.value || node?.model || "");
    });
  }

  async function onTabActivate() {
    if (!session && currentFlowId) await loadSession(currentFlowId);
    else refreshModelPickers();
  }

  return {
    wire,
    refreshSessions,
    getCurrentFlowId,
    onRuntimeMessage,
    onTabActivate,
    refreshModelPickers,
  };
}
