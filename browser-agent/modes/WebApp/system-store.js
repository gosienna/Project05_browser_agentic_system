// IndexedDB store for user-created agent systems and their components.

import { CURVE_UI_SOURCE } from "./seeds/curve-ui.js";

const DB_NAME = "agent-systems";
const DB_VERSION = 4;
const SYSTEMS = "systems";
const COMPONENTS = "components";
const CONVERSATIONS = "conversations";
const DIALOGUE_SESSIONS = "dialogueSessions";
const FLOW_SESSIONS = "flowSessions";

export const COMPONENT_KINDS = ["html", "css", "script"];

/** Map the pre-rename `ui` kind onto `script`. */
export function normalizeComponentKind(kind) {
  return kind === "ui" ? "script" : kind;
}

/** Retired builtin id — kept for one-time IndexedDB cleanup only. */
const RETIRED_BROWSER_AGENT_ID = "browser-agent";
export const BUILTIN_CURVE_PLOTTER_ID = "curve-plotter";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("Failed to open agent-systems DB"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SYSTEMS)) {
        db.createObjectStore(SYSTEMS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(COMPONENTS)) {
        const store = db.createObjectStore(COMPONENTS, { keyPath: ["systemId", "kind"] });
        store.createIndex("bySystem", "systemId", { unique: false });
      }
      if (!db.objectStoreNames.contains(CONVERSATIONS)) {
        // One row per completed agent/editor run; each row belongs to exactly
        // one system (grouped via the bySystem index for per-system history).
        const store = db.createObjectStore(CONVERSATIONS, { keyPath: "id" });
        store.createIndex("bySystem", "systemId", { unique: false });
      }
      if (!db.objectStoreNames.contains(DIALOGUE_SESSIONS)) {
        // Mutable Dialogue-tab chats (turns + image data URLs), not tied to a system.
        const store = db.createObjectStore(DIALOGUE_SESSIONS, { keyPath: "id" });
        store.createIndex("byUpdatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(FLOW_SESSIONS)) {
        // Flow-tab sessions: ordered nodes with inputs / script / outputs.
        const store = db.createObjectStore(FLOW_SESSIONS, { keyPath: "id" });
        store.createIndex("byUpdatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Ensure DB exists and builtin systems are seeded once. */
export async function ensureSeeded() {
  const db = await openDb();
  const existing = await reqToPromise(db.transaction(SYSTEMS, "readonly").objectStore(SYSTEMS).get(BUILTIN_CURVE_PLOTTER_ID));
  if (existing) {
    await migrateUiKindToScript();
    await migrateRemoveEditorLevels();
    await migrateRemoveRetiredComponentKinds();
    await migrateRemoveBrowserAgent();
    return;
  }
  await seedBuiltins();
}

/** Rename stored component kind `ui` → `script`. */
async function migrateUiKindToScript() {
  const db = await openDb();
  const tx = db.transaction(COMPONENTS, "readwrite");
  const compStore = tx.objectStore(COMPONENTS);

  const comps = await reqToPromise(compStore.getAll());
  for (const c of comps || []) {
    if (c.kind !== "ui") continue;
    const existingScript = await reqToPromise(compStore.get([c.systemId, "script"]));
    if (!existingScript) compStore.put({ ...c, kind: "script" });
    compStore.delete([c.systemId, "ui"]);
  }
  await txDone(tx);
}

/** Drop retired component kinds (`agent` prompt text, `tools` __agentTools blob). */
async function migrateRemoveRetiredComponentKinds() {
  const retired = new Set(["agent", "tools"]);
  const db = await openDb();
  const tx = db.transaction(COMPONENTS, "readwrite");
  const compStore = tx.objectStore(COMPONENTS);
  const comps = await reqToPromise(compStore.getAll());
  for (const c of comps || []) {
    if (retired.has(c.kind)) compStore.delete([c.systemId, c.kind]);
  }
  await txDone(tx);
}

/** Drop retired editor-access fields (`level`, `editableKinds`, custom L1 persona). */
async function migrateRemoveEditorLevels() {
  const db = await openDb();
  const tx = db.transaction(SYSTEMS, "readwrite");
  const store = tx.objectStore(SYSTEMS);
  const systems = await reqToPromise(store.getAll());
  for (const system of systems || []) {
    if (
      system.level === undefined &&
      system.editableKinds === undefined &&
      system.editableKind === undefined &&
      system.systemPrompt === undefined
    ) {
      continue;
    }
    const { level: _level, editableKinds: _kinds, editableKind: _kind, systemPrompt: _prompt, ...rest } = system;
    store.put(rest);
  }
  await txDone(tx);
}

/** Remove the retired Browser Agent builtin (system, components, conversations). */
async function migrateRemoveBrowserAgent() {
  const id = RETIRED_BROWSER_AGENT_ID;
  const db = await openDb();
  const existing = await reqToPromise(db.transaction(SYSTEMS, "readonly").objectStore(SYSTEMS).get(id));
  if (!existing) return;

  const tx = db.transaction([SYSTEMS, COMPONENTS, CONVERSATIONS], "readwrite");
  tx.objectStore(SYSTEMS).delete(id);
  const comps = await reqToPromise(tx.objectStore(COMPONENTS).index("bySystem").getAll(id));
  for (const c of comps || []) tx.objectStore(COMPONENTS).delete([c.systemId, c.kind]);
  const convs = await reqToPromise(tx.objectStore(CONVERSATIONS).index("bySystem").getAll(id));
  for (const c of convs || []) tx.objectStore(CONVERSATIONS).delete(c.id);
  await txDone(tx);

  const { currentSystemId } = await chrome.storage.local.get("currentSystemId");
  if (currentSystemId === id) {
    await chrome.storage.local.set({ currentSystemId: BUILTIN_CURVE_PLOTTER_ID });
  }
}

async function seedBuiltins() {
  const now = Date.now();
  const systems = [
    {
      id: BUILTIN_CURVE_PLOTTER_ID,
      name: "Curve Plotter",
      createdAt: now,
      updatedAt: now,
      isBuiltin: true,
    },
  ];

  const components = [...curvePlotterComponents()];

  const db = await openDb();
  const tx = db.transaction([SYSTEMS, COMPONENTS], "readwrite");
  const sysStore = tx.objectStore(SYSTEMS);
  const compStore = tx.objectStore(COMPONENTS);
  for (const s of systems) sysStore.put(s);
  for (const c of components) compStore.put(c);
  await txDone(tx);
}

export async function listSystems() {
  await ensureSeeded();
  const db = await openDb();
  const all = await reqToPromise(db.transaction(SYSTEMS, "readonly").objectStore(SYSTEMS).getAll());
  return (all || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function getSystem(id) {
  await ensureSeeded();
  const db = await openDb();
  return reqToPromise(db.transaction(SYSTEMS, "readonly").objectStore(SYSTEMS).get(id));
}

export async function createSystem(name) {
  await ensureSeeded();
  const now = Date.now();
  const id = `sys_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const system = { id, name: name?.trim() || "Untitled system", createdAt: now, updatedAt: now, isBuiltin: false };
  const components = defaultComponents(id);

  const db = await openDb();
  const tx = db.transaction([SYSTEMS, COMPONENTS], "readwrite");
  tx.objectStore(SYSTEMS).put(system);
  for (const c of components) tx.objectStore(COMPONENTS).put(c);
  await txDone(tx);
  return system;
}

export async function deleteSystem(id) {
  const system = await getSystem(id);
  if (!system) throw new Error(`Unknown system "${id}"`);
  if (system.isBuiltin) throw new Error("Cannot delete a built-in system");

  const db = await openDb();
  const tx = db.transaction([SYSTEMS, COMPONENTS, CONVERSATIONS], "readwrite");
  tx.objectStore(SYSTEMS).delete(id);
  const idx = tx.objectStore(COMPONENTS).index("bySystem");
  const comps = await reqToPromise(idx.getAll(id));
  for (const c of comps || []) tx.objectStore(COMPONENTS).delete([c.systemId, c.kind]);
  const convIdx = tx.objectStore(CONVERSATIONS).index("bySystem");
  const convs = await reqToPromise(convIdx.getAll(id));
  for (const c of convs || []) tx.objectStore(CONVERSATIONS).delete(c.id);
  await txDone(tx);
  return true;
}

export async function listComponents(systemId) {
  await ensureSeeded();
  const db = await openDb();
  const idx = db.transaction(COMPONENTS, "readonly").objectStore(COMPONENTS).index("bySystem");
  const comps = await reqToPromise(idx.getAll(systemId));
  return (comps || [])
    .map((c) => ({
      kind: normalizeComponentKind(c.kind),
      updatedAt: c.updatedAt,
      bytes: (c.content || "").length,
    }))
    .filter((c) => COMPONENT_KINDS.includes(c.kind));
}

export async function getComponent(systemId, kind) {
  await ensureSeeded();
  kind = normalizeComponentKind(kind);
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`Unknown component kind "${kind}"`);
  const db = await openDb();
  return reqToPromise(db.transaction(COMPONENTS, "readonly").objectStore(COMPONENTS).get([systemId, kind]));
}

export async function getAllComponents(systemId) {
  await ensureSeeded();
  const db = await openDb();
  const idx = db.transaction(COMPONENTS, "readonly").objectStore(COMPONENTS).index("bySystem");
  const comps = await reqToPromise(idx.getAll(systemId));
  const out = {};
  for (const c of comps || []) {
    const kind = normalizeComponentKind(c.kind);
    if (COMPONENT_KINDS.includes(kind)) out[kind] = c.content || "";
  }
  for (const kind of COMPONENT_KINDS) if (out[kind] === undefined) out[kind] = "";
  return out;
}

export async function writeComponent(systemId, kind, content) {
  await ensureSeeded();
  kind = normalizeComponentKind(kind);
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`Unknown component kind "${kind}"`);
  const system = await getSystem(systemId);
  if (!system) throw new Error(`Unknown system "${systemId}"`);

  const now = Date.now();
  const record = { systemId, kind, content: String(content ?? ""), updatedAt: now };
  const db = await openDb();
  const tx = db.transaction([SYSTEMS, COMPONENTS], "readwrite");
  tx.objectStore(COMPONENTS).put(record);
  tx.objectStore(SYSTEMS).put({ ...system, updatedAt: now });
  await txDone(tx);
  return record;
}

// --- Dialogue sessions (Dialogue tab chats, including image data URLs) -------

function dialogueSessionTitle(turns) {
  const firstUser = (turns || []).find((t) => t.role === "user");
  if (!firstUser) return "(empty)";
  const text = String(firstUser.content || "").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  if (firstUser.images?.length) return "(image)";
  return "(empty)";
}

/**
 * Create or update a Dialogue session. Pass `{ id }` to update; omit to create.
 * `turns` may include `images` as data URLs.
 */
export async function putDialogueSession({ id = null, systemPrompt = "", toolsJson = "", turns = [], lastUsage = null } = {}) {
  await ensureSeeded();
  const now = Date.now();
  const existing = id ? await getDialogueSession(id) : null;
  const record = {
    id: existing?.id || id || `dlg_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: dialogueSessionTitle(turns),
    systemPrompt: String(systemPrompt || ""),
    toolsJson: String(toolsJson || ""),
    turns: Array.isArray(turns) ? turns : [],
    lastUsage: lastUsage || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const db = await openDb();
  const tx = db.transaction(DIALOGUE_SESSIONS, "readwrite");
  tx.objectStore(DIALOGUE_SESSIONS).put(record);
  await txDone(tx);
  return record;
}

/** Lightweight metadata for every Dialogue session, newest first. */
export async function listDialogueSessions() {
  await ensureSeeded();
  const db = await openDb();
  const all = await reqToPromise(db.transaction(DIALOGUE_SESSIONS, "readonly").objectStore(DIALOGUE_SESSIONS).getAll());
  return (all || [])
    .map((s) => ({
      id: s.id,
      title: s.title || "(empty)",
      updatedAt: s.updatedAt || s.createdAt || 0,
      createdAt: s.createdAt || 0,
      turnCount: (s.turns || []).length,
      hasImages: (s.turns || []).some((t) => t.images?.length > 0),
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Full session (turns + images + system prompt). */
export async function getDialogueSession(id) {
  await ensureSeeded();
  if (!id) return null;
  const db = await openDb();
  return reqToPromise(db.transaction(DIALOGUE_SESSIONS, "readonly").objectStore(DIALOGUE_SESSIONS).get(id));
}

export async function deleteDialogueSession(id) {
  if (!id) return false;
  const db = await openDb();
  const tx = db.transaction(DIALOGUE_SESSIONS, "readwrite");
  tx.objectStore(DIALOGUE_SESSIONS).delete(id);
  await txDone(tx);
  return true;
}

/** Wipe every stored Dialogue session. Returns how many were removed. */
export async function clearAllDialogueSessions() {
  await ensureSeeded();
  const db = await openDb();
  const tx = db.transaction(DIALOGUE_SESSIONS, "readwrite");
  const store = tx.objectStore(DIALOGUE_SESSIONS);
  const all = await reqToPromise(store.getAll());
  const count = (all || []).length;
  store.clear();
  await txDone(tx);
  return count;
}

function defaultComponents(systemId) {
  return [
    {
      systemId,
      kind: "html",
      content: DEFAULT_HTML,
      updatedAt: Date.now(),
    },
    {
      systemId,
      kind: "css",
      content: DEFAULT_CSS,
      updatedAt: Date.now(),
    },
    {
      systemId,
      kind: "script",
      content: DEFAULT_SCRIPT,
      updatedAt: Date.now(),
    },
  ];
}

function curvePlotterComponents() {
  const id = BUILTIN_CURVE_PLOTTER_ID;
  const now = Date.now();
  return [
    { systemId: id, kind: "html", content: CURVE_HTML, updatedAt: now },
    { systemId: id, kind: "css", content: CURVE_CSS, updatedAt: now },
    { systemId: id, kind: "script", content: CURVE_UI_SOURCE, updatedAt: now },
  ];
}

const DEFAULT_HTML = `<div class="home">
  <h1>New agent system</h1>
  <p>Ask the LLM in the WebApp tab to build this home page.</p>
</div>`;

const DEFAULT_CSS = `body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #fafafa; color: #222; }
.home { padding: 24px; }
h1 { margin: 0 0 8px; font-size: 1.35rem; }`;

const DEFAULT_SCRIPT = `// Home page script. DOM from the html component is already mounted.
console.log("[agent-system] home ready");
`;

const CURVE_HTML = `<div class="plotter">
  <header class="bar">
    <h1>Curve Plotter</h1>
    <label class="eq">
      <span>y =</span>
      <input id="equation" type="text" value="x^2" spellcheck="false" />
    </label>
    <button id="plot-btn" type="button">Plot</button>
  </header>
  <canvas id="plot" width="640" height="480" aria-label="Cartesian plot"></canvas>
  <p class="hint">Default: y = x² on [−2, 2]. Edit the equation (use x, ^ for powers, *, sin, cos, …) then Plot.</p>
</div>`;

const CURVE_CSS = `* { box-sizing: border-box; }
body {
  margin: 0;
  font: 13px/1.4 "IBM Plex Sans", system-ui, sans-serif;
  background: linear-gradient(160deg, #e8eef5 0%, #f7f4ef 45%, #f0ebe3 100%);
  color: #1a2332;
  min-height: 100%;
}
.plotter {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  min-height: 100vh;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  flex: 1 1 auto;
}
.eq {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
#equation {
  width: 10rem;
  padding: 6px 8px;
  border: 1px solid #9aa8bc;
  border-radius: 6px;
  font: inherit;
  background: #fff;
}
#plot-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: #1a4f8b;
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
#plot-btn:hover { background: #163f6e; }
#plot {
  width: 100%;
  max-width: 100%;
  height: auto;
  background: #fff;
  border: 1px solid #c5d0de;
  border-radius: 8px;
  display: block;
}
.hint { margin: 0; color: #5a6575; font-size: 12px; }`;
