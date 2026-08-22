// Shared HTTP helpers for remote LLM API providers.

import {
  REMOTE_LLM_FETCH_TIMEOUT_MS,
  resolveApiKey,
  resolveChatModel,
} from "../llm-providers.js";

export { REMOTE_LLM_FETCH_TIMEOUT_MS };

export function errorResponse(message, type) {
  return { error: { message, type, code: null } };
}

export async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return { error: `empty response (HTTP ${res.status})` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: `invalid JSON (HTTP ${res.status}): ${text.slice(0, 120)}` };
  }
}

export async function readOpenAiCompatibleResponse(res) {
  const text = await res.text();
  if (!text) return { error: `empty response (HTTP ${res.status})` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: text.trim().slice(0, 240) };
  }
}

export function openAiCompatibleErrorMessage(body, status, fallback) {
  if (typeof body === "string") return body;
  if (body?.error?.message) return body.error.message;
  if (body?.detail) return String(body.detail);
  if (body?.message) return String(body.message);
  if (typeof body?.error === "string") return body.error;
  return fallback;
}

function remoteProviderLabel(provider) {
  if (provider === "nvidia-nim") return "NVIDIA NIM";
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  if (provider === "openai-compatible") return "API";
  return "API";
}

/** Actionable message for remote HTTP errors (especially rate limits). */
export function remoteHttpErrorMessage(status, provider, fallbackDetail) {
  if (status === 429) {
    const label = remoteProviderLabel(provider);
    const extra =
      provider === "nvidia-nim"
        ? " Free-tier NIM accounts have strict RPM limits; wait several minutes before retrying (repeated calls while blocked extend the lockout). Check quota at build.nvidia.com."
        : " Wait a minute before retrying.";
    return `${label} rate limit (HTTP 429).${extra}`;
  }
  return fallbackDetail || `HTTP ${status}`;
}

export function openAiFetchErrorMessage(err, baseUrl, settings) {
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl || "the API host";
    }
  })();
  if (err?.name === "AbortError") {
    const model = resolveChatModel(settings) || "";
    const slowHint = /glm|nemotron|550b|120b/i.test(model)
      ? " Large NVIDIA models like GLM-5.2 can take 60+ seconds."
      : "";
    return `Request timed out after ${Math.round(REMOTE_LLM_FETCH_TIMEOUT_MS / 1000)}s.${slowHint} Keep the side panel open and try again.`;
  }
  const msg = err?.message || String(err);
  if (/failed to fetch/i.test(msg)) {
    const provider = settings?.provider || "onnx";
    if (provider === "nvidia-nim" && !resolveApiKey(settings, "nvidia-nim")) {
      return "Network request failed — add your NVIDIA API key (nvapi-…) in Settings and reload the extension.";
    }
    if (provider === "gemini" && !resolveApiKey(settings, "gemini")) {
      return "Network request failed — add your Gemini API key in Settings and reload the extension.";
    }
    if (!baseUrl) {
      return "Network request failed — no Base URL configured in Settings.";
    }
    return `Network request failed reaching ${host}. Check your internet connection, API key, and reload the extension after updates.`;
  }
  return msg;
}
