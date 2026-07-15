// IndexedDB-backed model weight cache for Transformers.js.
// Implements the Cache API subset (`match` / `put`) expected by
// env.customCache — see ONNX_ENGINE_PLAN.md and transformers.js env docs.

const DB_NAME = "transformers-model-cache";
const DB_VERSION = 1;
const STORE = "files";
const META_STORE = "meta";
const LEGACY_CACHE_NAME = "transformers-cache";

let dbPromise = null;
let migratePromise = null;

function toUrl(request) {
  if (typeof request === "string") return request;
  if (request && typeof request.url === "string") return request.url;
  return String(request);
}

/** Only persist Hugging Face (http/https) weight files — never ORT runtime assets. */
function isModelWeightUrl(url) {
  return /^https?:\/\//i.test(url);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB model cache"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
  });
  return dbPromise;
}

function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getMeta(key) {
  const db = await openDb();
  const row = await idbReq(db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(key));
  return row?.value;
}

async function setMeta(key, value) {
  const db = await openDb();
  await idbReq(db.transaction(META_STORE, "readwrite").objectStore(META_STORE).put({ key, value }));
}

async function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => {
      out[name] = value;
    });
    return out;
  }
  for (const [name, value] of Object.entries(headers)) out[name] = value;
  return out;
}

/**
 * Try Cache Storage entries from the previous Transformers.js default and
 * copy them into IndexedDB once, then delete the legacy cache.
 */
async function migrateFromCacheApi() {
  if (migratePromise) return migratePromise;
  migratePromise = (async () => {
    try {
      if (await getMeta("migratedFromCacheApi")) return;
      if (typeof caches === "undefined") {
        await setMeta("migratedFromCacheApi", true);
        return;
      }

      const names = await caches.keys();
      if (!names.includes(LEGACY_CACHE_NAME)) {
        await setMeta("migratedFromCacheApi", true);
        return;
      }

      const legacy = await caches.open(LEGACY_CACHE_NAME);
      const requests = await legacy.keys();
      let moved = 0;
      for (const request of requests) {
        const url = toUrl(request);
        const existing = await idbMatch(url);
        if (existing) continue;
        const response = await legacy.match(request);
        if (!response) continue;
        await idbPut(url, response);
        moved += 1;
      }

      await caches.delete(LEGACY_CACHE_NAME);
      await setMeta("migratedFromCacheApi", true);
      if (moved > 0) console.log(`[onnx] migrated ${moved} cached file(s) from Cache Storage → IndexedDB`);
    } catch (err) {
      console.warn("[onnx] Cache Storage → IndexedDB migration failed:", err);
    }
  })();
  return migratePromise;
}

async function idbMatch(url) {
  const db = await openDb();
  const row = await idbReq(db.transaction(STORE, "readonly").objectStore(STORE).get(url));
  if (!row?.body) return undefined;
  return new Response(row.body, {
    status: 200,
    statusText: "OK",
    headers: row.headers || {},
  });
}

async function idbPut(url, response) {
  // Clone so Transformers.js can still consume the original Response body.
  const cloned = response.clone();
  const body = await cloned.blob();
  const headers = await headersToObject(cloned.headers);
  const db = await openDb();
  await idbReq(
    db.transaction(STORE, "readwrite").objectStore(STORE).put({
      url,
      body,
      headers,
      updatedAt: Date.now(),
      size: body.size,
    })
  );
}

/** Cache API–compatible surface for env.customCache. */
export const indexedDbModelCache = {
  async match(request) {
    await migrateFromCacheApi();
    const url = toUrl(request);
    if (!isModelWeightUrl(url)) return undefined;
    return idbMatch(url);
  },

  async put(request, response) {
    await migrateFromCacheApi();
    const url = toUrl(request);
    if (!isModelWeightUrl(url)) return;
    await idbPut(url, response);
    console.log(`[onnx] IndexedDB cached ${url} (${response.headers?.get?.("content-length") || "?" } bytes)`);
  },
};

/** Configure Transformers.js env to persist weights in IndexedDB. */
export function applyIndexedDbCache(env) {
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = indexedDbModelCache;
  // Ask Chrome not to evict multi-GB model blobs under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
  // Kick migration early so first load benefits from any prior Cache Storage hits.
  migrateFromCacheApi().catch(() => {});
}

export async function listCachedFiles() {
  await migrateFromCacheApi();
  const db = await openDb();
  const rows = await idbReq(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return (rows || []).map((row) => ({
    url: row.url,
    size: row.size ?? row.body?.size ?? 0,
    updatedAt: row.updatedAt ?? null,
  }));
}

export async function clearModelCache() {
  const db = await openDb();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
}
