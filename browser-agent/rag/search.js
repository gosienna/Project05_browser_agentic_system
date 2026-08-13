// Semantic search over ingested RAG chunks.

import { embedFingerprint } from "./config.js";
import { embedQuery, normalizeEmbeddingVector } from "./embed.js";
import * as store from "./rag-store.js";
import { findEmbedVariant, listEmbedVariants } from "./vectors.js";

/** Cosine similarity; vectors are L2-normalized at embed time for ONNX (pooling + normalize). */
function cosineSimilarity(a, b) {
  const va = normalizeEmbeddingVector(a);
  const vb = normalizeEmbeddingVector(b);
  if (!va || !vb || va.length !== vb.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    const x = va[i];
    const y = vb[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function isChunkCompatible(chunk, settings) {
  const fp = embedFingerprint(settings);
  const variant = findEmbedVariant(chunk, fp);
  if (!variant) return false;
  const vecLen = normalizeEmbeddingVector(variant.vector)?.length;
  return Boolean(vecLen) && (variant.dims == null || variant.dims === vecLen);
}

export function isDocumentCompatible(doc, settings) {
  const fp = embedFingerprint(settings);
  return Boolean(findEmbedVariant(doc, fp));
}

function explainEmptySearch(chunks, fp, qVector) {
  if (!chunks.length) return "No text chunks found for the selected document(s).";
  const variants = chunks.flatMap((c) => listEmbedVariants(c));
  const withVectors = variants.filter((v) => normalizeEmbeddingVector(v.vector)?.length);
  if (!withVectors.length) {
    return "Chunks have no embedding vectors — delete the PDF and attach it again (previous ingest likely used a broken embed step).";
  }
  const storedModels = [...new Set(variants.map((v) => `${v.embedProvider}:${v.embedModel}`))];
  const current = `${fp.embedProvider}:${fp.embedModel}`;
  const matching = chunks.map((c) => findEmbedVariant(c, fp)).filter(Boolean);
  if (!matching.length) {
    return `Embedding model mismatch: document has ${storedModels.join(", ")} but search uses ${current}. Use Re-embed in the Documents panel to add vectors for the current model (existing variants are kept).`;
  }
  const qLen = qVector.length;
  const chunkLens = [
    ...new Set(matching.map((v) => normalizeEmbeddingVector(v.vector)?.length).filter(Boolean)),
  ];
  if (!chunkLens.includes(qLen)) {
    return `Embedding size mismatch (query ${qLen} vs stored ${chunkLens.join("/")}). Re-embed the PDF with the current embed model.`;
  }
  return "No matching chunks after filtering — try re-ingesting the PDF.";
}

/**
 * @param {string} query
 * @param {object} settings
 * @param {{ docIds?: string[], topK?: number }} opts
 */
export async function searchDocuments(query, settings, opts = {}) {
  const topK = Math.min(Math.max(opts.topK ?? 5, 1), 20);
  const { embedding: qVec } = await embedQuery(query, settings);
  const qVector = normalizeEmbeddingVector(qVec);
  if (!qVector?.length) {
    throw new Error(
      "Query embedding was empty — check Settings → LLM embedding model, reload the extension, and re-embed or re-ingest PDFs."
    );
  }
  const fp = embedFingerprint(settings);

  let chunks;
  if (opts.docIds != null) {
    if (!opts.docIds.length) {
      chunks = [];
    } else {
      const lists = await Promise.all(opts.docIds.map((id) => store.getChunksByDoc(id)));
      chunks = lists.flat();
    }
  } else {
    chunks = await store.getAllChunks();
  }

  const compatible = [];
  for (const c of chunks) {
    const variant = findEmbedVariant(c, fp);
    const vec = normalizeEmbeddingVector(variant?.vector);
    if (vec?.length === qVector.length) compatible.push({ chunk: c, vector: vec });
  }

  if (!compatible.length && chunks.length) {
    throw new Error(explainEmptySearch(chunks, fp, qVector));
  }

  const scored = compatible
    .map(({ chunk, vector }) => ({ chunk, score: cosineSimilarity(qVector, vector) }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
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
