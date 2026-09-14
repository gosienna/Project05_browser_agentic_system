// Google Gemini chat + embeddings.

import { toGeminiTools } from "../modes/dialogue/tools/schema.js";
import { resolveMaxTokens } from "../llm-config.js";
import { resolveApiKey, resolveChatModel, resolveLlmBaseUrl } from "../llm-providers.js";
import { geminiModelSupportsThinking, resolveGeminiModel } from "./gemini-models.js";
import {
  errorResponse,
  mergeAbortSignals,
  openAiFetchErrorMessage,
  readJsonResponse,
  readOpenAiCompatibleResponse,
  readSseJsonStream,
  REMOTE_LLM_FETCH_TIMEOUT_MS,
} from "./shared.js";
import { createGenerationProgressTracker } from "../llm-generation-progress.js";

function appendGeminiContent(contents, role, parts) {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last?.role === role) {
    last.parts.push(...parts);
    return;
  }
  contents.push({ role, parts });
}

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

export async function geminiChatCompletions(request, settings) {
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

  const { signal, cleanup, didUserAbort } = mergeAbortSignals(request.signal, REMOTE_LLM_FETCH_TIMEOUT_MS);
  const progress = createGenerationProgressTracker(request.requestId);
  try {
    const res = await fetch(
      `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal,
      }
    );
    if (!res.ok) {
      const parsed = await readOpenAiCompatibleResponse(res);
      const detail = parsed.body
        ? geminiUnavailableModelMessage(model, geminiErrorMessage(parsed.body, res.status))
        : parsed.error || `HTTP ${res.status}`;
      return errorResponse(detail, "engine_error");
    }

    let content = "";
    let reasoning = "";
    /** @type {object[]|null} */
    let toolCalls = null;
    /** @type {object[]|null} */
    let geminiParts = null;
    let finishReason = "stop";
    let usage = {};

    await readSseJsonStream(res, (chunk) => {
      if (chunk?.error) throw new Error(geminiErrorMessage(chunk, res.status));
      if (chunk?.usageMetadata) usage = chunk.usageMetadata;
      const candidate = chunk?.candidates?.[0];
      if (!candidate) return;
      if (candidate.finishReason === "MAX_TOKENS") finishReason = "length";
      const parts = candidate?.content?.parts || [];
      if (parts.length) {
        geminiParts = [...(geminiParts || []), ...parts];
        for (const part of parts) {
          if (typeof part.text === "string" && part.text) {
            content += part.text;
            progress.push(part.text, {
              text: content,
              completionTokens: usage.candidatesTokenCount,
            });
          }
          if (part.functionCall) {
            if (!toolCalls) toolCalls = [];
            toolCalls.push({
              id: `call_${toolCalls.length}`,
              type: "function",
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {}),
              },
            });
          }
          if (typeof part.thought === "string") reasoning += part.thought;
        }
      } else if (typeof usage.candidatesTokenCount === "number") {
        progress.push(undefined, { text: content, completionTokens: usage.candidatesTokenCount });
      }
    });

    if (toolCalls?.length) finishReason = "tool_calls";
    const message = {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(geminiParts?.length ? { gemini_parts: geminiParts } : {}),
    };
    const completionTokens = usage.candidatesTokenCount ?? 0;
    progress.done({ text: content, completionTokens });
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: completionTokens,
        total_tokens: usage.totalTokenCount ?? 0,
      },
    };
  } catch (err) {
    const userAborted = didUserAbort();
    return errorResponse(
      openAiFetchErrorMessage(err, baseUrl, settings, { userAborted }),
      userAborted ? "aborted" : "engine_error"
    );
  } finally {
    cleanup();
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
