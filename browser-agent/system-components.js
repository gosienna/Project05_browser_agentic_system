// Read-only viewer for an agent system's components, one tab per kind.
// Live-refreshes on system.updated / system.reload broadcasts so the user can
// watch what the LLM editor is modifying; a dot marks kinds changed since the
// tab was last viewed.

import { COMPONENT_KINDS, ensureSeeded, getComponent, getEditableKinds, getSystem, listComponents } from "./system-store.js";

const params = new URLSearchParams(location.search);
const systemId = params.get("id");
let activeKind = COMPONENT_KINDS.includes(params.get("kind")) ? params.get("kind") : "agent";
let componentMeta = {}; // kind -> { bytes, updatedAt }
const changedKinds = new Set();

const tabsEl = document.getElementById("kind-tabs");
const metaEl = document.getElementById("meta");
const contentEl = document.getElementById("content");
const nameEl = document.getElementById("system-name");

function formatBytes(n) {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function setMeta(text, isError = false) {
  metaEl.textContent = text;
  metaEl.classList.toggle("error", isError);
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const kind of COMPONENT_KINDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `kind-tab${kind === activeKind ? " active" : ""}`;
    const bytes = componentMeta[kind]?.bytes ?? 0;
    btn.innerHTML = `${kind}<span class="bytes">${formatBytes(bytes)}</span>`;
    if (changedKinds.has(kind)) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = "Changed since last viewed";
      btn.appendChild(dot);
    }
    btn.addEventListener("click", () => showKind(kind));
    tabsEl.appendChild(btn);
  }
}

async function showKind(kind) {
  activeKind = kind;
  changedKinds.delete(kind);
  renderTabs();
  const comp = await getComponent(systemId, kind);
  contentEl.textContent = comp?.content || "(empty)";
  setMeta(
    comp?.updatedAt
      ? `${kind} · ${formatBytes((comp.content || "").length)} · updated ${new Date(comp.updatedAt).toLocaleString()}`
      : `${kind} · empty`
  );
}

async function refresh() {
  if (!systemId) {
    setMeta("Missing system id (?id=…)", true);
    return;
  }
  await ensureSeeded();
  const system = await getSystem(systemId);
  if (!system) {
    setMeta(`Unknown system ${systemId}`, true);
    return;
  }
  document.title = `${system.name} — components`;
  nameEl.textContent = `${system.name} — components`;
  document.getElementById("system-level").textContent =
    system.level === 1
      ? `Level 1 · LLM edits: ${getEditableKinds(system).join(", ")}`
      : "Level 2 · full LLM access";

  componentMeta = {};
  for (const c of await listComponents(systemId)) {
    componentMeta[c.kind] = { bytes: c.bytes, updatedAt: c.updatedAt };
  }
  renderTabs();
  await showKind(activeKind);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.systemId !== systemId) return;
  if (msg.type === "system.updated") {
    if (msg.kind && msg.kind !== activeKind) changedKinds.add(msg.kind);
    refresh().catch((err) => setMeta(err.message, true));
  } else if (msg.type === "system.reload") {
    refresh().catch((err) => setMeta(err.message, true));
  }
});

document.getElementById("refresh-btn").addEventListener("click", () => {
  refresh().catch((err) => setMeta(err.message, true));
});

refresh().catch((err) => setMeta(err.message, true));
