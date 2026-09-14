// Ollama server chat, prompt preview, and embeddings.

import { resolveOllamaBaseUrl } from "../llm-providers.js";
import { createGenerationProgressTracker } from "../llm-generation-progress.js";
import { listOllamaInstalled, ollamaFetch, resolveOllamaInstalledName } from "./ollama-models.js";
import { errorResponse, readJsonResponse, readNdjsonStream } from "./shared.js";

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

const OLLAMA_CHAT_ROLES = new Set(["system", "user", "assistant", "tool"]);

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

function buildOllamaNativeChatBody(model, request, { stream = false } = {}) {
  const options = { temperature: request.temperature };
  if (request.max_tokens != null) options.num_predict = request.max_tokens;
  const body = {
    model,
    messages: toOllamaChatMessages(request.messages),
    stream,
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

async function ollamaNativeChatCompletions(baseUrl, model, request) {
  const progress = createGenerationProgressTracker(request.requestId);
  const res = await ollamaFetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaNativeChatBody(model, request, { stream: true })),
    signal: request.signal,
  });
  if (!res.ok) {
    const parsed = await readJsonResponse(res);
    return errorResponse(
      ollamaHttpError(baseUrl, res.status, parsed.body?.error || parsed.error),
      "engine_error"
    );
  }

  let content = "";
  let reasoning = "";
  let toolCalls = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let done = false;

  await readNdjsonStream(res, (chunk) => {
    const msg = chunk?.message || {};
    let piece = "";
    if (typeof msg.content === "string" && msg.content) {
      piece = msg.content;
      content += piece;
    }
    const think = msg.thinking ?? msg.reasoning ?? msg.reasoning_content;
    if (typeof think === "string" && think) reasoning += think;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) toolCalls = msg.tool_calls;
    if (typeof chunk.prompt_eval_count === "number") promptTokens = chunk.prompt_eval_count;
    if (typeof chunk.eval_count === "number") completionTokens = chunk.eval_count;
    if (chunk.done) done = true;
    progress.push(piece || undefined, {
      text: content,
      completionTokens: completionTokens || undefined,
    });
  });

  const message = {
    role: "assistant",
    content,
    ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
  const finishReason = message.tool_calls?.length ? "tool_calls" : done ? "stop" : "length";
  progress.done({ text: content, completionTokens: completionTokens || undefined });
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export async function resolveOllamaRequestModel(baseUrl, requested) {
  const { installed } = await listOllamaInstalled(baseUrl);
  return resolveOllamaInstalledName(requested, installed);
}

/** Rendered chat template via Ollama's _debug_render_only (no inference). */
export async function ollamaFetchRenderedPrompt(baseUrl, model, request) {
  try {
    const res = await ollamaFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...buildOllamaNativeChatBody(model, request, { stream: false }),
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

export async function ollamaChatCompletions(request, settings) {
  const baseUrl = resolveOllamaBaseUrl(settings);
  const model = await resolveOllamaRequestModel(
    baseUrl,
    request.model || settings.model || "llama3.2"
  );
  const signal = request.signal;

  try {
    return await ollamaNativeChatCompletions(baseUrl, model, request);
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) {
      return errorResponse("Generation stopped.", "aborted");
    }
    return errorResponse(
      `Could not reach Ollama at ${baseUrl}. Is the Ollama app running? (${err.message})`,
      "engine_error"
    );
  }
}

/** Ollama /api/embed — used by RAG (batch). */
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
