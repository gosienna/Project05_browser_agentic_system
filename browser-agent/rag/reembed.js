// Add or refresh one (provider, model) embedding variant on existing chunks.

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
 * @param {string} docId
 * @param {object} settings
 * @param {(p: object) => void} [onProgress]
 */
export async function reembedDocument(docId, settings, onProgress) {
  const doc = await store.getDocument(docId);
  if (!doc) throw new Error(`Document "${docId}" not found.`);

  const chunks = await store.getChunksByDoc(docId);
  if (!chunks.length) throw new Error(`No chunks found for "${doc.name}".`);

  const fp = embedFingerprint(settings);
  const batchSize = embedBatchSizeForProvider(fp.embedProvider);
  const throttleRemote = isRemoteEmbedProvider(fp.embedProvider);
  const chunkTexts = chunks.map((c) => c.text);
  const allEmbeddings = [];
  let dims = 0;

  onProgress?.({
    phase: "embed",
    message: `Loading embed model (${fp.embedProvider}: ${fp.embedModel})…`,
    docId,
  });

  for (let i = 0; i < chunkTexts.length; i += batchSize) {
    const batch = chunkTexts.slice(i, i + batchSize);
    onProgress?.({
      phase: "embed",
      message: `Re-embedding ${Math.min(i + batch.length, chunkTexts.length)}/${chunkTexts.length} chunks…`,
      done: i,
      total: chunkTexts.length,
      docId,
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
  const updatedChunks = chunks.map((c, idx) =>
    upsertEmbedVariant(
      { ...c, createdAt: c.createdAt || now },
      { ...variant, vector: allEmbeddings[idx] }
    )
  );

  const updatedDoc = upsertDocEmbedVariant(doc, variant);

  await store.putChunks(updatedChunks);
  await store.putDocument(updatedDoc);

  onProgress?.({ phase: "done", message: "Re-embed complete.", docId });
  return {
    docId,
    name: doc.name,
    chunkCount: updatedChunks.length,
    embedProvider: fp.embedProvider,
    embedModel: fp.embedModel,
  };
}
