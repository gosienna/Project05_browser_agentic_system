// WebApp component tools for the currently selected agent system.
// Each export takes a single args object (always includes systemId) and returns
// a plain object suitable for feeding back into the chat transcript.

import { getComponent, listComponents, writeComponent } from "../../../modes/WebApp/system-store.js";

export function resolveWebAppSystemId(context = {}) {
  const id = context.systemId || context.settings?.webAppSystemId;
  if (!id) throw new Error("No WebApp system selected");
  return id;
}

export function broadcastReload(systemId) {
  chrome.runtime.sendMessage({ type: "system.reload", systemId }).catch(() => {});
}

export function broadcastComponentUpdated(systemId, kind) {
  chrome.runtime.sendMessage({ type: "system.updated", systemId, kind }).catch(() => {});
}

export async function list_components({ systemId }) {
  return { systemId, components: await listComponents(systemId) };
}

export async function read_component({ systemId, kind }) {
  const comp = await getComponent(systemId, kind);
  if (!comp) return { kind, content: "", error: "empty or missing" };
  return { kind: comp.kind, content: comp.content, updatedAt: comp.updatedAt };
}

export async function write_component({ systemId, kind, content }) {
  if (content === undefined) throw new Error("write_component requires content");
  const record = await writeComponent(systemId, kind, content);
  broadcastComponentUpdated(systemId, record.kind);
  return { ok: true, kind: record.kind, bytes: record.content.length, updatedAt: record.updatedAt };
}

export async function reload_home({ systemId }) {
  broadcastReload(systemId);
  return { ok: true };
}
