// Internal protocol: every provider is consumed through the OpenAI
// chat.completions request/response shape. See ONNX_ENGINE_PLAN.md §3.

const ONNX_OFFSCREEN_URL = "offscreen.html";
let offscreenReadyPromise = null;

/**
 * @param {{model?:string, messages:Array<{role:string,content:string}>, temperature?:number, max_tokens?:number, stream?:boolean}} request
 * @param {object} settings
 * @returns {Promise<object>} OpenAI-shaped chat.completion (or {error} on failure)
 */
export async function chatCompletions(request, settings) {
  const provider = settings?.provider || "onnx";
  switch (provider) {
    case "onnx":
      return onnxChatCompletions(request, settings);
    case "openai":
    case "openai-compatible":
      return openaiChatCompletions(request, settings);
    case "ollama":
      return ollamaChatCompletions(request, settings);
    case "anthropic":
      return anthropicChatCompletions(request, settings);
    default:
      return errorResponse(`Unknown provider "${provider}"`, "engine_error");
  }
}

/** Back-compat convenience wrapper used by agent.js and the system editors. */
export async function chat(messages, settings) {
  const request = {
    model: settings?.model,
    messages,
    temperature: settings?.temperature ?? 0.2,
    max_tokens: settings?.maxTokens ?? 1024,
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
        justification: "Run the local ONNX/Transformers.js LLM engine off the service worker.",
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

async function ollamaChatCompletions(request, settings) {
  const baseUrl = (settings.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  const model = request.model || settings.model || "llama3.2";

  // Prefer Ollama's OpenAI-compatible shim; it needs no translation.
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, model }),
    });
    if (res.status !== 404) {
      const body = await res.json();
      if (!res.ok) return errorResponse(body?.error?.message || `HTTP ${res.status}`, "engine_error");
      return body;
    }
  } catch (err) {
    return errorResponse(`Could not reach Ollama at ${baseUrl}: ${err.message}`, "engine_error");
  }

  // Fallback: native /api/chat, translated to chat.completions shape.
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: request.messages,
        stream: false,
        options: { temperature: request.temperature },
      }),
    });
    const body = await res.json();
    if (!res.ok) return errorResponse(body?.error || `HTTP ${res.status}`, "engine_error");
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: body.message?.content ?? "" },
          finish_reason: body.done ? "stop" : "length",
        },
      ],
      usage: {
        prompt_tokens: body.prompt_eval_count ?? 0,
        completion_tokens: body.eval_count ?? 0,
        total_tokens: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
      },
    };
  } catch (err) {
    return errorResponse(`Could not reach Ollama at ${baseUrl}: ${err.message}`, "engine_error");
  }
}

// --- anthropic -------------------------------------------------------------

async function anthropicChatCompletions(request, settings) {
  const baseUrl = (settings.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const messages = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

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
        max_tokens: request.max_tokens ?? 1024,
        temperature: request.temperature,
      }),
    });
    const body = await res.json();
    if (!res.ok) return errorResponse(body?.error?.message || `HTTP ${res.status}`, "engine_error");
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return {
      id: body.id || `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: body.stop_reason === "end_turn" ? "stop" : "length",
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
