// LLM provider ids, defaults, and thinking-toggle availability for Settings UI.

import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE_URL, geminiModelSupportsThinking, resolveGeminiModel } from "./gemini-models.js";
import { DEFAULT_NVIDIA_NIM_MODEL } from "./nvidia-nim-models.js";
import { DEFAULT_OPENAI_MODEL, resolveOpenAiModel } from "./openai-models.js";

export const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export { GEMINI_API_BASE_URL };
export const REMOTE_LLM_FETCH_TIMEOUT_MS = 180_000;

const REMOTE_LLM_PROVIDERS = new Set([
  "ollama",
  "openai",
  "anthropic",
  "openai-compatible",
  "nvidia-nim",
  "gemini",
]);

export function isRemoteLlmProvider(provider) {
  return REMOTE_LLM_PROVIDERS.has(provider);
}

export function isOpenAiCompatibleProvider(provider) {
  return provider === "openai" || provider === "openai-compatible" || provider === "nvidia-nim";
}

export function isNvidiaNimBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "integrate.api.nvidia.com" || host.endsWith(".nvidia.com");
  } catch {
    return /integrate\.api\.nvidia\.com/i.test(baseUrl || "");
  }
}

export function isNvidiaNimProvider(provider, baseUrl) {
  if (provider === "nvidia-nim") return true;
  return isNvidiaNimBaseUrl(baseUrl);
}

export function resolveLlmBaseUrl(settings) {
  const provider = settings?.provider || "onnx";
  const trimmed = (settings?.baseUrl || "").replace(/\/$/, "");
  switch (provider) {
    case "nvidia-nim":
      return NVIDIA_NIM_BASE_URL;
    case "gemini":
      return GEMINI_API_BASE_URL;
    case "openai":
      return trimmed || "https://api.openai.com/v1";
    case "anthropic":
      return trimmed || "https://api.anthropic.com";
    case "ollama":
      return trimmed || "http://127.0.0.1:11434";
    default:
      return trimmed;
  }
}

/** Active chat model id for the configured provider. */
export function resolveChatModel(settings) {
  const provider = settings?.provider || "onnx";
  if (provider === "onnx") return settings?.onnxModel;
  if (provider === "webllm") return settings?.webllmModel;
  if (provider === "nvidia-nim") return settings?.model || DEFAULT_NVIDIA_NIM_MODEL;
  if (provider === "gemini") return resolveGeminiModel(settings?.model || DEFAULT_GEMINI_MODEL).model;
  if (provider === "openai") return resolveOpenAiModel(settings?.model || DEFAULT_OPENAI_MODEL).model;
  return settings?.model;
}

export function providerRequiresApiKey(provider) {
  return provider === "openai" || provider === "anthropic" || provider === "nvidia-nim" || provider === "gemini";
}

export function nvidiaModelSupportsThinking(model) {
  const m = (model || "").toLowerCase();
  return m.includes("glm") || m.startsWith("z-ai/") || m.includes("qwen3") || m.includes("deepseek");
}

/**
 * Whether the Settings “Enable model reasoning” checkbox should be interactive.
 * @param {string} provider
 */
export function providerSupportsThinkingToggle(provider) {
  return getProviderThinkingMeta(provider).available;
}

/**
 * @param {string} provider
 * @returns {{ available: boolean, hint: string }}
 */
export function getProviderThinkingMeta(provider) {
  switch (provider) {
    case "onnx":
      return {
        available: true,
        hint:
          "Supported for Qwen3 and Gemma 4 via enable_thinking in the chat template. Other ONNX models ignore this.",
      };
    case "webllm":
      return {
        available: true,
        hint: "Sent as enable_thinking for Qwen3 WebLLM models. Other models ignore this setting.",
      };
    case "ollama":
      return {
        available: true,
        hint: "Sent as think: true/false. Models without thinking support ignore this.",
      };
    case "nvidia-nim":
      return {
        available: true,
        hint:
          "Mapped to chat_template_kwargs for GLM, Qwen3, and DeepSeek models on NVIDIA NIM. Other NIM models ignore this.",
      };
    case "gemini":
      return {
        available: true,
        hint:
          "Mapped to generationConfig.thinkingConfig for Gemini 2.5+ models (includeThoughts and thinkingBudget). Other Gemini models ignore this.",
      };
    case "openai":
      return {
        available: false,
        hint:
          "Not available for OpenAI here. Reasoning models use reasoning_effort in the OpenAI API, which this extension does not send.",
      };
    case "anthropic":
      return {
        available: false,
        hint:
          "Not available for Anthropic here. Extended thinking uses Anthropic thinking parameters, which this extension does not send.",
      };
    case "openai-compatible":
      return {
        available: false,
        hint:
          "Not available for custom OpenAI-compatible endpoints. Thinking flags are provider-specific and are not sent in this mode.",
      };
    default:
      return {
        available: false,
        hint: "Thinking control is not available for this provider.",
      };
  }
}

/** Provider-specific hint, including optional model caveats (e.g. NVIDIA NIM). */
export function getThinkingHintForSettings(settings) {
  const provider = settings?.provider || "onnx";
  const meta = getProviderThinkingMeta(provider);
  if (provider === "nvidia-nim" && settings?.model && !nvidiaModelSupportsThinking(settings.model)) {
    return `${meta.hint} The selected model may not support thinking control.`;
  }
  if (provider === "gemini" && settings?.model && !geminiModelSupportsThinking(settings.model)) {
    return `${meta.hint} The selected model may not support thinking control.`;
  }
  return meta.hint;
}
