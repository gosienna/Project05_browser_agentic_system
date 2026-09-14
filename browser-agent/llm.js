// Internal protocol: every provider is consumed through the OpenAI
// chat.completions request/response shape. See ONNX_ENGINE_PLAN.md §3.

import { toAnthropicTools } from "./modes/dialogue/tools/schema.js";
import { getMaxTokens, getWllamaContextLimit } from "./llm-config.js";
import { geminiChatCompletions, geminiEmbeddings } from "./llm-API/gemini.js";
import {
  ollamaChatCompletions,
  ollamaEmbeddings,
  ollamaFetchRenderedPrompt,
  resolveOllamaRequestModel,
} from "./llm-API/ollama.js";
import { openaiChatCompletions, openaiEmbeddings } from "./llm-API/openai.js";
import { errorResponse, mergeAbortSignals, readSseJsonStream, REMOTE_LLM_FETCH_TIMEOUT_MS } from "./llm-API/shared.js";
import { createGenerationProgressTracker } from "./llm-generation-progress.js";
import { resolveApiKey, resolveOllamaBaseUrl } from "./llm-providers.js";
import { isThinkingEnabled, normalizeChatCompletion } from "./reasoning-content.js";
import { stripUnsupportedNativeTools } from "./llm-browser/webllm-models.js";

const ONNX_OFFSCREEN_URL = "llm-browser/offscreen.html";
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
  const signal = request?.signal;
  const requestId = request?.requestId;
  const { signal: _omitSignal, requestId: _omitId, ...requestWithoutMeta } = request || {};
  const req = stripUnsupportedNativeTools(withThinkingRequest(requestWithoutMeta, settings), settings);
  if (signal) req.signal = signal;
  if (requestId) req.requestId = requestId;
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
    case "wllama":
      response = await wllamaChatCompletions(req, settings);
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
    case "wllama":
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

/** Back-compat convenience wrapper used by WebApp.js and the system editors. */
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

// --- in-browser (llm-browser) ------------------------------------------

/** Fire-and-forget interrupt for a local offscreen worker. */
function requestLocalEngineAbort(target) {
  chrome.runtime.sendMessage({ target, type: "chat.abort" }).catch(() => {});
}

/**
 * Run a local engine call while forwarding AbortSignal → chat.abort.
 * @param {"onnx-engine"|"webllm-engine"|"wllama-engine"} target
 * @param {AbortSignal|undefined} signal
 * @param {() => Promise<object>} run
 */
async function withLocalEngineAbort(target, signal, run) {
  if (signal?.aborted) return errorResponse("Generation stopped.", "aborted");

  const onAbort = () => requestLocalEngineAbort(target);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await run();
    if (signal?.aborted) return errorResponse("Generation stopped.", "aborted");
    if (response?.error?.type === "aborted") return response;
    return response;
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      return errorResponse("Generation stopped.", "aborted");
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function ensureOffscreenDocument() {
  if (offscreenReadyPromise) return offscreenReadyPromise;

  offscreenReadyPromise = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing && existing.length > 0) return;

    try {
      await chrome.offscreen.createDocument({
        url: ONNX_OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run local ONNX/WebLLM/wllama inference engines off the service worker.",
      });
    } catch (err) {
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

  const { signal, ...requestBody } = request;
  try {
    return await withLocalEngineAbort("onnx-engine", signal, async () => {
      const response = await chrome.runtime.sendMessage({
        target: "onnx-engine",
        type: "chat.completions",
        request: { ...requestBody, model },
      });
      if (!response) {
        return errorResponse("Local engine did not respond (offscreen document may have been evicted).", "engine_error");
      }
      return response;
    });
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

  const { signal, ...requestBody } = request;
  try {
    return await withLocalEngineAbort("webllm-engine", signal, async () => {
      const payload = stripUnsupportedNativeTools({ ...requestBody, model }, settings);
      const response = await chrome.runtime.sendMessage({
        target: "webllm-engine",
        type: "chat.completions",
        request: payload,
      });
      if (!response) {
        return errorResponse("WebLLM engine did not respond (offscreen document may have been evicted).", "engine_error");
      }
      return response;
    });
  } catch (err) {
    return errorResponse(`WebLLM engine error: ${err.message}`, "engine_error");
  }
}

async function wllamaChatCompletions(request, settings) {
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    return errorResponse(`Could not start local engine: ${err.message}`, "engine_error");
  }

  const model = request.model || settings?.wllamaModel;
  if (!model) {
    return errorResponse("No wllama model selected — open Settings and pick a GGUF model to download.", "model_not_loaded");
  }

  const { signal, ...requestBody } = request;
  try {
    return await withLocalEngineAbort("wllama-engine", signal, async () => {
      const payload = {
        ...stripUnsupportedNativeTools({ ...requestBody, model }, settings),
        n_ctx: getWllamaContextLimit(settings),
      };
      const response = await chrome.runtime.sendMessage({
        target: "wllama-engine",
        type: "chat.completions",
        request: payload,
      });
      if (!response) {
        return errorResponse("wllama engine did not respond (offscreen document may have been evicted).", "engine_error");
      }
      return response;
    });
  } catch (err) {
    return errorResponse(`wllama engine error: ${err.message}`, "engine_error");
  }
}

// --- anthropic (API; not yet split to llm-API) ---------------------------

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

  const { signal, cleanup, didUserAbort } = mergeAbortSignals(request.signal, REMOTE_LLM_FETCH_TIMEOUT_MS);
  const progress = createGenerationProgressTracker(request.requestId);
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
        stream: true,
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return errorResponse(body?.error?.message || `HTTP ${res.status}`, "engine_error");
    }

    let content = "";
    /** @type {object[]} */
    const toolCalls = [];
    let finishReason = "stop";
    let messageId = `chatcmpl-${crypto.randomUUID()}`;
    let modelOut = request.model || settings.model || "claude-sonnet-5";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    /** @type {object|null} */
    let currentTool = null;

    await readSseJsonStream(res, (event) => {
      const type = event?.type;
      if (type === "message_start") {
        if (event.message?.id) messageId = event.message.id;
        if (event.message?.model) modelOut = event.message.model;
        if (event.message?.usage) {
          usage.prompt_tokens = event.message.usage.input_tokens ?? 0;
        }
      } else if (type === "content_block_start" && event.content_block?.type === "tool_use") {
        currentTool = {
          id: event.content_block.id,
          type: "function",
          function: { name: event.content_block.name || "", arguments: "" },
        };
      } else if (type === "content_block_delta") {
        const delta = event.delta || {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          content += delta.text;
          progress.push(delta.text, { text: content });
        } else if (delta.type === "input_json_delta" && currentTool && typeof delta.partial_json === "string") {
          currentTool.function.arguments += delta.partial_json;
        }
      } else if (type === "content_block_stop") {
        if (currentTool) {
          toolCalls.push(currentTool);
          currentTool = null;
        }
      } else if (type === "message_delta") {
        if (event.delta?.stop_reason === "tool_use") finishReason = "tool_calls";
        else if (event.delta?.stop_reason === "max_tokens") finishReason = "length";
        if (event.usage?.output_tokens != null) {
          usage.completion_tokens = event.usage.output_tokens;
          progress.push(undefined, { text: content, completionTokens: usage.completion_tokens });
        }
      } else if (type === "message_stop") {
        /* done */
      }
    });

    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    progress.done({ text: content, completionTokens: usage.completion_tokens });
    return {
      id: messageId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelOut,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    };
  } catch (err) {
    if (didUserAbort() || err?.name === "AbortError") {
      return errorResponse(
        didUserAbort() ? "Generation stopped." : `Request timed out after ${Math.round(REMOTE_LLM_FETCH_TIMEOUT_MS / 1000)}s.`,
        didUserAbort() ? "aborted" : "engine_error"
      );
    }
    return errorResponse(err.message, "engine_error");
  } finally {
    cleanup();
  }
}

export { ollamaEmbeddings, openaiEmbeddings, geminiEmbeddings };
