// IndexedDB store for RAG documents, PDF blobs, and chunk vectors.

const DB_NAME = "rag-documents";
const DB_VERSION = 2;
const DOCUMENTS = "documents";
const CHUNKS = "chunks";
const PDF_BLOBS = "pdfBlobs";
const STAGING = "staging";

export const MAX_PDF_BYTES = 100 * 1024 * 1024;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("Failed to open rag-documents DB"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCUMENTS)) {
        db.createObjectStore(DOCUMENTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const store = db.createObjectStore(CHUNKS, { keyPath: "id" });
        store.createIndex("byDoc", "docId", { unique: false });
      }
      if (!db.objectStoreNames.contains(PDF_BLOBS)) {
        db.createObjectStore(PDF_BLOBS, { keyPath: "docId" });
      }
      if (!db.objectStoreNames.contains(STAGING)) {
        db.createObjectStore(STAGING, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

export async function putDocument(doc) {
  const db = await openDb();
  const tx = db.transaction(DOCUMENTS, "readwrite");
  tx.objectStore(DOCUMENTS).put(doc);
  await txDone(tx);
  return doc;
}

export async function putPdfBlob(docId, blob, sizeBytes) {
  if (sizeBytes > MAX_PDF_BYTES) {
    throw new Error(`PDF exceeds ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB limit.`);
  }
  const db = await openDb();
  const tx = db.transaction(PDF_BLOBS, "readwrite");
  tx.objectStore(PDF_BLOBS).put({ docId, blob, sizeBytes, createdAt: Date.now() });
  await txDone(tx);
}

export async function getPdfBlob(docId) {
  const db = await openDb();
  const row = await reqToPromise(db.transaction(PDF_BLOBS, "readonly").objectStore(PDF_BLOBS).get(docId));
  return row || null;
}

export async function getDocument(docId) {
  const db = await openDb();
  return reqToPromise(db.transaction(DOCUMENTS, "readonly").objectStore(DOCUMENTS).get(docId));
}

export async function listDocuments() {
  const db = await openDb();
  const rows = await reqToPromise(db.transaction(DOCUMENTS, "readonly").objectStore(DOCUMENTS).getAll());
  return (rows || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function putChunks(chunks) {
  const db = await openDb();
  const tx = db.transaction(CHUNKS, "readwrite");
  const store = tx.objectStore(CHUNKS);
  for (const c of chunks) store.put(c);
  await txDone(tx);
}

export async function getChunksByDoc(docId) {
  const db = await openDb();
  const tx = db.transaction(CHUNKS, "readonly");
  return reqToPromise(tx.objectStore(CHUNKS).index("byDoc").getAll(docId));
}

export async function getChunk(chunkId) {
  const db = await openDb();
  return reqToPromise(db.transaction(CHUNKS, "readonly").objectStore(CHUNKS).get(chunkId));
}

export async function getAllChunks() {
  const db = await openDb();
  return reqToPromise(db.transaction(CHUNKS, "readonly").objectStore(CHUNKS).getAll());
}

export async function deletePdfBlob(docId) {
  const db = await openDb();
  const tx = db.transaction(PDF_BLOBS, "readwrite");
  tx.objectStore(PDF_BLOBS).delete(docId);
  await txDone(tx);
}

/** Stage PDF bytes in IndexedDB (side panel → background ingest without large sendMessage payloads). */
export async function putStagingPdf(id, { buffer, name, sizeBytes }) {
  if (sizeBytes > MAX_PDF_BYTES) {
    throw new Error(`PDF exceeds ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB limit.`);
  }
  const db = await openDb();
  const tx = db.transaction(STAGING, "readwrite");
  tx.objectStore(STAGING).put({ id, buffer, name, sizeBytes, createdAt: Date.now() });
  await txDone(tx);
}

/** Read and remove staged PDF bytes (single consumer). */
export async function takeStagingPdf(id) {
  const db = await openDb();
  const tx = db.transaction(STAGING, "readwrite");
  const store = tx.objectStore(STAGING);
  const row = await reqToPromise(store.get(id));
  if (row) store.delete(id);
  await txDone(tx);
  return row || null;
}

export async function deleteDocument(docId) {
  const db = await openDb();
  const tx = db.transaction([DOCUMENTS, CHUNKS, PDF_BLOBS], "readwrite");
  tx.objectStore(DOCUMENTS).delete(docId);
  tx.objectStore(PDF_BLOBS).delete(docId);
  const index = tx.objectStore(CHUNKS).index("byDoc");
  const chunks = await reqToPromise(index.getAll(docId));
  for (const c of chunks || []) tx.objectStore(CHUNKS).delete(c.id);
  await txDone(tx);
}
