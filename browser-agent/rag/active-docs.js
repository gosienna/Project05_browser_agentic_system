// Pinned document ids for scoped RAG search (chrome.storage.local).

const ACTIVE_DOCS_KEY = "ragActiveDocIds";

export async function getActiveDocIds() {
  const { ragActiveDocIds } = await chrome.storage.local.get(ACTIVE_DOCS_KEY);
  return Array.isArray(ragActiveDocIds) ? ragActiveDocIds : [];
}

export async function setActiveDocIds(docIds) {
  const ids = Array.isArray(docIds) ? docIds : [];
  await chrome.storage.local.set({ [ACTIVE_DOCS_KEY]: ids });
  return ids;
}

/** Explicit doc_ids wins; otherwise pinned docs; empty array means no scope. */
export async function resolveSearchDocIds(explicitDocIds) {
  if (Array.isArray(explicitDocIds) && explicitDocIds.length > 0) return explicitDocIds;
  if (explicitDocIds === undefined || explicitDocIds === null) return await getActiveDocIds();
  return [];
}
