// Background message handlers for RAG (PDF ingest, search, blobs).

import { ingestPdf } from "./ingest.js";
import { reembedDocument } from "./reembed.js";
import { searchDocuments } from "./search.js";
import * as store from "./rag-store.js";
import { toArrayBuffer } from "./binary.js";
import { getActiveDocIds, setActiveDocIds, resolveSearchDocIds } from "./active-docs.js";

async function resolveIngestBuffer(msg) {
  if (msg.stagingId) {
    const staged = await store.takeStagingPdf(msg.stagingId);
    if (!staged) {
      throw new Error("Staged PDF not found — attach the file again.");
    }
    const buffer = toArrayBuffer(staged.buffer);
    if (!buffer?.byteLength) {
      throw new Error("Staged PDF bytes were empty or corrupted — attach the file again.");
    }
    return { buffer, name: staged.name || msg.name };
  }

  const buffer = toArrayBuffer(msg.buffer) ?? toArrayBuffer(msg.bufferBase64);
  if (!buffer?.byteLength) {
    throw new Error(
      "PDF file bytes were not received. Reload the extension and attach the PDF again."
    );
  }
  return { buffer, name: msg.name };
}

function broadcastProgress(payload) {
  chrome.runtime.sendMessage({ target: "rag-progress", ...payload }).catch(() => {});
}

export async function handleRagMessage(msg, getSettings) {
  const settings = await getSettings();

  switch (msg.type) {
    case "rag.ingest": {
      const { buffer, name } = await resolveIngestBuffer(msg);
      const pages = Array.isArray(msg.pages) ? msg.pages : null;
      const pageCount = Number(msg.pageCount) || pages?.length || 0;
      if (!pages?.length) {
        throw new Error(
          "PDF text extraction missing — reload the extension and attach the PDF again."
        );
      }
      return ingestPdf({
        name: name || msg.name || "document.pdf",
        buffer,
        pages,
        pageCount,
        settings,
        chunkSize: msg.chunkSize,
        chunkOverlap: msg.chunkOverlap,
        onProgress: (p) => broadcastProgress({ docId: p.docId, ...p }),
      });
    }
    case "rag.reembed": {
      if (!msg.docId) throw new Error("docId required for re-embed.");
      return reembedDocument(msg.docId, settings, (p) => broadcastProgress({ docId: msg.docId, ...p }));
    }
    case "rag.listDocuments":
      return store.listDocuments();
    case "rag.getPdfBlob": {
      const doc = await store.getDocument(msg.docId);
      if (!doc) throw new Error(`Document "${msg.docId}" not found.`);
      const blobRow = await store.getPdfBlob(msg.docId);
      if (!blobRow?.blob) throw new Error(`PDF blob missing for "${msg.docId}".`);
      return {
        docId: msg.docId,
        name: doc.name,
        pageCount: doc.pageCount,
        blob: blobRow.blob,
        sizeBytes: blobRow.sizeBytes,
      };
    }
    case "rag.getChunk": {
      const chunk = await store.getChunk(msg.chunkId);
      if (!chunk) throw new Error(`Chunk "${msg.chunkId}" not found.`);
      const doc = await store.getDocument(chunk.docId);
      return { chunk, doc };
    }
    case "rag.deleteDocument": {
      await store.deleteDocument(msg.docId);
      const active = await getActiveDocIds();
      if (active.includes(msg.docId)) {
        await setActiveDocIds(active.filter((id) => id !== msg.docId));
      }
      return { ok: true };
    }
    case "rag.search": {
      const docIds = await resolveSearchDocIds(msg.docIds);
      return searchDocuments(msg.query, settings, {
        docIds,
        topK: msg.topK ?? msg.top_k,
      });
    }
    case "rag.getActiveDocs":
      return { docIds: await getActiveDocIds() };
    case "rag.setActiveDocs":
      return { docIds: await setActiveDocIds(msg.docIds) };
    default:
      return null;
  }
}
