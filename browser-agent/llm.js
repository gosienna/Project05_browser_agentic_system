// Internal protocol: every provider is consumed through the OpenAI
// chat.completions request/response shape. See ONNX_ENGINE_PLAN.md §3.

import { toAnthropicTools, toGeminiTools } from "./tools/schema.js";
import { getMaxTokens, resolveMaxTokens } from "./agent-config.js";
import {
  isNvidiaNimProvider,
  providerRequiresApiKey,
  REMOTE_LLM_FETCH_TIMEOUT_MS,
  resolveApiKey,
  resolveChatModel,
  resolveLlmBaseUrl,
  resolveOllamaBaseUrl,
} from "./llm-providers.js";
import { geminiModelSupportsThinking, resolveGeminiModel } from "./gemini-models.js";
import { listOllamaInstalled, ollamaFetch, resolveOllamaInstalledName } from "./ollama-models.js";
import { isThinkingEnabled, normalizeChatCompletion } from "./reasoning-content.js";
import { stripUnsupportedNativeTools } from "./webllm-models.js";

const ONNX_OFFSCREEN_URL = "offscreen.html";
let offscreenReadyPromise = null;

/**
 * @param {{model?:string, messages:Array<{role:string,content:string}>, tools?:object[], temperature?:number, max_tokens?:number, stream?:boolean}} request
 * @param {object} settings
 * @returns {Promise<object>} OpenAI-shaped chat.completion (or {error} on failure)
 */
function withThinkingRequest(request, settings) {
  const thinkingEnabled = isThinkingEnabled(settings);
  return { ...request, thinkingEnabled };
}

function finalizeChatCompletion(response, settings) {
  if (response?.error) return response;
  return normalizeChatCompletion(response, { thinkingEnabled: isThinkingEnabled(settings) });
}

export async function chatCompletions(request, settings) {
  const req = stripUnsupportedNativeTools(withThinkingRequest(request, settings), settings);
  if (req.max_tokens == null) req.max_tokens = getMaxTokens(settings);
  const provider = settings?.provider || "onnx";
  let response;
  switch (provider) {
    case "onnx":
      response = await onnxChatCompletions(req, settings);
      break;
    case "webllm":
      response = await webllmChatCompletions(req, settings);
      break;
    case "openai":
    case "openai-compatible":
    case "nvidia-nim":
      response = await openaiChatCompletions(req, settings);
      break;
    case "ollama":
      response = await ollamaChatCompletions(req, settings);
      break;
    case "anthropic":
      response = await anthropicChatCompletions(req, settings);
      break;
    case "gemini":
      response = await geminiChatCompletions(req, settings);
      break;
    default:
      return errorResponse(`Unknown provider "${provider}"`, "engine_error");
  }
  return finalizeChatCompletion(response, settings);
}

/** Render chat template without inference (Dialogue input preview). */
export async function renderChatPromptPreview(request, settings) {
  const provider = settings?.provider || "onnx";
  switch (provider) {
    case "onnx":
      return onnxRenderChatPrompt(request, settings);
    case "webllm":
      return { prompt: null };
    case "ollama": {
      const baseUrl = resolveOllamaBaseUrl(settings);
      const model = await resolveOllamaRequestModel(
        baseUrl,
        request.model || settings.model || "llama3.2"
      );
      const prompt = await ollamaFetchRenderedPrompt(baseUrl, model, request);
      return { prompt };
    }
    default:
      return { prompt: null };
  }
}

/** Back-compat convenience wrapper used by agent.js and the system editors. */
export async function chat(messages, settings) {
  const request = {
    model: settings?.model,
    messages,
    temperature: settings?.temperature ?? 0.2,
    max_tokens: getMaxTokens(settings),
  };
  const response = await chatCompletions(request, settings);
  if (response.error) throw new Error(response.error.message);
  return response.choices?.[0]?.message?.content ?? "";
}

// --- onnx (in-browser, via offscreen document) -------------------------

export async function ensureOffscreenDocument() {
  if (offscreenReadyPromise) return offscreenReadyPromise;

  offscreenReadyPromise = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing && existing.length > 0) return;

    try {
      await chrome.offscreen.createDocument({
        url: ONNX_OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run local ONNX/WebLLM inference engines off the service worker.",
      });
    } catch (err) {
      // "Only a single offscreen document may be created" -> already exists, fine.
      if (!String(err?.message || err).includes("single offscreen")) throw err;
    }
  })();

  try {
    await offscreenReadyPromise;
  } catch (err) {
    offscreenReadyPromise = null;
    throw err;
  }
  return offscreenReadyPromise;
}

async function onnxChatCompletions(request, settings) {
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    return errorResponse(`Could not start local engine: ${err.message}`, "engine_error");
  }

  const model = request.model || settings?.onnxModel;
  if (!model) {
    return errorResponse("No ONNX model selected — open Settings and pick a model to download.", "model_not_loaded");
  }

  try {
    const response = await chrome.runtime.sendMessage({
      target: "onnx-engine",
      type: "chat.completions",
      request: { ...request, model },
    });
    if (!response) {
      return errorResponse("Local engine did not respond (offscreen document may have been evicted).", "engine_error");
    }
    return response;
  } catch (err) {
    return errorResponse(`Local engine error: ${err.message}`, "engine_error");
  }
}

async function onnxRenderChatPrompt(request, settings) {
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    console.warn("[onnx] render prompt:", err);
    return { prompt: null };
  }

  const model = request.model || settings?.onnxModel;
  if (!model) return { prompt: null };

  try {
    const response = await chrome.runtime.sendMessage({
      target: "onnx-engine",
      type: "chat.renderPrompt",
      request: { ...request, model },
    });
    if (!response || response.error) return { prompt: null };
    return { prompt: typeof response.prompt === "string" ? response.prompt : null };
  } catch (err) {
    console.warn("[onnx] render prompt failed:", err);
    return { prompt: null };
  }
}

async function webllmChatCompletions(request, settings) {
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    return errorResponse(`Could not start local engine: ${err.message}`, "engine_error");
  }

  const model = request.model || settings?.webllmModel;
  if (!model) {
    return errorResponse("No WebLLM model selected — open Settings and pick a model to download.", "model_not_loaded");
  }

  try {
    const payload = stripUnsupportedNativeTools({ ...request, model }, settings);
    const response = await chrome.runtime.sendMessage({
      target: "webllm-engine",
      type: "chat.completions",
      request: payload,
    });
    if (!response) {
      return errorResponse("WebLLM engine did not respond (offscreen document may have been evicted).", "engine_error");
    }
    return response;
  } catch (err) {
    return errorResponse(`WebLLM engine error: ${err.message}`, "engine_error");
  }
}

// --- openai / openai-compatible / nvidia-nim -----------------------------

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

async function readOpenAiCompatibleResponse(res) {
  const text = await res.text();
  if (!text) return { error: `empty response (HTTP ${res.status})` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: text.trim().slice(0, 240) };
  }
}

function openAiCompatibleErrorMessage(body, status, fallback) {
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
function remoteHttpErrorMessage(status, provider, fallbackDetail) {
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

function openAiFetchErrorMessage(err, baseUrl, settings) {
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

async function openaiChatCompletions(request, settings) {
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

// --- ollama --------------------------------------------------------------

function ollamaHttpError(baseUrl, status, detail) {
  if (status === 403) {
    return (
      `Ollama at ${baseUrl} rejected the request (HTTP 403 — CORS). ` +
      "Reload the extension after updating, or restart Ollama with OLLAMA_ORIGINS=\"*\" " +
      "(macOS: launchctl setenv OLLAMA_ORIGINS \"*\" then restart the Ollama app)."
    );
  }
  return `Ollama at ${baseUrl}: ${detail || `HTTP ${status}`}`;
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return { error: `empty response (HTTP ${res.status})` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: `invalid JSON (HTTP ${res.status}): ${text.slice(0, 120)}` };
  }
}

const OLLAMA_CHAT_ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Ollama native /api/chat expects object arguments, not OpenAI stringified JSON. */
function ollamaToolCallArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toOllamaToolCalls(tool_calls) {
  return tool_calls.map((tc) => {
    const fn = tc?.function || {};
    const name = fn.name || tc?.name;
    const args = ollamaToolCallArguments(fn.arguments ?? tc?.arguments);
    const out = { type: tc?.type || "function" };
    if (tc?.id) out.id = tc.id;
    out.function = { name, arguments: args };
    return out;
  });
}

function toOllamaChatMessages(messages) {
  return (messages || [])
    .filter((m) => OLLAMA_CHAT_ROLES.has(m.role))
    .map((m) => {
      const out = { role: m.role };
      if (m.content !== undefined) out.content = m.content;
      if (m.tool_calls?.length) out.tool_calls = toOllamaToolCalls(m.tool_calls);
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_name) out.tool_name = m.tool_name;
      return out;
    });
}

function buildOllamaNativeChatBody(model, request) {
  const options = { temperature: request.temperature };
  if (request.max_tokens != null) options.num_predict = request.max_tokens;
  const body = {
    model,
    messages: toOllamaChatMessages(request.messages),
    stream: false,
    think: request.thinkingEnabled !== false,
    options,
  };
  if (request.tools?.length) body.tools = request.tools;
  return body;
}

function ollamaAssistantMessage(msg) {
  if (!msg || typeof msg !== "object") return { role: "assistant", content: "" };
  const out = { role: "assistant", content: msg.content ?? "" };
  const reasoning = msg.thinking ?? msg.reasoning ?? msg.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) out.reasoning = reasoning.trim();
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) out.tool_calls = msg.tool_calls;
  return out;
}

function ollamaChatCompletionFromNative(body, model) {
  const message = ollamaAssistantMessage(body.message);
  const finishReason = message.tool_calls?.length
    ? "tool_calls"
    : body.done
      ? "stop"
      : "length";
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: body.prompt_eval_count ?? 0,
      completion_tokens: body.eval_count ?? 0,
      total_tokens: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
    },
  };
}

/** Rendered chat template via Ollama's _debug_render_only (no inference). */
async function ollamaFetchRenderedPrompt(baseUrl, model, request) {
  try {
    const res = await ollamaFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...buildOllamaNativeChatBody(model, request),
        _debug_render_only: true,
      }),
    });
    const parsed = await readJsonResponse(res);
    if (parsed.error) {
      console.warn("[ollama] prompt render:", parsed.error);
      return null;
    }
    if (!res.ok) {
      console.warn("[ollama] prompt render:", ollamaHttpError(baseUrl, res.status, parsed.body?.error));
      return null;
    }
    const rendered =
      parsed.body?._debug_info?.rendered_template ?? parsed.body?.debug_info?.rendered_template;
    return typeof rendered === "string" && rendered.length > 0 ? rendered : null;
  } catch (err) {
    console.warn("[ollama] prompt render failed:", err);
    return null;
  }
}

async function ollamaNativeChatCompletions(baseUrl, model, request) {
  const res = await ollamaFetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaNativeChatBody(model, request)),
  });
  const parsed = await readJsonResponse(res);
  if (parsed.error) {
    return errorResponse(ollamaHttpError(baseUrl, res.status, parsed.error), "engine_error");
  }
  const body = parsed.body;
  if (!res.ok) return errorResponse(ollamaHttpError(baseUrl, res.status, body?.error), "engine_error");
  return ollamaChatCompletionFromNative(body, model);
}

async function resolveOllamaRequestModel(baseUrl, requested) {
  const { installed } = await listOllamaInstalled(baseUrl);
  return resolveOllamaInstalledName(requested, installed);
}

async function ollamaChatCompletions(request, settings) {
  const baseUrl = resolveOllamaBaseUrl(settings);
  const model = await resolveOllamaRequestModel(
    baseUrl,
    request.model || settings.model || "llama3.2"
  );
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

  // Native /api/chat handles tools without OpenAI tool_choice (v1 shim needs server flags).
  if (hasTools) {
    try {
      return await ollamaNativeChatCompletions(baseUrl, model, request);
    } catch (err) {
      return errorResponse(
        `Could not reach Ollama at ${baseUrl}. Is the Ollama app running? (${err.message})`,
        "engine_error"
      );
    }
  }

  const v1Body = {
    ...request,
    model,
    stream: false,
    think: request.thinkingEnabled !== false,
  };
  delete v1Body.tool_choice;

  // Prefer Ollama's OpenAI-compatible shim; fall back to native /api/chat on any failure.
  try {
    const res = await ollamaFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v1Body),
    });
    if (res.status !== 404) {
      const parsed = await readJsonResponse(res);
      if (res.ok && parsed.body && !parsed.body.error) {
        return parsed.body;
      }
      const detail =
        parsed.body?.error?.message || parsed.error || (res.ok ? null : `HTTP ${res.status}`);
      console.warn("[ollama] /v1/chat/completions failed, falling back to /api/chat:", detail);
    }
  } catch (err) {
    console.warn("[ollama] /v1/chat/completions fetch failed:", err);
  }

  try {
    return await ollamaNativeChatCompletions(baseUrl, model, request);
  } catch (err) {
    return errorResponse(
      `Could not reach Ollama at ${baseUrl}. Is the Ollama app running? (${err.message})`,
      "engine_error"
    );
  }
}

// --- gemini --------------------------------------------------------------

function appendGeminiContent(contents, role, parts) {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last?.role === role) {
    last.parts.push(...parts);
    return;
  }
  contents.push({ role, parts });
}

/** Gemini FunctionResponse.response is a protobuf Struct: a JSON object, never a list. */
function toGeminiFunctionResponse(value) {
  if (value == null) return {};
  if (Array.isArray(value)) return { result: value };
  if (typeof value === "object") return value;
  return { result: value };
}

function parseToolResultObject(content) {
  if (content == null || content === "") return {};
  if (typeof content === "object") return toGeminiFunctionResponse(content);
  if (typeof content !== "string") return { result: String(content) };
  try {
    return toGeminiFunctionResponse(JSON.parse(content));
  } catch {
    return { result: content };
  }
}

function cloneGeminiParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return undefined;
  try {
    return JSON.parse(JSON.stringify(parts));
  } catch {
    return undefined;
  }
}

function geminiPartThoughtSignature(part) {
  return part?.thoughtSignature ?? part?.thought_signature ?? null;
}

function buildToolCallNameMap(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

function toGeminiContents(messages) {
  const contents = [];
  const systemParts = [];
  const toolCallNames = buildToolCallNameMap(messages);

  for (const m of messages || []) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.trim()) systemParts.push(m.content.trim());
      continue;
    }

    if (m.role === "tool") {
      const name = m.tool_name || toolCallNames.get(m.tool_call_id) || "tool";
      const part = {
        functionResponse: {
          name,
          response: parseToolResultObject(m.content),
          ...(m.tool_call_id ? { id: m.tool_call_id } : {}),
        },
      };
      appendGeminiContent(contents, "user", [part]);
      continue;
    }

    if (m.role === "assistant") {
      if (Array.isArray(m.gemini_parts) && m.gemini_parts.length) {
        appendGeminiContent(contents, "model", m.gemini_parts);
        continue;
      }

      const parts = [];
      if (typeof m.content === "string" && m.content.trim()) parts.push({ text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            args = {};
          }
          const call = {
            name: tc.function?.name || "tool",
            args,
          };
          if (tc.id) call.id = tc.id;
          const part = { functionCall: call };
          const sig = tc.thought_signature ?? tc.thoughtSignature;
          if (sig) part.thoughtSignature = sig;
          parts.push(part);
        }
      }
      appendGeminiContent(contents, "model", parts);
      continue;
    }

    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    appendGeminiContent(contents, "user", [{ text }]);
  }

  return {
    contents,
    systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined,
  };
}

function buildGeminiGenerationConfig(request, model) {
  const config = {
    temperature: request.temperature ?? 0.2,
    maxOutputTokens: resolveMaxTokens(request.max_tokens),
  };
  if (!geminiModelSupportsThinking(model)) return config;

  const enabled = request.thinkingEnabled !== false;
  config.thinkingConfig = enabled
    ? { includeThoughts: true, thinkingBudget: -1 }
    : { includeThoughts: false, thinkingBudget: 0 };
  return config;
}

function geminiAssistantFromParts(parts) {
  const message = { role: "assistant", content: "" };
  const tool_calls = [];
  const reasoningParts = [];
  const gemini_parts = cloneGeminiParts(parts);
  if (gemini_parts) message.gemini_parts = gemini_parts;

  for (const part of parts || []) {
    if (typeof part.text === "string") {
      if (part.thought) reasoningParts.push(part.text);
      else message.content += part.text;
    }
    const fnCall = part.functionCall || part.function_call;
    if (fnCall?.name) {
      const toolCall = {
        id: fnCall.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: fnCall.name,
          arguments: JSON.stringify(fnCall.args && typeof fnCall.args === "object" ? fnCall.args : {}),
        },
      };
      const sig = geminiPartThoughtSignature(part);
      if (sig) toolCall.thought_signature = sig;
      tool_calls.push(toolCall);
    }
  }

  message.content = message.content.trim();
  if (!message.content) message.content = null;
  if (reasoningParts.length) message.reasoning = reasoningParts.join("\n\n").trim();
  if (tool_calls.length) message.tool_calls = tool_calls;
  return message;
}

function geminiChatCompletionFromBody(body, model) {
  const candidate = body.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const message = geminiAssistantFromParts(parts);
  const finishReason = message.tool_calls?.length
    ? "tool_calls"
    : candidate?.finishReason === "MAX_TOKENS"
      ? "length"
      : "stop";
  const usage = body.usageMetadata || {};

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
  };
}

function geminiErrorMessage(body, status) {
  if (typeof body === "string") return body;
  if (body?.error?.message) return body.error.message;
  if (Array.isArray(body?.error?.details) && body.error.details[0]?.message) {
    return body.error.details[0].message;
  }
  return `HTTP ${status}`;
}

function geminiUnavailableModelMessage(model, bodyMessage) {
  const msg = bodyMessage || "";
  if (/no longer available/i.test(msg)) {
    const { model: replacement, migratedFrom } = resolveGeminiModel(model);
    if (migratedFrom) {
      return `${msg} Switched recommendation: use "${replacement}" in Settings (replaces ${migratedFrom}).`;
    }
    return `${msg} Try "${replacement}" or refresh the model list in Settings.`;
  }
  return msg;
}

async function geminiChatCompletions(request, settings) {
  const baseUrl = resolveLlmBaseUrl(settings).replace(/\/$/, "");
  const apiKey = resolveApiKey(settings, "gemini");
  const resolved = resolveGeminiModel(request.model || resolveChatModel(settings));
  const model = resolved.model;

  if (!apiKey) {
    return errorResponse("Gemini API key required — add it in Settings.", "engine_error");
  }
  if (!model) {
    return errorResponse("No model selected — pick a model in Settings.", "engine_error");
  }

  const { contents, systemInstruction } = toGeminiContents(request.messages);
  if (!contents.length) {
    return errorResponse("No messages to send.", "engine_error");
  }

  const body = {
    contents,
    generationConfig: buildGeminiGenerationConfig(request, model),
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const tools = toGeminiTools(request.tools);
  if (tools) {
    body.tools = tools;
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_LLM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = await readOpenAiCompatibleResponse(res);
    if (!res.ok) {
      const detail = parsed.body
        ? geminiUnavailableModelMessage(model, geminiErrorMessage(parsed.body, res.status))
        : parsed.error || `HTTP ${res.status}`;
      return errorResponse(detail, "engine_error");
    }
    if (parsed.error || !parsed.body) {
      return errorResponse(parsed.error || `empty response (HTTP ${res.status})`, "engine_error");
    }
    if (parsed.body.error) {
      return errorResponse(geminiErrorMessage(parsed.body, res.status), "engine_error");
    }
    return geminiChatCompletionFromBody(parsed.body, model);
  } catch (err) {
    return errorResponse(openAiFetchErrorMessage(err, baseUrl, settings), "engine_error");
  } finally {
    clearTimeout(timer);
  }
}

// --- anthropic -------------------------------------------------------------

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    const role = m.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: m.content });
  }
  return out;
}

async function anthropicChatCompletions(request, settings) {
  const baseUrl = (settings.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const messages = toAnthropicMessages(request.messages.filter((m) => m.role !== "system"));
  const tools =
    Array.isArray(request.tools) && request.tools.length ? toAnthropicTools(request.tools) : undefined;

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": resolveApiKey(settings, "anthropic"),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model || settings.model || "claude-sonnet-5",
        system: system || undefined,
        messages,
        ...(tools ? { tools } : {}),
        max_tokens: request.max_tokens,
        temperature: request.temperature,
      }),
    });
    const body = await res.json();
    if (!res.ok) return errorResponse(body?.error?.message || `HTTP ${res.status}`, "engine_error");

    const blocks = body.content || [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const tool_calls = toolUses.map((tu) => ({
      id: tu.id,
      type: "function",
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input && typeof tu.input === "object" ? tu.input : {}),
      },
    }));

    const finishReason =
      body.stop_reason === "tool_use"
        ? "tool_calls"
        : body.stop_reason === "end_turn"
          ? "stop"
          : "length";

    return {
      id: body.id || `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text || null,
            ...(tool_calls.length ? { tool_calls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: body.usage?.input_tokens ?? 0,
        completion_tokens: body.usage?.output_tokens ?? 0,
        total_tokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      },
    };
  } catch (err) {
    return errorResponse(err.message, "engine_error");
  }
}

function errorResponse(message, type) {
  return { error: { message, type, code: null } };
}

/** Ollama /api/embed — used by RAG (batch). Legacy /api/embeddings uses `prompt`, not `input`. */
export async function ollamaEmbeddings(texts, settings, model) {
  const baseUrl = resolveOllamaBaseUrl(settings);
  const modelId = await resolveOllamaRequestModel(
    baseUrl,
    model || settings?.ragOllamaEmbedModel || "nomic-embed-text"
  );
  const input = Array.isArray(texts) ? texts : [texts];
  const res = await ollamaFetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, input }),
  });
  const parsed = await readJsonResponse(res);
  if (!res.ok) {
    throw new Error(ollamaHttpError(baseUrl, res.status, parsed.body?.error || parsed.error));
  }
  const body = parsed.body;
  if (Array.isArray(body?.embeddings)) return body.embeddings;
  if (body?.embedding) return [body.embedding];
  throw new Error("Ollama embed response missing embedding vectors.");
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

function geminiEmbedModelPath(modelId) {
  const id = String(modelId || "").replace(/^models\//, "");
  return `models/${id}`;
}

/** Gemini batchEmbedContents — used by RAG. */
export async function geminiEmbeddings(texts, settings, model) {
  const baseUrl = resolveLlmBaseUrl({ ...settings, provider: "gemini" }).replace(/\/$/, "");
  const apiKey = resolveApiKey(settings, "gemini");
  const modelId = model || settings?.ragGeminiEmbedModel || "text-embedding-004";

  if (!apiKey) throw new Error("Gemini API key required — add it in Settings.");

  const input = Array.isArray(texts) ? texts : [texts];
  const modelPath = geminiEmbedModelPath(modelId);
  const requests = input.map((text) => ({
    model: modelPath,
    content: { parts: [{ text }] },
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_LLM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/${modelPath}:batchEmbedContents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({ requests }),
      signal: controller.signal,
    });
    const parsed = await readJsonResponse(res);
    if (!res.ok) {
      const detail = parsed.body?.error?.message || parsed.error || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    const embeddings = parsed.body?.embeddings;
    if (!Array.isArray(embeddings) || !embeddings.length) {
      throw new Error("Gemini embed response missing embedding vectors.");
    }
    return embeddings.map((row) => row.values || row.embedding);
  } catch (err) {
    throw new Error(openAiFetchErrorMessage(err, baseUrl, settings));
  } finally {
    clearTimeout(timer);
  }
}
