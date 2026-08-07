/** Ollama model metadata, catalog, pull/delete helpers for model pickers and Settings. */

const showCache = new Map();

/**
 * Curated Ollama library models for Settings (ollamadb.dev is offline).
 * Pull id matches `ollama pull <id>` on ollama.com/library.
 */
export const OLLAMA_MODEL_REGISTRY = [
  {
    id: "llama3.2",
    label: "Llama 3.2",
    description: "Meta's compact instruction-tuned model; strong default for agents.",
    labels: ["1B", "3B"],
    capability: "Tools",
    modelType: "official",
    tier: "default",
    approxSizeMB: 2000,
  },
  {
    id: "llama3.1",
    label: "Llama 3.1",
    description: "Meta Llama 3.1 — 8B/70B/405B; tool use on larger sizes.",
    labels: ["8B", "70B", "405B"],
    capability: "Tools",
    modelType: "official",
    approxSizeMB: 4700,
  },
  {
    id: "qwen2.5",
    label: "Qwen 2.5",
    description: "Alibaba Qwen 2.5 — multilingual, strong coding and reasoning.",
    labels: ["0.5B", "1.5B", "3B", "7B", "14B", "32B", "72B"],
    capability: "Tools",
    modelType: "official",
    approxSizeMB: 4500,
  },
  {
    id: "qwen3",
    label: "Qwen 3",
    description: "Qwen 3 with thinking/reasoning support on select sizes.",
    labels: ["0.6B", "1.7B", "4B", "8B", "14B", "32B"],
    capability: "Thinking",
    modelType: "official",
    approxSizeMB: 5000,
  },
  {
    id: "qwen2.5-coder",
    label: "Qwen 2.5 Coder",
    description: "Code-focused Qwen variant for programming tasks.",
    labels: ["1.5B", "7B", "14B", "32B"],
    modelType: "official",
    approxSizeMB: 4700,
  },
  {
    id: "mistral",
    label: "Mistral",
    description: "Mistral 7B — fast general-purpose chat.",
    labels: ["7B"],
    modelType: "official",
    approxSizeMB: 4100,
  },
  {
    id: "mistral-nemo",
    label: "Mistral Nemo",
    description: "12B model co-developed with NVIDIA.",
    labels: ["12B"],
    modelType: "official",
    approxSizeMB: 7000,
  },
  {
    id: "mixtral",
    label: "Mixtral",
    description: "Mixture-of-experts; high quality at 8x7B scale.",
    labels: ["8x7B", "8x22B"],
    modelType: "official",
    approxSizeMB: 26000,
  },
  {
    id: "gemma2",
    label: "Gemma 2",
    description: "Google Gemma 2 open models.",
    labels: ["2B", "9B", "27B"],
    modelType: "official",
    approxSizeMB: 5500,
  },
  {
    id: "gemma3",
    label: "Gemma 3",
    description: "Google Gemma 3 — multimodal on larger sizes.",
    labels: ["1B", "4B", "12B", "27B"],
    capability: "Vision",
    modelType: "official",
    approxSizeMB: 8000,
  },
  {
    id: "phi3",
    label: "Phi 3",
    description: "Microsoft Phi-3 small language models.",
    labels: ["mini", "small", "medium"],
    modelType: "official",
    approxSizeMB: 2300,
  },
  {
    id: "phi4",
    label: "Phi 4",
    description: "Microsoft Phi-4 reasoning-oriented model.",
    labels: ["14B"],
    capability: "Thinking",
    modelType: "official",
    approxSizeMB: 9000,
  },
  {
    id: "deepseek-r1",
    label: "DeepSeek R1",
    description: "DeepSeek R1 reasoning models (distilled sizes available).",
    labels: ["1.5B", "7B", "8B", "14B", "32B", "70B"],
    capability: "Thinking",
    modelType: "official",
    approxSizeMB: 4700,
  },
  {
    id: "deepseek-v3",
    label: "DeepSeek V3",
    description: "DeepSeek V3 flagship MoE model.",
    labels: ["671B"],
    modelType: "official",
    approxSizeMB: 400000,
  },
  {
    id: "llava",
    label: "LLaVA",
    description: "Vision-language model for image + text.",
    labels: ["7B", "13B", "34B"],
    capability: "Vision",
    modelType: "official",
    approxSizeMB: 4700,
  },
  {
    id: "moondream",
    label: "Moondream",
    description: "Small vision model for image understanding.",
    labels: ["1.8B"],
    capability: "Vision",
    modelType: "official",
    approxSizeMB: 1700,
  },
  {
    id: "ministral-3",
    label: "Ministral 3",
    description: "Mistral small models with vision on 3B/8B/14B.",
    labels: ["3B", "8B", "14B"],
    capability: "Vision",
    modelType: "official",
    approxSizeMB: 6000,
  },
  {
    id: "hermes3",
    label: "Hermes 3",
    description: "Nous Hermes 3 — tool-calling friendly Llama derivative.",
    labels: ["3B", "8B", "70B", "405B"],
    capability: "Tools",
    modelType: "official",
    approxSizeMB: 4700,
  },
  {
    id: "granite3.3",
    label: "Granite 3.3",
    description: "IBM Granite 3.3 enterprise models.",
    labels: ["2B", "8B"],
    capability: "Tools",
    modelType: "official",
    approxSizeMB: 5000,
  },
  {
    id: "command-r",
    label: "Command R",
    description: "Cohere Command R for RAG and tool use.",
    labels: ["7B", "35B"],
    capability: "Tools",
    modelType: "official",
    approxSizeMB: 19000,
  },
  {
    id: "codellama",
    label: "Code Llama",
    description: "Meta Code Llama for code generation.",
    labels: ["7B", "13B", "34B", "70B"],
    modelType: "official",
    approxSizeMB: 3800,
  },
  {
    id: "llama3",
    label: "Llama 3",
    description: "Meta Llama 3 (previous generation).",
    labels: ["8B", "70B"],
    modelType: "official",
    approxSizeMB: 4700,
  },
];

/** Loopback fetch for local Ollama HTTP API (Chrome 142+ LNA). */
export function ollamaFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    targetAddressSpace: "loopback",
  });
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
}

/** Base model name without tag, e.g. `llama3.2:latest` → `llama3.2`. */
export function normalizeOllamaModelBase(name) {
  return String(name || "").split(":")[0];
}

/** True if any installed name matches the catalog / pull id. */
export function isOllamaModelInstalled(installed, modelId) {
  const base = normalizeOllamaModelBase(modelId);
  for (const name of installed) {
    if (name === modelId || normalizeOllamaModelBase(name) === base) return true;
  }
  return false;
}

/** Concrete installed tag names for a catalog id (for delete UI). */
export function getInstalledVariants(installed, modelId) {
  const base = normalizeOllamaModelBase(modelId);
  return [...installed].filter((name) => name === modelId || normalizeOllamaModelBase(name) === base);
}

/** Human-readable input → output summary from Ollama capabilities. */
export function formatOllamaIoLabel(capabilities = []) {
  const caps = new Set((capabilities || []).map((c) => String(c).toLowerCase()));
  const inputs = ["text"];
  if (caps.has("vision")) inputs.push("image");
  if (caps.has("audio")) inputs.push("audio");

  const outputs = [];
  if (caps.has("completion") || caps.has("thinking") || caps.has("tools")) outputs.push("text");
  if (caps.has("image")) outputs.push("image");
  if (caps.has("embedding") && !outputs.length) outputs.push("embedding");
  if (!outputs.length) outputs.push("text");

  return `${inputs.join("+")}→${outputs.join("+")}`;
}

/** Model family / size / quant / special type from Ollama details + capabilities. */
export function formatOllamaTypeLabel(details = {}, capabilities = []) {
  const parts = [];
  if (details.family) parts.push(details.family);
  if (details.parameter_size) parts.push(details.parameter_size);
  if (details.quantization_level) parts.push(details.quantization_level);

  const caps = new Set((capabilities || []).map((c) => String(c).toLowerCase()));
  if (caps.has("thinking")) parts.push("thinking");
  if (caps.has("embedding") && !caps.has("completion")) parts.push("embedding");
  if (caps.has("tools")) parts.push("tools");

  return parts.join(" · ") || "model";
}

/** Full dropdown label: `name (type · io)`. */
export function formatOllamaModelLabel(name, details = {}, capabilities = []) {
  const type = formatOllamaTypeLabel(details, capabilities);
  const io = formatOllamaIoLabel(capabilities);
  return `${name} (${type} · ${io})`;
}

/** Settings registry secondary line for catalog rows. */
export function formatOllamaCatalogMeta(entry = {}) {
  const parts = [];
  if (entry.labels?.length) parts.push(entry.labels.join("/"));
  if (entry.capability) parts.push(entry.capability);
  if (entry.modelType) parts.push(entry.modelType);
  if (entry.approxSizeMB != null) {
    const mb = Number(entry.approxSizeMB);
    parts.push(mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${mb} MB`);
  }
  if (entry.pulls != null) {
    const p = Number(entry.pulls);
    parts.push(p >= 1_000_000 ? `${(p / 1_000_000).toFixed(1)}M pulls` : p >= 1000 ? `${(p / 1000).toFixed(1)}K pulls` : `${p} pulls`);
  }
  return parts.filter(Boolean).join(" · ");
}

function filterOllamaRegistry({ search, capability, modelType } = {}) {
  let list = OLLAMA_MODEL_REGISTRY;
  if (modelType === "official") {
    list = list.filter((m) => m.modelType === "official");
  }
  if (capability) {
    const cap = capability.toLowerCase();
    list = list.filter((m) => (m.capability || "").toLowerCase() === cap);
  }
  if (search?.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
    );
  }
  return list;
}

/**
 * Return a page of models from the bundled catalog (search, filter, paginate).
 * @returns {Promise<{ models: object[], totalCount: number, limit: number, skip: number }>}
 */
export async function fetchOllamaCatalog({
  search,
  skip = 0,
  limit = 40,
  capability,
  modelType,
  signal,
} = {}) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const filtered = filterOllamaRegistry({ search, capability, modelType });
  const models = filtered.slice(skip, skip + limit);
  return {
    models,
    totalCount: filtered.length,
    limit,
    skip,
  };
}

/**
 * List locally installed model names from Ollama GET /api/tags.
 * @returns {Promise<{ installed: Set<string>, reachable: boolean, error?: string }>}
 */
export async function listOllamaInstalled(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await ollamaFetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { installed: new Set(), reachable: true, error: `HTTP ${res.status}` };
    }
    const body = await res.json();
    const installed = new Set((body.models || []).map((m) => m.name));
    return { installed, reachable: true };
  } catch (err) {
    return { installed: new Set(), reachable: false, error: err.message };
  }
}

/**
 * Pull a model via POST /api/pull (streaming NDJSON progress).
 * @param {string} baseUrl
 * @param {string} model
 * @param {{ onProgress?: (event: object) => void, signal?: AbortSignal }} [opts]
 */
export async function pullOllamaModel(baseUrl, model, { onProgress, signal } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await ollamaFetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) {
        const parsed = JSON.parse(text);
        detail = parsed.error || text.slice(0, 200);
      }
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEvent = null;

  const handleLine = (line) => {
    if (!line.trim()) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    lastEvent = event;
    onProgress?.(event);
    if (event.error) throw new Error(event.error);
    if (event.status === "success") return event;
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const doneEvent = handleLine(line);
      if (doneEvent) return doneEvent;
    }
  }
  if (buffer.trim()) {
    const doneEvent = handleLine(buffer);
    if (doneEvent) return doneEvent;
  }
  if (lastEvent?.status === "success") return lastEvent;
  throw new Error("Pull ended without success");
}

/** Delete a local model via POST /api/delete. */
export async function deleteOllamaModel(baseUrl, name) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await ollamaFetch(`${base}/api/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) {
        const parsed = JSON.parse(text);
        detail = parsed.error || text.slice(0, 200);
      }
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function fetchOllamaShow(baseUrl, modelName) {
  const cacheKey = `${baseUrl}\0${modelName}`;
  if (showCache.has(cacheKey)) return showCache.get(cacheKey);

  const promise = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await ollamaFetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();

  showCache.set(cacheKey, promise);
  return promise;
}

/**
 * List local Ollama models with type and I/O metadata for dropdowns.
 * @returns {Promise<Array<{ id: string, label: string, details?: object, capabilities?: string[] }>>}
 */
export async function listOllamaModelsWithMeta(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await ollamaFetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const body = await res.json();
    const models = body.models || [];
    if (!models.length) return [];

    const enriched = await Promise.all(
      models.map(async (m) => {
        const name = m.name;
        const details = m.details || {};
        const show = await fetchOllamaShow(base, name);
        const capabilities = show?.capabilities || [];
        return {
          id: name,
          label: formatOllamaModelLabel(name, show?.details || details, capabilities),
          details: show?.details || details,
          capabilities,
        };
      })
    );
    return enriched;
  } catch {
    return [];
  }
}

/** Build downloaded-map keys for dialogue (catalog id + concrete tag names). */
export function ollamaInstalledDownloadMap(installed) {
  const map = {};
  for (const name of installed) {
    map[name] = true;
    map[normalizeOllamaModelBase(name)] = true;
  }
  return map;
}
