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
      embeddings.push(response.output?.embedding || []);
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
  return sorted.map((e) => e.embedding);
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
  return ollamaEmbeddings(texts, settings, modelId);
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
