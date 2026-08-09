// PDF ingest: chunk → embed → IndexedDB (parse runs in the side panel, not the service worker).

import { validateChunkParams, chunkPages } from "./chunk.js";
import { embedFingerprint } from "./config.js";
import { embedTexts } from "./embed.js";
import * as store from "./rag-store.js";

/**
 * @param {{
 *   name: string,
 *   buffer: ArrayBuffer,
 *   pages: Array<{ page: number, text: string }>,
 *   pageCount: number,
 *   settings: object,
 *   chunkSize?: number,
 *   chunkOverlap?: number,
 *   onProgress?: (p: object) => void
 * }} opts
 */
export async function ingestPdf(opts) {
  const { name, buffer, settings, onProgress } = opts;
  const sizeBytes = buffer.byteLength;
  if (sizeBytes > store.MAX_PDF_BYTES) {
    throw new Error(`PDF exceeds ${Math.round(store.MAX_PDF_BYTES / (1024 * 1024))} MB limit.`);
  }

  const pages = opts.pages;
  const pageCount = opts.pageCount ?? pages?.length ?? 0;
  if (!pages?.length) {
    throw new Error("PDF text pages missing — reload the extension and attach the PDF again.");
  }

  const chunkParams = validateChunkParams(
    opts.chunkSize ?? settings?.ragChunkSize,
    opts.chunkOverlap ?? settings?.ragChunkOverlap
  );

  onProgress?.({ phase: "chunk", message: "Chunking text…" });
  const rawChunks = chunkPages(pages, chunkParams);
  if (!rawChunks.length) throw new Error("No text chunks produced from PDF.");

  const docId = crypto.randomUUID();
  let blobStored = false;
  try {
    await store.putPdfBlob(docId, buffer, sizeBytes);
    blobStored = true;

    const chunkTexts = rawChunks.map((c) => c.text);
    const allEmbeddings = [];
    const batchSize = 12;
    const fp = embedFingerprint(settings);
    let dims = 0;

    onProgress?.({
      phase: "embed",
      message: `Loading embed model (${fp.embedProvider}: ${fp.embedModel})…`,
    });

    for (let i = 0; i < chunkTexts.length; i += batchSize) {
      const batch = chunkTexts.slice(i, i + batchSize);
      onProgress?.({
        phase: "embed",
        message: `Embedding chunks ${Math.min(i + batch.length, chunkTexts.length)}/${chunkTexts.length}…`,
        done: i,
        total: chunkTexts.length,
      });
      const result = await embedTexts(batch, settings, { role: "passage" });
      if (!dims) dims = result.dims;
      allEmbeddings.push(...result.embeddings);
    }

    const now = Date.now();
    const chunks = rawChunks.map((c, idx) => ({
      id: crypto.randomUUID(),
      docId,
      page: c.loc.page,
      index: c.index,
      text: c.text,
      loc: c.loc,
      embedding: allEmbeddings[idx],
      embedProvider: fp.embedProvider,
      embedModel: fp.embedModel,
      dims,
      createdAt: now,
    }));

    const doc = {
      id: docId,
      name,
      mimeType: "application/pdf",
      pageCount,
      chunkCount: chunks.length,
      sizeBytes,
      chunkSize: chunkParams.chunkSize,
      chunkOverlap: chunkParams.chunkOverlap,
      embedProvider: fp.embedProvider,
      embedModel: fp.embedModel,
      dims,
      createdAt: now,
    };

    await store.putDocument(doc);
    await store.putChunks(chunks);

    onProgress?.({ phase: "done", message: "Ingest complete.", docId });
    return {
      docId,
      name,
      pageCount,
      chunkCount: chunks.length,
      sizeBytes,
      chunkSize: chunkParams.chunkSize,
      chunkOverlap: chunkParams.chunkOverlap,
      embedProvider: fp.embedProvider,
      embedModel: fp.embedModel,
    };
  } catch (err) {
    if (blobStored) {
      try {
        await store.deletePdfBlob(docId);
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}
