// OpenAI-compatible chat + embeddings (OpenAI, NVIDIA NIM, openai-compatible).

import {
  isNvidiaNimProvider,
  providerRequiresApiKey,
  resolveApiKey,
  resolveChatModel,
  resolveLlmBaseUrl,
} from "../llm-providers.js";
import {
  errorResponse,
  openAiCompatibleErrorMessage,
  openAiFetchErrorMessage,
  readJsonResponse,
  readOpenAiCompatibleResponse,
  remoteHttpErrorMessage,
  REMOTE_LLM_FETCH_TIMEOUT_MS,
} from "./shared.js";

/** Map internal thinkingEnabled → provider-specific request fields (never send thinkingEnabled itself). */
function buildOpenAiCompatibleBody(request, settings, baseUrl) {
  const { thinkingEnabled, ...apiRequest } = request;
  const body = { ...apiRequest, model: request.model || resolveChatModel(settings) };
  if (isNvidiaNimProvider(settings?.provider, baseUrl)) {
    delete body.tool_choice;
    delete body.tools;
  }
  if (!isNvidiaNimProvider(settings?.provider, baseUrl)) return body;

  const model = (body.model || "").toLowerCase();
  const enabled = thinkingEnabled !== false;
  if (model.includes("glm") || model.startsWith("z-ai/")) {
    return {
      ...body,
      chat_template_kwargs: { enable_thinking: enabled, clear_thinking: false },
    };
  }
  if (model.includes("qwen3") || model.includes("deepseek")) {
    return {
      ...body,
      chat_template_kwargs: {
        enable_thinking: enabled,
        ...(model.includes("deepseek") ? { thinking: enabled } : {}),
      },
    };
  }
  return body;
}

export async function openaiChatCompletions(request, settings) {
  const baseUrl = resolveLlmBaseUrl(settings);
  const provider = settings?.provider || "onnx";
  const apiKey = resolveApiKey(settings, provider);
  const model = request.model || resolveChatModel(settings);

  if (!baseUrl) {
    return errorResponse("No Base URL configured — set it in Settings.", "engine_error");
  }
  if (!model) {
    return errorResponse("No model selected — pick a model in Settings.", "engine_error");
  }
  if (providerRequiresApiKey(provider) && !apiKey) {
    const label =
      provider === "nvidia-nim"
        ? "NVIDIA API key (nvapi-…)"
        : provider === "gemini"
          ? "Gemini API key"
          : "API key";
    return errorResponse(`${label} required — add it in Settings.`, "engine_error");
  }

  const payload = buildOpenAiCompatibleBody({ ...request, model }, settings, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_LLM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const parsed = await readOpenAiCompatibleResponse(res);
    if (!res.ok) {
      const rawDetail = parsed.body
        ? openAiCompatibleErrorMessage(parsed.body, res.status, `HTTP ${res.status}`)
        : parsed.error || `HTTP ${res.status}`;
      return errorResponse(remoteHttpErrorMessage(res.status, provider, rawDetail), "engine_error");
    }
    if (parsed.error || !parsed.body) {
      return errorResponse(parsed.error || `empty response (HTTP ${res.status})`, "engine_error");
    }
    return parsed.body;
  } catch (err) {
    return errorResponse(openAiFetchErrorMessage(err, baseUrl, settings), "engine_error");
  } finally {
    clearTimeout(timer);
  }
}

function resolveEmbedApiProvider(settings, provider) {
  if (provider === "openai-compatible") return "openai-compatible";
  if (provider === "nvidia-nim") return "nvidia-nim";
  return provider;
}

/** OpenAI-compatible /embeddings — OpenAI, NVIDIA NIM, openai-compatible. */
export async function openaiEmbeddings(texts, settings, model, providerOverride) {
  const provider = providerOverride || resolveEmbedApiProvider(settings, settings?.provider || "openai");
  const baseUrl = resolveLlmBaseUrl({ ...settings, provider }).replace(/\/$/, "");
  const apiKey = resolveApiKey(settings, provider);
  const modelId = model || settings?.ragOpenaiEmbedModel || "text-embedding-3-small";

  if (!baseUrl) throw new Error("No Base URL configured — set it in Settings.");
  if (providerRequiresApiKey(provider) && !apiKey) {
    const label =
      provider === "nvidia-nim" ? "NVIDIA API key (nvapi-…)" : provider === "gemini" ? "Gemini API key" : "API key";
    throw new Error(`${label} required — add it in Settings.`);
  }

  const input = Array.isArray(texts) ? texts : [texts];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_LLM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: modelId, input }),
      signal: controller.signal,
    });
    const parsed = await readJsonResponse(res);
    if (!res.ok) {
      const rawDetail = parsed.body?.error?.message || parsed.body?.message || parsed.error || `HTTP ${res.status}`;
      throw new Error(remoteHttpErrorMessage(res.status, provider, rawDetail));
    }
    const data = parsed.body?.data;
    if (!Array.isArray(data) || !data.length) {
      throw new Error("OpenAI-compatible embed response missing embedding vectors.");
    }
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((row) => row.embedding);
  } catch (err) {
    throw new Error(openAiFetchErrorMessage(err, baseUrl, settings));
  } finally {
    clearTimeout(timer);
  }
}
