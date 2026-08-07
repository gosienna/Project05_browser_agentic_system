// Internal protocol: every provider is consumed through the OpenAI
// chat.completions request/response shape. See ONNX_ENGINE_PLAN.md §3.

import { toAnthropicTools } from "./tools/schema.js";
import { getMaxTokens } from "./agent-config.js";
import { ollamaFetch } from "./ollama-models.js";
import { isThinkingEnabled, normalizeChatCompletion } from "./reasoning-content.js";

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
  const req = withThinkingRequest(request, settings);
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
      response = await openaiChatCompletions(req, settings);
      break;
    case "ollama":
      response = await ollamaChatCompletions(req, settings);
      break;
    case "anthropic":
      response = await anthropicChatCompletions(req, settings);
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
      const baseUrl = (settings.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
      const model = request.model || settings.model || "llama3.2";
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
    const response = await chrome.runtime.sendMessage({
      target: "webllm-engine",
      type: "chat.completions",
      request: { ...request, model },
    });
    if (!response) {
      return errorResponse("WebLLM engine did not respond (offscreen document may have been evicted).", "engine_error");
    }
    return response;
  } catch (err) {
    return errorResponse(`WebLLM engine error: ${err.message}`, "engine_error");
  }
}

// --- openai / openai-compatible -----------------------------------------

async function openaiChatCompletions(request, settings) {
  const baseUrl = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...request, model: request.model || settings.model }),
    });
    const body = await res.json();
    if (!res.ok) return errorResponse(body?.error?.message || `HTTP ${res.status}`, "engine_error");
    return body;
  } catch (err) {
    return errorResponse(err.message, "engine_error");
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

function toOllamaChatMessages(messages) {
  return (messages || [])
    .filter((m) => OLLAMA_CHAT_ROLES.has(m.role))
    .map((m) => {
      const out = { role: m.role };
      if (m.content !== undefined) out.content = m.content;
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_name) out.tool_name = m.tool_name;
      return out;
    });
}

function buildOllamaNativeChatBody(model, request) {
  const body = {
    model,
    messages: toOllamaChatMessages(request.messages),
    stream: false,
    think: request.thinkingEnabled !== false,
    options: { temperature: request.temperature },
  };
  if (request.tools?.length) body.tools = request.tools;
  return body;
}

function ollamaAssistantMessage(msg) {
  if (!msg || typeof msg !== "object") return { role: "assistant", content: "" };
  const out = { role: "assistant", content: msg.content ?? "" };
  const reasoning = msg.thinking ?? msg.reasoning ?? msg.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) out.reasoning = reasoning.trim();
  return out;
}

function ollamaChatCompletionFromNative(body, model) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: ollamaAssistantMessage(body.message),
        finish_reason: body.done ? "stop" : "length",
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

function attachOllamaPrompt(response, prompt) {
  if (typeof prompt === "string" && prompt.length > 0) response.prompt = prompt;
  return response;
}

async function ollamaChatCompletions(request, settings) {
  const baseUrl = (settings.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = request.model || settings.model || "llama3.2";
  const v1Body = {
    ...request,
    model,
    stream: false,
    think: request.thinkingEnabled !== false,
  };
  const promptPromise = ollamaFetchRenderedPrompt(baseUrl, model, request);

  // Prefer Ollama's OpenAI-compatible shim; fall back to native /api/chat on any failure.
  try {
    const res = await ollamaFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v1Body),
    });
    if (res.status !== 404) {
      const parsed = await readJsonResponse(res);
      if (parsed.error) {
        console.warn("[ollama] /v1/chat/completions:", parsed.error);
      } else if (!res.ok) {
        return errorResponse(
          ollamaHttpError(baseUrl, res.status, parsed.body?.error?.message),
          "engine_error"
        );
      } else {
        const prompt = await promptPromise;
        return attachOllamaPrompt(parsed.body, prompt);
      }
    }
  } catch (err) {
    console.warn("[ollama] /v1/chat/completions fetch failed:", err);
  }

  // Fallback: native /api/chat, translated to chat.completions shape.
  try {
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
    const prompt = await promptPromise;
    return attachOllamaPrompt(ollamaChatCompletionFromNative(body, model), prompt);
  } catch (err) {
    return errorResponse(
      `Could not reach Ollama at ${baseUrl}. Is the Ollama app running? (${err.message})`,
      "engine_error"
    );
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
        "x-api-key": settings.apiKey || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model || settings.model || "claude-sonnet-5",
        system: system || undefined,
        messages,
        ...(tools ? { tools } : {}),
        max_tokens: request.max_tokens ?? getMaxTokens(settings),
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
