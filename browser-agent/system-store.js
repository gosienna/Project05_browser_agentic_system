// IndexedDB store for user-created agent systems and their components.

import { CURVE_UI_SOURCE } from "./seeds/curve-ui.js";

const DB_NAME = "agent-systems";
const DB_VERSION = 3;
const SYSTEMS = "systems";
const COMPONENTS = "components";
const CONVERSATIONS = "conversations";
const DIALOGUE_SESSIONS = "dialogueSessions";

export const COMPONENT_KINDS = ["agent", "tools", "html", "css", "ui"];

/**
 * The set of component kinds a level-1 system's editor may touch. Reads the
 * current `editableKinds` array, falling back to the legacy singular
 * `editableKind` field (pre-multi-select records), then to `["ui"]`.
 */
export function getEditableKinds(system) {
  if (Array.isArray(system?.editableKinds) && system.editableKinds.length) {
    const kinds = system.editableKinds.filter((k) => COMPONENT_KINDS.includes(k));
    if (kinds.length) return kinds;
  }
  if (system?.editableKind && COMPONENT_KINDS.includes(system.editableKind)) return [system.editableKind];
  return ["ui"];
}

function sanitizeEditableKinds(editableKinds) {
  const kinds = (Array.isArray(editableKinds) ? editableKinds : [editableKinds]).filter((k) =>
    COMPONENT_KINDS.includes(k)
  );
  return kinds.length ? kinds : ["ui"];
}

export const BUILTIN_BROWSER_AGENT_ID = "browser-agent";
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
    if (existing.level === undefined) await migrateBuiltinLevels();
    return;
  }
  await seedBuiltins();
}

/** Backfill the immutable editor level on builtins seeded before levels existed. */
async function migrateBuiltinLevels() {
  const db = await openDb();
  const tx = db.transaction(SYSTEMS, "readwrite");
  const store = tx.objectStore(SYSTEMS);
  const browser = await reqToPromise(store.get(BUILTIN_BROWSER_AGENT_ID));
  if (browser && browser.level === undefined) store.put({ ...browser, level: 2 });
  const curve = await reqToPromise(store.get(BUILTIN_CURVE_PLOTTER_ID));
  if (curve && curve.level === undefined) store.put({ ...curve, level: 1, editableKinds: ["ui"] });
  await txDone(tx);
}

async function seedBuiltins() {
  const now = Date.now();
  const systems = [
    {
      id: BUILTIN_BROWSER_AGENT_ID,
      name: "Browser Agent",
      createdAt: now,
      updatedAt: now,
      isBuiltin: true,
      level: 2,
    },
    {
      id: BUILTIN_CURVE_PLOTTER_ID,
      name: "Curve Plotter",
      createdAt: now,
      updatedAt: now,
      isBuiltin: true,
      level: 1,
      editableKinds: ["ui"],
    },
  ];

  const components = [
    ...browserAgentComponents(),
    ...curvePlotterComponents(),
  ];

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

export async function createSystem(name, { level, editableKinds } = {}) {
  await ensureSeeded();
  const now = Date.now();
  const id = `sys_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const system = { id, name: name?.trim() || "Untitled system", createdAt: now, updatedAt: now, isBuiltin: false };
  // The editor access level is fixed at creation and never changes afterwards.
  system.level = Number(level) === 1 ? 1 : 2;
  if (system.level === 1) {
    system.editableKinds = sanitizeEditableKinds(editableKinds || ["ui"]);
  }
  const components = defaultComponents(id);

  const db = await openDb();
  const tx = db.transaction([SYSTEMS, COMPONENTS], "readwrite");
  tx.objectStore(SYSTEMS).put(system);
  for (const c of components) tx.objectStore(COMPONENTS).put(c);
  await txDone(tx);
  return system;
}

/**
 * Update a level-1 system's editable component set and/or custom persona
 * prompt. These are mutable at any time, unlike `level` which is fixed at
 * creation. Passing `systemPrompt: ""` reverts to the default persona.
 */
export async function updateSystemEditorConfig(id, { editableKinds, systemPrompt } = {}) {
  await ensureSeeded();
  const system = await getSystem(id);
  if (!system) throw new Error(`Unknown system "${id}"`);
  if (system.level !== 1) throw new Error("Editor config only applies to level 1 systems");

  const next = { ...system, updatedAt: Date.now() };
  if (editableKinds !== undefined) next.editableKinds = sanitizeEditableKinds(editableKinds);
  if (systemPrompt !== undefined) next.systemPrompt = String(systemPrompt || "").trim();

  const db = await openDb();
  const tx = db.transaction(SYSTEMS, "readwrite");
  tx.objectStore(SYSTEMS).put(next);
  await txDone(tx);
  return next;
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
  return (comps || []).map((c) => ({ kind: c.kind, updatedAt: c.updatedAt, bytes: (c.content || "").length }));
}

export async function getComponent(systemId, kind) {
  await ensureSeeded();
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
  for (const c of comps || []) out[c.kind] = c.content || "";
  for (const kind of COMPONENT_KINDS) if (out[kind] === undefined) out[kind] = "";
  return out;
}

export async function writeComponent(systemId, kind, content) {
  await ensureSeeded();
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

// --- Conversation history (LLM dialogue transcripts, per system) ------------

/**
 * Persist one completed run's full LLM message array under its system.
 * `source` distinguishes browser automation runs from component-editor runs;
 * `kinds` records which scripts a level-1 editor was scoped to (else null).
 */
export async function saveConversation({ systemId, source = "editor", kinds = null, task = "", messages = [], final = "" }) {
  await ensureSeeded();
  if (!systemId) throw new Error("saveConversation requires a systemId");
  const now = Date.now();
  const id = `conv_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    systemId,
    source,
    kinds: kinds || null,
    task: String(task || ""),
    messages: Array.isArray(messages) ? messages : [],
    final: String(final ?? ""),
    createdAt: now,
  };
  const db = await openDb();
  const tx = db.transaction(CONVERSATIONS, "readwrite");
  tx.objectStore(CONVERSATIONS).put(record);
  await txDone(tx);
  return record;
}

/** Lightweight metadata for every stored run of a system, newest first. */
export async function listConversations(systemId) {
  await ensureSeeded();
  const db = await openDb();
  const idx = db.transaction(CONVERSATIONS, "readonly").objectStore(CONVERSATIONS).index("bySystem");
  const all = await reqToPromise(idx.getAll(systemId));
  return (all || [])
    .map((c) => ({
      id: c.id,
      systemId: c.systemId,
      source: c.source,
      kinds: c.kinds,
      task: c.task,
      final: c.final,
      createdAt: c.createdAt,
      messageCount: (c.messages || []).length,
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Full transcript (including the messages array) for one run. */
export async function getConversation(id) {
  await ensureSeeded();
  const db = await openDb();
  return reqToPromise(db.transaction(CONVERSATIONS, "readonly").objectStore(CONVERSATIONS).get(id));
}

export async function deleteConversation(id) {
  const db = await openDb();
  const tx = db.transaction(CONVERSATIONS, "readwrite");
  tx.objectStore(CONVERSATIONS).delete(id);
  await txDone(tx);
  return true;
}

/** Wipe all stored runs for one system. Returns how many were removed. */
export async function clearConversations(systemId) {
  await ensureSeeded();
  const db = await openDb();
  const tx = db.transaction(CONVERSATIONS, "readwrite");
  const idx = tx.objectStore(CONVERSATIONS).index("bySystem");
  const all = await reqToPromise(idx.getAll(systemId));
  for (const c of all || []) tx.objectStore(CONVERSATIONS).delete(c.id);
  await txDone(tx);
  return (all || []).length;
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
export async function putDialogueSession({ id = null, systemPrompt = "", toolsJson = "", turns = [] } = {}) {
  await ensureSeeded();
  const now = Date.now();
  const existing = id ? await getDialogueSession(id) : null;
  const record = {
    id: existing?.id || id || `dlg_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: dialogueSessionTitle(turns),
    systemPrompt: String(systemPrompt || ""),
    toolsJson: String(toolsJson || ""),
    turns: Array.isArray(turns) ? turns : [],
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

function defaultComponents(systemId) {
  return [
    {
      systemId,
      kind: "agent",
      content: DEFAULT_AGENT,
      updatedAt: Date.now(),
    },
    {
      systemId,
      kind: "tools",
      content: DEFAULT_TOOLS,
      updatedAt: Date.now(),
    },
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
      kind: "ui",
      content: DEFAULT_UI,
      updatedAt: Date.now(),
    },
  ];
}

function browserAgentComponents() {
  const id = BUILTIN_BROWSER_AGENT_ID;
  const now = Date.now();
  return [
    { systemId: id, kind: "agent", content: BROWSER_AGENT_PROMPT, updatedAt: now },
    { systemId: id, kind: "tools", content: BROWSER_AGENT_TOOLS_NOTE, updatedAt: now },
    {
      systemId: id,
      kind: "html",
      content: `<div class="ba-home">
  <h1>Browser Agent</h1>
  <p>Built-in system for tab automation (read_page, click, navigate, …).</p>
  <p>Use <strong>Run automation</strong> in the Agent tab to execute tasks on your open tabs.
  Use <strong>Edit components</strong> to change this home page or the agent prompt via the LLM.</p>
</div>`,
      updatedAt: now,
    },
    {
      systemId: id,
      kind: "css",
      content: `body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #f4f6fa; color: #1b1b1f; }
.ba-home { padding: 24px; max-width: 480px; }
h1 { margin: 0 0 8px; font-size: 1.4rem; }
p { margin: 0 0 10px; color: #444; }`,
      updatedAt: now,
    },
    { systemId: id, kind: "ui", content: "// Browser Agent home — no interactive UI required.\n", updatedAt: now },
  ];
}

function curvePlotterComponents() {
  const id = BUILTIN_CURVE_PLOTTER_ID;
  const now = Date.now();
  return [
    { systemId: id, kind: "agent", content: CURVE_AGENT, updatedAt: now },
    { systemId: id, kind: "tools", content: CURVE_TOOLS, updatedAt: now },
    { systemId: id, kind: "html", content: CURVE_HTML, updatedAt: now },
    { systemId: id, kind: "css", content: CURVE_CSS, updatedAt: now },
    { systemId: id, kind: "ui", content: CURVE_UI_SOURCE, updatedAt: now },
  ];
}

const DEFAULT_AGENT = `You maintain this agent system's home UI and tools.
Components: agent (this prompt), tools (JS tool functions), html, css, ui (home page JS).
Prefer editing html/css/ui for display changes and tools for browser/compute helpers.
When using tools from the home UI, assign self.__agentTools = { name: async (args, api) => ... }.
The injected api can listTabs, getActiveTab, executeInTab, readPage, click, typeText, scroll, navigate, captureTab.`;

const DEFAULT_TOOLS = `// Assign named tools for this system. api is injected at runtime.
self.__agentTools = {
  // Example: count words on a tab
  // word_count: async (args, api) => {
  //   const tabId = args.tabId ?? (await api.getActiveTab())?.id;
  //   return api.executeInTab(tabId, "() => document.body.innerText.split(/\\\\s+/).filter(Boolean).length", []);
  // },
};
`;

const DEFAULT_HTML = `<div class="home">
  <h1>New agent system</h1>
  <p>Ask the LLM in the Agent tab to build this home page and tools.</p>
</div>`;

const DEFAULT_CSS = `body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #fafafa; color: #222; }
.home { padding: 24px; }
h1 { margin: 0 0 8px; font-size: 1.35rem; }`;

const DEFAULT_UI = `// Home page script. DOM from the html component is already mounted.
console.log("[agent-system] home ready");
`;

const BROWSER_AGENT_PROMPT = `You are a browser automation agent. You control the user's browser tab-by-tab to complete their task.

Tools:
- read_page(): returns the visible text of the current tab.
- get_links(): returns [{text, href}] for links on the current tab.
- list_tabs(): returns open tabs [{id, title, url}].
- open_tab({url}): opens a new tab, returns its id.
- navigate({tabId, url}): navigates a tab to url.
- click({tabId, selector}): clicks the first element matching a CSS selector or visible text.
- type_text({tabId, selector, text}): types text into an input/textarea matching selector.
- scroll({tabId, direction}): scrolls the tab "up" or "down" by one screen.
- fetch_url({url}): fetches a URL's text content without opening a tab.
- wait({ms}): pauses for ms milliseconds.
- describe_image({tabId?, imageUrl?, dataUrl?}): locally captions an image.
- classify_image({tabId?, imageUrl?, dataUrl?, topK?}): locally classifies an image.
- transcribe_audio({audioUrl?, dataUrl?}): locally transcribes English audio.

On every turn, reply with exactly ONE JSON object and nothing else:
- To use a tool: {"thought": "...", "tool": "<name>", "args": {...}}
- To finish: {"thought": "...", "final": "<answer for the user>"}

Do not wrap the JSON in markdown fences. Do not include any text outside the JSON object.`;

const BROWSER_AGENT_TOOLS_NOTE = `// Built-in Browser Agent uses the extension's tools/browser.js exports at runtime
// (read_page, click, navigate, …). This file is documentation / override notes only.
self.__agentTools = {};
`;

const CURVE_AGENT = `You maintain the Curve Plotter agent system.
Prefer editing the ui, css, and html components to change how curves are displayed.
Keep a 2D cartesian canvas with labeled axes. Support plotting mathematical curves.
When the user asks for two curves at once, update the UI so they can enter and plot two equations.
Reply with component edits via the editor tools (read_component / write_component), then reload_home.`;

const CURVE_TOOLS = `self.__agentTools = {
  sample_poly: async (args) => {
    const coeffs = args.coeffs || [0, 0, 1]; // a0 + a1 x + a2 x^2 ...
    const xMin = args.xMin ?? -2;
    const xMax = args.xMax ?? 2;
    const n = args.n ?? 200;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const x = xMin + (i / n) * (xMax - xMin);
      let y = 0;
      for (let p = 0; p < coeffs.length; p++) y += coeffs[p] * Math.pow(x, p);
      pts.push({ x, y });
    }
    return pts;
  },
};
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
