// Per-(provider, model) embedding variants on RAG chunks and documents.

import { embedModelsMatch } from "./config.js";

function variantMatches(variant, fingerprint) {
  if (!variant || !fingerprint) return false;
  return (
    variant.embedProvider === fingerprint.embedProvider &&
    embedModelsMatch(variant.embedModel, fingerprint.embedModel)
  );
}

function shortEmbedModel(model) {
  const id = String(model || "").split(":")[0];
  return id.split("/").pop() || id;
}

function asVariantMeta(variant) {
  if (!variant) return null;
  return {
    embedProvider: variant.embedProvider,
    embedModel: variant.embedModel,
    dims: variant.dims,
  };
}

/**
 * Stored fingerprints on a chunk (`embeddings`) or document (`embedVariants`),
 * with a fallback to legacy top-level `embedProvider` / `embedModel` / `embedding`.
 */
export function listEmbedVariants(record) {
  if (!record) return [];
  if (Array.isArray(record.embeddings) && record.embeddings.length) {
    return record.embeddings;
  }
  if (Array.isArray(record.embedVariants) && record.embedVariants.length) {
    return record.embedVariants;
  }
  if (record.embedProvider || record.embedding) {
    return [
      {
        embedProvider: record.embedProvider,
        embedModel: record.embedModel,
        dims: record.dims,
        vector: record.embedding,
      },
    ];
  }
  return [];
}

export function findEmbedVariant(record, fingerprint) {
  return listEmbedVariants(record).find((v) => variantMatches(v, fingerprint)) || null;
}

/** Drop legacy single-vector fields so a migrated chunk does not store the same vector twice. */
export function stripLegacyEmbedding(chunk) {
  const next = { ...chunk };
  delete next.embedding;
  delete next.embedProvider;
  delete next.embedModel;
  delete next.dims;
  return next;
}

/** Replace or append one (provider, model) vector; leave other variants. */
export function upsertEmbedVariant(chunk, variant) {
  const existing = listEmbedVariants(chunk).map((v) => ({
    embedProvider: v.embedProvider,
    embedModel: v.embedModel,
    dims: v.dims,
    vector: v.vector,
  }));
  const next = {
    embedProvider: variant.embedProvider,
    embedModel: variant.embedModel,
    dims: variant.dims,
    vector: variant.vector,
  };
  const idx = existing.findIndex((v) => variantMatches(v, next));
  if (idx >= 0) existing[idx] = next;
  else existing.push(next);
  return stripLegacyEmbedding({ ...chunk, embeddings: existing });
}

/** Append or replace a document fingerprint; keep top-level fields as the latest variant. */
export function upsertDocEmbedVariant(doc, variant) {
  const existing = listEmbedVariants(doc).map((v) => asVariantMeta(v)).filter(Boolean);
  const next = asVariantMeta(variant);
  const idx = existing.findIndex((v) => variantMatches(v, next));
  if (idx >= 0) existing[idx] = next;
  else existing.push(next);
  return {
    ...doc,
    embedVariants: existing,
    embedProvider: next.embedProvider,
    embedModel: next.embedModel,
    dims: next.dims,
  };
}

export function formatEmbedVariantsSummary(record) {
  const variants = listEmbedVariants(record);
  if (!variants.length) return "";
  return variants.map((v) => `${v.embedProvider}/${shortEmbedModel(v.embedModel)}`).join(" · ");
}
