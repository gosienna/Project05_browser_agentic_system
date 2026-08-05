// Browser tools invoked by the agent loop. Each export takes a single args
// object (always includes tabId when relevant) and returns a plain
// string/object result suitable for feeding back into the chat transcript.

import { ensureOffscreenDocument } from "../llm.js";

const DEFAULT_PAGE_HTML_CHARS = 14000;
const MODIFY_ELEMENT_MAX = 100;

export async function read_page({ tabId, maxChars = 14000 }) {
  const result = await runInTab(tabId, () => document.body?.innerText || "");
  return truncate(result || "", maxChars, 14000);
}

export async function get_page_html({ tabId, selector, maxChars = DEFAULT_PAGE_HTML_CHARS }) {
  const raw = await runInTab(
    tabId,
    (sel) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: `No element matched "${sel}"` };
        return { ok: true, html: el.outerHTML, url: location.href };
      }
      return { ok: true, html: document.documentElement.outerHTML, url: location.href };
    },
    [selector || null]
  );
  if (!raw?.ok) return raw;
  const limit = normalizeMaxChars(maxChars, DEFAULT_PAGE_HTML_CHARS);
  const html = raw.html || "";
  const truncated = html.length > limit;
  return {
    ok: true,
    html: truncated ? html.slice(0, limit) : html,
    url: raw.url,
    ...(truncated
      ? {
          truncated: true,
          totalChars: html.length,
          shownChars: limit,
        }
      : {}),
  };
}

export async function modify_element({ tabId, selector, styles, text, innerHTML, all = false }) {
  if (!selector || typeof selector !== "string") {
    return { ok: false, error: "selector is required" };
  }
  const normalizedStyles = normalizeStyleObject(styles);
  const hasStyles = normalizedStyles != null;
  const hasText = text !== undefined && text !== null;
  const hasInnerHTML = innerHTML !== undefined && innerHTML !== null;
  if (!hasStyles && !hasText && !hasInnerHTML) {
    return { ok: false, error: "Provide at least one of styles, text, or innerHTML" };
  }
  return runInTab(
    tabId,
    (sel, edit, matchAll, max) => {
      const apply = (el) => {
        if (edit.styles) Object.assign(el.style, edit.styles);
        if (edit.text !== undefined && edit.text !== null) el.textContent = String(edit.text);
        if (edit.innerHTML !== undefined && edit.innerHTML !== null) el.innerHTML = String(edit.innerHTML);
      };
      if (matchAll) {
        const nodes = Array.from(document.querySelectorAll(sel)).slice(0, max);
        if (!nodes.length) return { ok: false, error: `No elements matched "${sel}"` };
        nodes.forEach(apply);
        return { ok: true, matched: nodes.length, updated: nodes.length };
      }
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      apply(el);
      return { ok: true, matched: 1, updated: 1 };
    },
    [
      selector,
      {
        styles: hasStyles ? normalizedStyles : undefined,
        text: hasText ? text : undefined,
        innerHTML: hasInnerHTML ? innerHTML : undefined,
      },
      !!all,
      MODIFY_ELEMENT_MAX,
    ]
  );
}

export async function execute_script({ tabId, script, args = [] }) {
  if (typeof script !== "string" || !script.trim()) {
    throw new Error("execute_script requires a non-empty script string");
  }
  return runInTab(
    tabId,
    (source, callArgs) => {
      const fn = (0, eval)(`(${source})`);
      return fn(...callArgs);
    },
    [script, Array.isArray(args) ? args : []]
  );
}

export async function get_links({ tabId }) {
  return runInTab(tabId, () =>
    Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 200)
      .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href }))
  );
}

export async function list_tabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

export async function open_tab({ url }) {
  const tab = await chrome.tabs.create({ url });
  return { id: tab.id, url: tab.url };
}

export async function navigate({ tabId, url }) {
  await chrome.tabs.update(requireTabId(tabId), { url });
  return { ok: true };
}

export async function click({ tabId, selector }) {
  return runInTab(
    tabId,
    (sel) => {
      let el = document.querySelector(sel);
      if (!el) {
        el = Array.from(document.querySelectorAll("a, button, [role='button'], input[type=submit]")).find((n) =>
          n.innerText?.trim().toLowerCase().includes(sel.trim().toLowerCase())
        );
      }
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true };
    },
    [selector]
  );
}

export async function type_text({ tabId, selector, text }) {
  return runInTab(
    tabId,
    (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    [selector, text]
  );
}

export async function scroll({ tabId, direction = "down" }) {
  return runInTab(
    tabId,
    (dir) => {
      window.scrollBy(0, dir === "up" ? -window.innerHeight * 0.9 : window.innerHeight * 0.9);
      return { ok: true, scrollY: window.scrollY };
    },
    [direction]
  );
}

export async function fetch_url({ url, maxChars = 12000 }) {
  const res = await fetch(url);
  const text = await res.text();
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return truncate(stripped, maxChars, 12000);
}

export function wait({ ms = 1000 }) {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), Math.min(ms, 15000)));
}

/** Caption an image via local Transformers.js image-to-text. */
export async function describe_image({ tabId, imageUrl, dataUrl } = {}) {
  const image = await resolveImageInput({ tabId, imageUrl, dataUrl });
  const model = await preferredModel("image-to-text", "onnxCaptionModel");
  const res = await engineRun({
    task: "image-to-text",
    model,
    input: image,
  });
  if (res.error) throw new Error(res.error.message);
  return { caption: res.output?.caption ?? "", model: res.model };
}

/** Classify an image via local Transformers.js ViT. */
export async function classify_image({ tabId, imageUrl, dataUrl, topK = 5 } = {}) {
  const image = await resolveImageInput({ tabId, imageUrl, dataUrl });
  const model = await preferredModel("image-classification", "onnxClassifyModel");
  const res = await engineRun({
    task: "image-classification",
    model,
    input: image,
    options: { topK },
  });
  if (res.error) throw new Error(res.error.message);
  return { labels: res.output?.labels ?? [], model: res.model };
}

/** Transcribe audio via local Whisper (automatic-speech-recognition). */
export async function transcribe_audio({ audioUrl, dataUrl } = {}) {
  const audio = await resolveAudioInput({ audioUrl, dataUrl });
  const model = await preferredModel("automatic-speech-recognition", "onnxAsrModel");
  const res = await engineRun({
    task: "automatic-speech-recognition",
    model,
    input: audio,
  });
  if (res.error) throw new Error(res.error.message);
  return { text: res.output?.text ?? "", model: res.model };
}

async function preferredModel(_task, settingsKey) {
  const { settings } = await chrome.storage.local.get("settings");
  return settings?.[settingsKey] || undefined; // engine falls back to defaultModelForTask
}

async function engineRun(request) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "onnx-engine",
    type: "engine.run",
    request,
  });
  if (!response) throw new Error("Local engine did not respond (offscreen document may have been evicted).");
  return response;
}

async function resolveImageInput({ tabId, imageUrl, dataUrl }) {
  if (dataUrl) return dataUrl;
  // Remote URLs are fetched inside the offscreen Transformers.js pipeline.
  if (imageUrl) return imageUrl;
  if (tabId != null) return captureTab(tabId);
  throw new Error("describe_image/classify_image requires tabId, imageUrl, or dataUrl");
}

async function resolveAudioInput({ audioUrl, dataUrl }) {
  if (dataUrl) return dataUrl;
  if (audioUrl) return audioUrl;
  throw new Error("transcribe_audio requires audioUrl or dataUrl");
}

async function captureTab(tabId) {
  const id = requireTabId(tabId);
  const tab = await chrome.tabs.get(id);
  if (tab.windowId == null) throw new Error(`Tab ${id} has no windowId`);
  // captureVisibleTab only sees the foreground tab in that window.
  if (!tab.active) await chrome.tabs.update(id, { active: true });
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
}

function quoteLooseJsonValues(jsonish) {
  return jsonish.replace(/:\s*([^",{[\s][^,}]*?)\s*([,}])/g, (match, val, tail) => {
    const v = val.trim();
    if (/^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(v)) return `:${v}${tail}`;
    return `:"${v.replace(/"/g, '\\"')}"${tail}`;
  });
}

function normalizeStyleObject(styles) {
  if (styles && typeof styles === "object" && !Array.isArray(styles)) return styles;
  if (typeof styles !== "string") return null;
  const trimmed = styles.trim();
  if (!trimmed) return null;
  const wrapped = trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
  try {
    const parsed = JSON.parse(wrapped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    try {
      let fixed = wrapped.replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":');
      fixed = quoteLooseJsonValues(fixed);
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function runInTab(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: requireTabId(tabId) },
    world: "ISOLATED",
    func,
    args,
  });
  return result;
}

function requireTabId(tabId) {
  if (tabId == null) throw new Error("This tool requires an active tabId");
  return tabId;
}

function normalizeMaxChars(maxChars, defaultMax) {
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return defaultMax;
  return Math.floor(n);
}

function truncate(str, maxChars, defaultMax) {
  if (!str) return str || "";
  const limit = normalizeMaxChars(maxChars, defaultMax);
  if (str.length <= limit) return str;
  const kept = str.slice(0, limit);
  return `${kept}\n...[truncated — ${str.length.toLocaleString()} chars total, showing first ${limit.toLocaleString()}]`;
}
