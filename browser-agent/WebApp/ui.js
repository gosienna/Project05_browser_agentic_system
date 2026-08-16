// WebApp tab: system picker, component editor, and sandbox host controls.

import {
  BUILTIN_CURVE_PLOTTER_ID,
  COMPONENT_KINDS,
  createSystem,
  deleteSystem,
  ensureSeeded,
  getComponent,
  listComponents,
  listSystems,
  writeComponent,
} from "./system-store.js";

const HOST_PAGE = "WebApp/system-host.html";
const COMPONENTS_COLLAPSED_KEY = "webAppComponentsCollapsed";

export function createWebAppPanel({ $, onSystemChanged } = {}) {
  let systems = [];
  let currentSystemId = null;
  let activeComponentKind = COMPONENT_KINDS[0];
  let componentBaseline = "";
  let componentDirty = false;
  let componentLoading = false;
  let componentMetaByKind = {};

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

  function setComponentsCollapsed(collapsed) {
    $("#tab-webapp")?.classList.toggle("components-collapsed", collapsed);
    const btn = $("#component-editor-toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.classList.toggle("active", !collapsed);
    }
    chrome.storage.local.set({ [COMPONENTS_COLLAPSED_KEY]: collapsed }).catch(() => {});
  }

  function wireComponentCollapse() {
    $("#component-editor-toggle")?.addEventListener("click", () => {
      const collapsed = !$("#tab-webapp").classList.contains("components-collapsed");
      setComponentsCollapsed(collapsed);
    });
    chrome.storage.local.get(COMPONENTS_COLLAPSED_KEY).then((stored) => {
      if (stored[COMPONENTS_COLLAPSED_KEY]) setComponentsCollapsed(true);
    });
  }

  function wireComponentEditor() {
    wireComponentCollapse();
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
    return chrome.runtime.getURL(`${HOST_PAGE}?id=${encodeURIComponent(systemId)}`);
  }

  async function findHostTabs(systemId) {
    const prefix = hostUrlForSystem(systemId);
    const matches = (tab) => {
      const url = tab.url || tab.pendingUrl || "";
      return url === prefix || url.startsWith(`${prefix}&`) || url.startsWith(`${prefix}#`);
    };
    try {
      const tabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL(HOST_PAGE)}*` });
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
    $("#system-delete-btn").disabled = !system || !!system.isBuiltin;

    $("#system-render-btn").disabled = !currentSystemId;
    refreshComponentEditor().catch((err) => setComponentMeta(err.message, true));
    onSystemChanged?.();
  }

  function onRuntimeMessage(msg) {
    if (msg?.type === "system.reload" && msg.systemId === currentSystemId) {
      refreshComponentEditor().catch((err) => setComponentMeta(err.message, true));
    }
    if (msg?.type === "system.updated" && msg.systemId === currentSystemId) {
      refreshComponentEditor({ keepDirty: true }).catch((err) =>
        setComponentMeta(err.message, true)
      );
    }
  }

  return {
    wire() {
      wireSystemsUi();
      wireComponentEditor();
    },
    refreshSystems,
    getCurrentSystemId: () => currentSystemId,
    onRuntimeMessage,
    requestHostReload,
  };
}
