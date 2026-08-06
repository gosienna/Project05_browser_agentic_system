/** Ollama model metadata helpers for model pickers and labels. */

const showCache = new Map();

function ollamaFetch(url, options = {}) {
  return fetch(url, { ...options, targetAddressSpace: "loopback" });
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
  const base = (baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
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
