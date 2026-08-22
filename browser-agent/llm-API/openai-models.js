// Curated OpenAI flagship chat models (Chat Completions API).
// Pricing: OpenAI Standard tier, per 1M tokens — see platform.openai.com/docs/pricing

/** Default for new OpenAI users — balances intelligence and cost. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";

/**
 * @typedef {object} OpenAiModelInfo
 * @property {string} id
 * @property {string} label
 * @property {"flagship"|"balanced"|"economy"} tier
 * @property {string} inputs
 * @property {string} output
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {boolean} thinking
 * @property {boolean} tools
 * @property {string} priceIn
 * @property {string} priceOut
 * @property {string} [priceNote]
 * @property {string} [description]
 * @property {string[]} [aliases]
 */

/** @type {OpenAiModelInfo[]} */
export const OPENAI_FLAGSHIP_MODELS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    aliases: ["gpt-5.6"],
    tier: "flagship",
    description: "Frontier model for complex professional work",
    inputs: "Text, image",
    output: "Text",
    inputTokens: 1_050_000,
    outputTokens: 128_000,
    thinking: true,
    tools: true,
    priceIn: "$5.00",
    priceOut: "$30.00",
    priceNote: "≤272K input; 2× in / 1.5× out above 272K",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    tier: "balanced",
    description: "Balances intelligence and cost",
    inputs: "Text, image",
    output: "Text",
    inputTokens: 1_050_000,
    outputTokens: 128_000,
    thinking: true,
    tools: true,
    priceIn: "$2.00",
    priceOut: "$12.00",
    priceNote: "≤272K input; 2× in / 1.5× out above 272K",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    tier: "economy",
    description: "Optimized for cost-sensitive, high-volume workloads",
    inputs: "Text, image",
    output: "Text",
    inputTokens: 1_050_000,
    outputTokens: 128_000,
    thinking: true,
    tools: true,
    priceIn: "$0.20",
    priceOut: "$1.20",
    priceNote: "≤272K input; 2× in / 1.5× out above 272K",
  },
];

const ALIAS_TO_ID = Object.fromEntries(
  OPENAI_FLAGSHIP_MODELS.flatMap((m) => (m.aliases || []).map((alias) => [alias, m.id])),
);

export function listOpenAiFlagshipModels() {
  return OPENAI_FLAGSHIP_MODELS;
}

export function findOpenAiModel(modelId) {
  const id = normalizeOpenAiModelId(modelId);
  if (!id) return undefined;
  return OPENAI_FLAGSHIP_MODELS.find((m) => m.id === id || (m.aliases || []).includes(id));
}

export function normalizeOpenAiModelId(model) {
  return String(model || "").trim();
}

/**
 * Resolve a stored model id to a chat.completions model id.
 * @returns {{ model: string, migratedFrom: string|null }}
 */
export function resolveOpenAiModel(model) {
  const id = normalizeOpenAiModelId(model);
  if (!id) return { model: DEFAULT_OPENAI_MODEL, migratedFrom: model || null };
  const canonical = ALIAS_TO_ID[id] || id;
  return { model: canonical, migratedFrom: canonical !== id ? id : null };
}

export function openAiModelLabel(modelId) {
  return findOpenAiModel(modelId)?.label || modelId?.split("/").pop() || modelId;
}

function formatTokenCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

/** Dropdown label with price hint. */
export function formatOpenAiPickerLabel(model) {
  const m = typeof model === "string" ? findOpenAiModel(model) : model;
  if (!m) return model?.id || model || "";
  const price = m.priceIn && m.priceOut ? ` — ${m.priceIn}/${m.priceOut} per 1M` : "";
  return `${m.label}${price}`;
}

/** One-line summary for Settings catalog rows. */
export function formatOpenAiModelMeta(model) {
  const m = typeof model === "string" ? findOpenAiModel(model) : model;
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
