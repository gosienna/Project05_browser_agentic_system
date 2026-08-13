// PDF ingest: chunk → embed → IndexedDB (parse runs in the side panel, not the service worker).

import { validateChunkParams, chunkPages } from "./chunk.js";
import {
  embedBatchSizeForProvider,
  embedFingerprint,
  isRemoteEmbedProvider,
  REMOTE_EMBED_BATCH_DELAY_MS,
} from "./config.js";
import { embedTexts } from "./embed.js";
import * as store from "./rag-store.js";
import { upsertDocEmbedVariant, upsertEmbedVariant } from "./vectors.js";

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
    const fp = embedFingerprint(settings);
    const batchSize = embedBatchSizeForProvider(fp.embedProvider);
    const throttleRemote = isRemoteEmbedProvider(fp.embedProvider);
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
      if (throttleRemote && i + batchSize < chunkTexts.length) {
        await new Promise((r) => setTimeout(r, REMOTE_EMBED_BATCH_DELAY_MS));
      }
    }

    const now = Date.now();
    const variant = {
      embedProvider: fp.embedProvider,
      embedModel: fp.embedModel,
      dims,
    };
    const chunks = rawChunks.map((c, idx) =>
      upsertEmbedVariant(
        {
          id: crypto.randomUUID(),
          docId,
          page: c.loc.page,
          index: c.index,
          text: c.text,
          loc: c.loc,
          createdAt: now,
        },
        { ...variant, vector: allEmbeddings[idx] }
      )
    );

    const doc = upsertDocEmbedVariant(
      {
        id: docId,
        name,
        mimeType: "application/pdf",
        pageCount,
        chunkCount: chunks.length,
        sizeBytes,
        chunkSize: chunkParams.chunkSize,
        chunkOverlap: chunkParams.chunkOverlap,
        createdAt: now,
      },
      variant
    );

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
