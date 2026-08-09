// Semantic search over ingested RAG chunks.

import { embedFingerprint } from "./config.js";
import { embedQuery } from "./embed.js";
import * as store from "./rag-store.js";

function dot(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function isChunkCompatible(chunk, settings) {
  const fp = embedFingerprint(settings);
  return (
    chunk.embedProvider === fp.embedProvider &&
    chunk.embedModel === fp.embedModel &&
    (chunk.dims == null || chunk.dims === chunk.embedding?.length)
  );
}

export function isDocumentCompatible(doc, settings) {
  const fp = embedFingerprint(settings);
  return doc.embedProvider === fp.embedProvider && doc.embedModel === fp.embedModel;
}

/**
 * @param {string} query
 * @param {object} settings
 * @param {{ docIds?: string[], topK?: number }} opts
 */
export async function searchDocuments(query, settings, opts = {}) {
  const topK = Math.min(Math.max(opts.topK ?? 5, 1), 20);
  const { embedding: qVec } = await embedQuery(query, settings);
  const fp = embedFingerprint(settings);

  let chunks;
  if (opts.docIds?.length) {
    const lists = await Promise.all(opts.docIds.map((id) => store.getChunksByDoc(id)));
    chunks = lists.flat();
  } else {
    chunks = await store.getAllChunks();
  }

  const compatible = chunks.filter(
    (c) =>
      c.embedProvider === fp.embedProvider &&
      c.embedModel === fp.embedModel &&
      Array.isArray(c.embedding) &&
      c.embedding.length === qVec.length
  );

  const scored = compatible
    .map((c) => ({ chunk: c, score: dot(qVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const docs = await store.listDocuments();
  const docMap = new Map(docs.map((d) => [d.id, d]));

  return scored.map(({ chunk, score }) => {
    const doc = docMap.get(chunk.docId);
    return {
      chunk_id: chunk.id,
      doc_id: chunk.docId,
      doc_name: doc?.name || chunk.docId,
      page: chunk.page,
      index: chunk.index,
      text: chunk.text,
      score,
      loc: chunk.loc,
    };
  });
}

export function formatSearchHit(hit) {
  return {
    chunk_id: hit.chunk_id,
    doc_id: hit.doc_id,
    doc_name: hit.doc_name,
    page: hit.page,
    score: hit.score,
    text: hit.text,
    loc: hit.loc,
  };
}
