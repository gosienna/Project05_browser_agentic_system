// RAG embedding router (ONNX / WebLLM / Ollama).

import { ensureOffscreenDocument, ollamaEmbeddings } from "../llm.js";
import {
  isOllamaModelInstalled,
  listOllamaInstalled,
  pullOllamaModel,
} from "../ollama-models.js";
import {
  EMBED_BATCH_SIZE,
  prefixForEmbed,
  resolveEmbedModel,
  resolveEmbedProvider,
} from "./config.js";

export { embedFingerprint, resolveEmbedModel, resolveEmbedProvider } from "./config.js";

/** Normalize ONNX / WebLLM / IDB embedding values into a plain number[]. */
export function normalizeEmbeddingVector(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw) && raw.length) return raw;
  if (typeof raw?.length === "number" && raw.length > 0) {
    try {
      const arr = Array.from(raw);
      return arr.length ? arr : null;
    } catch {
      /* not array-like */
    }
  }
  if (raw?.data != null) {
    const arr = Array.from(raw.data);
    return arr.length ? arr : null;
  }
  if (typeof raw?.tolist === "function") {
    const arr = raw.tolist().flat();
    return arr.length ? arr : null;
  }
  if (typeof raw === "object") {
    const keys = Object.keys(raw)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map((k) => Number(raw[k]));
  }
  return null;
}

function requireEmbeddingVector(vec, provider, model, hint = "") {
  const normalized = normalizeEmbeddingVector(vec);
  if (!normalized?.length) {
    throw new Error(
      `Embedding model returned an empty vector (${provider}: ${model}).${hint ? ` ${hint}` : ""} Check Settings → RAG embedding model and reload the extension.`
    );
  }
  return normalized;
}

async function onnxEmbed(texts, modelId) {
  await ensureOffscreenDocument();
  const embeddings = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    for (const text of batch) {
      const response = await chrome.runtime.sendMessage({
        target: "onnx-engine",
        type: "engine.run",
        request: { task: "feature-extraction", model: modelId, input: text },
      });
      if (!response) {
        throw new Error("Local ONNX engine did not respond — reload the extension and try again.");
      }
      if (response?.error) throw new Error(response.error.message);
      const raw = response?.output?.embedding ?? response?.output ?? response?.embedding;
      embeddings.push(requireEmbeddingVector(raw, "onnx", modelId));
    }
  }
  return embeddings;
}

async function webllmEmbed(texts, modelId) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "webllm-engine",
    type: "embeddings.create",
    request: { model: modelId, input: texts.length === 1 ? texts[0] : texts },
  });
  if (!response) {
    throw new Error("Local WebLLM engine did not respond — reload the extension and try again.");
  }
  if (response?.error) throw new Error(response.error.message);
  const sorted = [...(response.embeddings || [])].sort((a, b) => a.index - b.index);
  return sorted.map((e, i) =>
    requireEmbeddingVector(e?.embedding, "webllm", modelId, `Missing embedding at index ${i}.`)
  );
}

function broadcastOllamaPullProgress(event) {
  chrome.runtime.sendMessage({ target: "ollama-progress", ...event }).catch(() => {});
}

async function ensureOllamaEmbedModel(settings, modelId) {
  const baseUrl = (settings?.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const { installed, reachable, error } = await listOllamaInstalled(baseUrl);
  if (!reachable) {
    throw new Error(`Ollama not reachable at ${baseUrl}: ${error || "connection failed"}`);
  }
  if (isOllamaModelInstalled(installed, modelId)) return;

  await pullOllamaModel(baseUrl, modelId, {
    onProgress: (event) => {
      broadcastOllamaPullProgress(event);
      const pct =
        event.total && event.completed != null
          ? Math.round((event.completed / event.total) * 100)
          : null;
      const detail = [event.status || "pulling", pct != null ? `${pct}%` : ""].filter(Boolean).join(" ");
      chrome.runtime
        .sendMessage({
          target: "rag-progress",
          phase: "embed",
          message: `Pulling embed model ${modelId}… ${detail}`,
        })
        .catch(() => {});
    },
  });
}

async function ollamaEmbed(texts, settings, modelId) {
  await ensureOllamaEmbedModel(settings, modelId);
  const vectors = await ollamaEmbeddings(texts, settings, modelId);
  return vectors.map((v, i) =>
    requireEmbeddingVector(v, "ollama", modelId, `Missing embedding at index ${i}.`)
  );
}

/**
 * @param {string[]} texts
 * @param {object} settings
 * @param {{ role?: 'query'|'passage' }} opts
 */
export async function embedTexts(texts, settings, opts = {}) {
  const role = opts.role || "passage";
  const provider = resolveEmbedProvider(settings);
  const model = resolveEmbedModel(settings, provider);
  const prefixed = texts.map((t) => prefixForEmbed(t, role, model));

  let vectors;
  if (provider === "webllm") vectors = await webllmEmbed(prefixed, model);
  else if (provider === "ollama") vectors = await ollamaEmbed(prefixed, settings, model);
  else vectors = await onnxEmbed(prefixed, model);

  const dims = vectors[0]?.length ?? 0;
  return { embeddings: vectors, embedProvider: provider, embedModel: model, dims };
}

export async function embedQuery(query, settings) {
  const { embeddings, embedProvider, embedModel, dims } = await embedTexts([query], settings, {
    role: "query",
  });
  return { embedding: embeddings[0], embedProvider, embedModel, dims };
}
