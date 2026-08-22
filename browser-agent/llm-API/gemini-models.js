// Curated Gemini chat models (Google AI generateContent API).
// Pricing: Google AI Standard tier (paid), per 1M tokens — see ai.google.dev/gemini-api/docs/pricing

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Default for new users — replaces retired gemini-2.5-flash-lite. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** Models blocked for new users or shut down — mapped to replacements. */
export const DEPRECATED_GEMINI_MODELS = {
  "gemini-2.5-flash": "gemini-3.6-flash",
  "gemini-2.5-flash-preview-05-20": "gemini-3.6-flash",
  "gemini-2.5-flash-preview-09-25": "gemini-3.6-flash",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite-preview-09-2025": "gemini-3.5-flash-lite",
  "gemini-2.0-flash": "gemini-3.1-flash-lite",
  "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
  "gemini-1.5-flash": "gemini-3.5-flash-lite",
  "gemini-1.5-pro": "gemini-3.1-pro-preview",
};

/**
 * @typedef {object} GeminiModelInfo
 * @property {string} id
 * @property {string} label
 * @property {"stable"|"preview"} tier
 * @property {string} inputs Human-readable input modalities
 * @property {string} output Human-readable output modalities
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {boolean} thinking
 * @property {boolean} tools Function calling
 * @property {string} priceIn Standard paid tier, per 1M input tokens (USD)
 * @property {string} priceOut Standard paid tier, per 1M output tokens (USD); includes thinking tokens
 * @property {string} [priceNote]
 * @property {boolean} [fromApi] True when merged from live models.list
 * @property {string} [replaces] Deprecated model id this entry supersedes
 */

/** Strip API resource prefix and lowercase for lookup. */
export function normalizeGeminiModelId(model) {
  return String(model || "")
    .trim()
    .replace(/^models\//i, "");
}

/**
 * Resolve a stored/API model id to an available generateContent model.
 * @returns {{ model: string, migratedFrom: string|null }}
 */
export function resolveGeminiModel(model) {
  let id = normalizeGeminiModelId(model);
  if (!id) return { model: DEFAULT_GEMINI_MODEL, migratedFrom: model || null };
  const lower = id.toLowerCase();
  const replacement = DEPRECATED_GEMINI_MODELS[lower];
  if (replacement) return { model: replacement, migratedFrom: id };
  return { model: id, migratedFrom: null };
}

/** Patch settings when a deprecated Gemini model is selected. */
export function migrateGeminiModelSettings(settings) {
  if (settings?.provider !== "gemini") return null;
  const { model, migratedFrom } = resolveGeminiModel(settings.model);
  if (!migratedFrom) return null;
  return { model };
}

/** @type {GeminiModelInfo[]} */
export const GEMINI_MODELS = [
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    tier: "stable",
    inputs: "Text, image, video, audio, PDF",
    output: "Text",
    inputTokens: 1_048_576,
    outputTokens: 65_536,
    thinking: true,
    tools: true,
    priceIn: "$1.50",
    priceOut: "$7.50",
    priceNote: "replaces gemini-2.5-flash",
    replaces: "gemini-2.5-flash",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    tier: "stable",
    inputs: "Text, image, video, audio, PDF",
    output: "Text",
    inputTokens: 1_048_576,
    outputTokens: 65_536,
    thinking: true,
    tools: true,
    priceIn: "$1.50",
    priceOut: "$9.00",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    tier: "stable",
    inputs: "Text, image, video, audio, PDF",
    output: "Text",
    inputTokens: 1_048_576,
    outputTokens: 65_536,
    thinking: true,
    tools: true,
    priceIn: "$0.30",
    priceOut: "$2.50",
    priceNote: "text / image / video / audio; replaces 2.5 Flash-Lite",
    replaces: "gemini-2.5-flash-lite",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    tier: "stable",
    inputs: "Text, image, video, audio, PDF",
    output: "Text",
    inputTokens: 1_048_576,
    outputTokens: 65_536,
    thinking: true,
    tools: true,
    priceIn: "$0.25–$0.50",
    priceOut: "$1.50",
    priceNote: "audio input $0.50/1M",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    tier: "preview",
    inputs: "Text, image, video, audio, PDF",
    output: "Text",
    inputTokens: 1_048_576,
    outputTokens: 65_536,
    thinking: true,
    tools: true,
    priceIn: "$2.00 / $4.00",
    priceOut: "$12.00 / $18.00",
    priceNote: "≤200k / >200k input tokens; replaces gemini-2.5-pro",
    replaces: "gemini-2.5-pro",
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    tier: "preview",
    inputs: "Text, image, video, audio, PDF",
    output: "Text",
    inputTokens: 1_048_576,
    outputTokens: 65_536,
    thinking: true,
    tools: true,
    priceIn: "$0.50–$1.00",
    priceOut: "$3.00",
    priceNote: "audio input $1.00/1M",
  },
];

let apiDiscoveredModels = [];

export function listGeminiModels() {
  const curatedIds = new Set(GEMINI_MODELS.map((m) => m.id));
  const deprecated = new Set(Object.keys(DEPRECATED_GEMINI_MODELS));
  const extras = apiDiscoveredModels.filter((m) => !curatedIds.has(m.id) && !deprecated.has(m.id));
  return [...GEMINI_MODELS, ...extras];
}

export function setGeminiApiDiscoveredModels(models) {
  apiDiscoveredModels = Array.isArray(models) ? models : [];
}

export function findGeminiModel(modelId) {
  return listGeminiModels().find((m) => m.id === modelId);
}

export function geminiModelLabel(modelId) {
  return findGeminiModel(modelId)?.label || modelId?.split("/").pop() || modelId;
}

/** Whether thinkingConfig is meaningful for this model id. */
export function geminiModelSupportsThinking(model) {
  const entry = findGeminiModel(model);
  if (entry) return entry.thinking;
  const m = (model || "").toLowerCase();
  return /gemini-(2\.5|3)/.test(m);
}

function formatTokenCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

/** One-line summary for Settings catalog rows. */
export function formatGeminiModelMeta(model) {
  const m = typeof model === "string" ? findGeminiModel(model) : model;
  if (!m) return "";
  const parts = [];
  if (m.priceIn && m.priceOut) parts.push(`${m.priceIn} in · ${m.priceOut} out /1M`);
  parts.push(m.thinking ? "thinking" : "no thinking");
  parts.push(m.tools ? "tools" : "no tools");
  parts.push(`in: ${m.inputs}`);
  parts.push(`out: ${m.output}`);
  const ctx = formatTokenCount(m.inputTokens);
  if (ctx) parts.push(ctx);
  if (m.priceNote) parts.push(m.priceNote);
  return parts.join(" · ");
}

/** Dropdown label with price hint. */
export function formatGeminiPickerLabel(model) {
  const m = typeof model === "string" ? findGeminiModel(model) : model;
  if (!m) return model?.id || model || "";
  const price = m.priceIn && m.priceOut ? ` — ${m.priceIn}/${m.priceOut} per 1M` : "";
  return `${m.label}${price}`;
}

/**
 * Live models.list from Google (requires API key). Merges into listGeminiModels().
 * @param {string} apiKey
 * @param {string} [baseUrl]
 */
export async function fetchGeminiModelsFromApi(apiKey, baseUrl = GEMINI_API_BASE_URL) {
  const key = (apiKey || "").trim();
  if (!key) throw new Error("Gemini API key required.");

  const discovered = [];
  let pageToken = "";
  const root = baseUrl.replace(/\/$/, "");

  do {
    const qs = new URLSearchParams({ key, pageSize: "100" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(`${root}/models?${qs}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error?.message || `models.list failed (HTTP ${res.status})`);
    }

    for (const entry of body.models || []) {
      const methods = entry.supportedGenerationMethods || entry.supported_generation_methods || [];
      if (!methods.includes("generateContent")) continue;
      const id = String(entry.name || "").replace(/^models\//, "");
      if (!id) continue;
      if (DEPRECATED_GEMINI_MODELS[id.toLowerCase()]) continue;

      const curated = GEMINI_MODELS.find((m) => m.id === id);
      if (curated) {
        discovered.push({ ...curated, fromApi: true });
        continue;
      }

      discovered.push({
        id,
        label: entry.displayName || id,
        tier: id.includes("preview") || id.includes("exp") ? "preview" : "stable",
        inputs: "See model docs",
        output: "Text",
        inputTokens: entry.inputTokenLimit || 0,
        outputTokens: entry.outputTokenLimit || 0,
        thinking: entry.thinking === true,
        tools: true,
        priceIn: "—",
        priceOut: "—",
        priceNote: "Pricing not in models.list — check ai.google.dev pricing",
        fromApi: true,
      });
    }

    pageToken = body.nextPageToken || "";
  } while (pageToken);

  discovered.sort((a, b) => a.id.localeCompare(b.id));
  setGeminiApiDiscoveredModels(discovered.filter((m) => !GEMINI_MODELS.some((c) => c.id === m.id)));
  return listGeminiModels();
}
