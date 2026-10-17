// IndexedDB store for Flow sessions (ordered nodes with inputs / script / outputs).

import { BUILTIN_WEATHER_TAIPEI_ID, buildWeatherTaipeiSession } from "./seeds/weather-taipei.js";

const DB_NAME = "agent-systems";
const DB_VERSION = 4;
const FLOW_SESSIONS = "flowSessions";

export { BUILTIN_WEATHER_TAIPEI_ID };

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("Failed to open agent-systems DB"));
    req.onupgradeneeded = () => {
      const db = req.result;
      // Mirror system-store stores so either module can perform the v4 upgrade.
      if (!db.objectStoreNames.contains("systems")) {
        db.createObjectStore("systems", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("components")) {
        const store = db.createObjectStore("components", { keyPath: ["systemId", "kind"] });
        store.createIndex("bySystem", "systemId", { unique: false });
      }
      if (!db.objectStoreNames.contains("conversations")) {
        const store = db.createObjectStore("conversations", { keyPath: "id" });
        store.createIndex("bySystem", "systemId", { unique: false });
      }
      if (!db.objectStoreNames.contains("dialogueSessions")) {
        const store = db.createObjectStore("dialogueSessions", { keyPath: "id" });
        store.createIndex("byUpdatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(FLOW_SESSIONS)) {
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

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyNode(partial = {}) {
  return {
    id: partial.id || newId("node"),
    title: partial.title != null ? String(partial.title) : "New node",
    /** Chat model id for api.llm; empty = current dialogue/settings model (same provider). */
    model: partial.model != null ? String(partial.model) : "",
    inputs: partial.inputs && typeof partial.inputs === "object" ? partial.inputs : {},
    script: partial.script != null ? String(partial.script) : "",
    outputs: partial.outputs ?? null,
    status: partial.status || "idle",
    error: partial.error ?? null,
  };
}

function normalizeNode(node) {
  return createEmptyNode(node || {});
}

function normalizeSession(record) {
  if (!record) return null;
  return {
    ...record,
    title: record.title || "(untitled)",
    isBuiltin: Boolean(record.isBuiltin),
    nodes: Array.isArray(record.nodes) ? record.nodes.map(normalizeNode) : [],
  };
}

/** Ensure DB exists and the builtin Taipei weather flow is seeded once. */
export async function ensureFlowSeeded() {
  const db = await openDb();
  const existing = await reqToPromise(
    db.transaction(FLOW_SESSIONS, "readonly").objectStore(FLOW_SESSIONS).get(BUILTIN_WEATHER_TAIPEI_ID)
  );
  if (existing) return existing;
  const seed = buildWeatherTaipeiSession();
  const tx = db.transaction(FLOW_SESSIONS, "readwrite");
  tx.objectStore(FLOW_SESSIONS).put(seed);
  await txDone(tx);
  return seed;
}

export async function listFlowSessions() {
  await ensureFlowSeeded();
  const db = await openDb();
  const all = await reqToPromise(db.transaction(FLOW_SESSIONS, "readonly").objectStore(FLOW_SESSIONS).getAll());
  return (all || [])
    .map((s) => ({
      id: s.id,
      title: s.title || "(untitled)",
      updatedAt: s.updatedAt || s.createdAt || 0,
      createdAt: s.createdAt || 0,
      nodeCount: (s.nodes || []).length,
      isBuiltin: Boolean(s.isBuiltin),
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getFlowSession(id) {
  await ensureFlowSeeded();
  if (!id) return null;
  const db = await openDb();
  const record = await reqToPromise(db.transaction(FLOW_SESSIONS, "readonly").objectStore(FLOW_SESSIONS).get(id));
  return normalizeSession(record);
}

/**
 * Create or update a Flow session. Pass `{ id }` to update; omit to create.
 */
export async function putFlowSession({
  id = null,
  title = null,
  nodes = null,
  isBuiltin = undefined,
} = {}) {
  await ensureFlowSeeded();
  const now = Date.now();
  const existing = id ? await getFlowSession(id) : null;
  const record = {
    id: existing?.id || id || newId("flow"),
    title: title != null ? String(title) : existing?.title || "Untitled flow",
    isBuiltin: isBuiltin !== undefined ? Boolean(isBuiltin) : Boolean(existing?.isBuiltin),
    nodes: Array.isArray(nodes) ? nodes.map(normalizeNode) : existing?.nodes || [createEmptyNode({ title: "Node 1" })],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const db = await openDb();
  const tx = db.transaction(FLOW_SESSIONS, "readwrite");
  tx.objectStore(FLOW_SESSIONS).put(record);
  await txDone(tx);
  return normalizeSession(record);
}

export async function createFlowSession(title = "Untitled flow") {
  return putFlowSession({
    title: title || "Untitled flow",
    nodes: [createEmptyNode({ title: "Node 1" })],
    isBuiltin: false,
  });
}

export async function deleteFlowSession(id) {
  if (!id) return false;
  const existing = await getFlowSession(id);
  if (existing?.isBuiltin) throw new Error("Built-in flow sessions cannot be deleted");
  const db = await openDb();
  const tx = db.transaction(FLOW_SESSIONS, "readwrite");
  tx.objectStore(FLOW_SESSIONS).delete(id);
  await txDone(tx);
  return true;
}

/** Patch one node inside a session and persist. */
export async function writeFlowNode(sessionId, nodeId, patch = {}) {
  const session = await getFlowSession(sessionId);
  if (!session) throw new Error(`Flow session not found: ${sessionId}`);
  const idx = session.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) throw new Error(`Flow node not found: ${nodeId}`);
  const prev = session.nodes[idx];
  const next = normalizeNode({
    ...prev,
    ...patch,
    id: prev.id,
    inputs: patch.inputs !== undefined ? patch.inputs : prev.inputs,
    script: patch.script !== undefined ? patch.script : prev.script,
    outputs: patch.outputs !== undefined ? patch.outputs : prev.outputs,
    title: patch.title !== undefined ? patch.title : prev.title,
    model: patch.model !== undefined ? patch.model : prev.model,
    status: patch.status !== undefined ? patch.status : prev.status,
    error: patch.error !== undefined ? patch.error : prev.error,
  });
  const nodes = session.nodes.slice();
  nodes[idx] = next;
  const updated = await putFlowSession({
    id: session.id,
    title: session.title,
    nodes,
    isBuiltin: session.isBuiltin,
  });
  return { session: updated, node: next };
}

export async function addFlowNode(sessionId, partial = {}) {
  const session = await getFlowSession(sessionId);
  if (!session) throw new Error(`Flow session not found: ${sessionId}`);
  const node = createEmptyNode(partial);
  const nodes = [...session.nodes, node];
  const updated = await putFlowSession({
    id: session.id,
    title: session.title,
    nodes,
    isBuiltin: session.isBuiltin,
  });
  return { session: updated, node };
}

export async function deleteFlowNode(sessionId, nodeId) {
  const session = await getFlowSession(sessionId);
  if (!session) throw new Error(`Flow session not found: ${sessionId}`);
  const nodes = session.nodes.filter((n) => n.id !== nodeId);
  if (nodes.length === session.nodes.length) throw new Error(`Flow node not found: ${nodeId}`);
  const updated = await putFlowSession({
    id: session.id,
    title: session.title,
    nodes,
    isBuiltin: session.isBuiltin,
  });
  return { session: updated };
}

/** Reorder nodes by a full ordered list of node ids. */
export async function reorderFlowNodes(sessionId, nodeIds) {
  const session = await getFlowSession(sessionId);
  if (!session) throw new Error(`Flow session not found: ${sessionId}`);
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  const ordered = [];
  for (const id of nodeIds || []) {
    const n = byId.get(id);
    if (n) {
      ordered.push(n);
      byId.delete(id);
    }
  }
  for (const n of byId.values()) ordered.push(n);
  return putFlowSession({
    id: session.id,
    title: session.title,
    nodes: ordered,
    isBuiltin: session.isBuiltin,
  });
}
