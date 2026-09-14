// Side-channel progress for live generation tokens (Dialogue Stop label + streaming bubble).
// Local workers and in-panel remote providers both emit via chrome.runtime.sendMessage.

/**
 * @param {{
 *   requestId?: string,
 *   delta?: string,
 *   text?: string,
 *   completionTokens?: number,
 *   done?: boolean,
 * }} event
 */
export function emitLlmGenerationProgress(event) {
  if (!event?.requestId) return;
  try {
    const payload = {
      target: "llm-generation",
      requestId: event.requestId,
      ...(event.delta != null ? { delta: event.delta } : {}),
      ...(event.text != null ? { text: event.text } : {}),
      ...(typeof event.completionTokens === "number" ? { completionTokens: event.completionTokens } : {}),
      ...(event.done ? { done: true } : {}),
    };
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(payload).catch(() => {});
    }
  } catch {
    /* ignore — UI progress is best-effort */
  }
}

/** Compact token count for Stop button: 128, 1.2k, 13k. */
export function formatCompactTokenCount(n) {
  const num = Math.max(0, Math.floor(Number(n) || 0));
  if (num < 1000) return String(num);
  if (num < 10000) {
    const k = num / 1000;
    const rounded = Math.round(k * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return `${Math.round(num / 1000)}k`;
}

/** Rough token estimate from streamed text when APIs only send deltas. */
export function estimateTokensFromText(text) {
  const s = String(text || "");
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * Track streamed text + token count and emit progress.
 * @param {string|undefined} requestId
 */
export function createGenerationProgressTracker(requestId) {
  let text = "";
  let completionTokens = 0;
  let pieceCount = 0;

  return {
    get text() {
      return text;
    },
    get completionTokens() {
      return completionTokens;
    },
    /** @param {string} [delta] @param {{ completionTokens?: number, text?: string }} [opts] */
    push(delta, opts = {}) {
      if (typeof opts.text === "string") text = opts.text;
      else if (typeof delta === "string" && delta) text += delta;
      pieceCount += 1;
      if (typeof opts.completionTokens === "number") {
        completionTokens = opts.completionTokens;
      } else {
        completionTokens = Math.max(completionTokens, estimateTokensFromText(text), pieceCount);
      }
      emitLlmGenerationProgress({
        requestId,
        delta: typeof delta === "string" ? delta : undefined,
        text,
        completionTokens,
      });
    },
    /** @param {{ completionTokens?: number, text?: string }} [opts] */
    done(opts = {}) {
      if (typeof opts.text === "string") text = opts.text;
      if (typeof opts.completionTokens === "number") completionTokens = opts.completionTokens;
      emitLlmGenerationProgress({
        requestId,
        text,
        completionTokens,
        done: true,
      });
    },
  };
}
