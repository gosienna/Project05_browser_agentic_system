// Accessibility snapshot + ref-based click tools (Playwright MCP-inspired).

import { renderSnapshotYaml } from "./render-yaml.js";

const INJECTED_FILE = "tools/a11y/injected.js";
const DEFAULT_SNAPSHOT_CHARS = 14000;

/** @type {Map<number, number>} */
const tabGenerations = new Map();

export function getTabGeneration(tabId) {
  return tabGenerations.get(tabId) ?? 0;
}

export async function ensureInjected(tabId) {
  const id = requireTabId(tabId);
  let tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    throw new Error(`Tab ${id} not found`);
  }
  const url = tab.url || "";
  if (/^(chrome|chrome-extension|edge|about|devtools):/i.test(url)) {
    throw new Error(`Cannot run browser tools on restricted page: ${url}`);
  }

  await chrome.scripting.executeScript({
    target: { tabId: id },
    world: "ISOLATED",
    files: [INJECTED_FILE],
  });
  return id;
}

async function runInTab(tabId, func, args = []) {
  await ensureInjected(tabId);
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

function truncateSnapshot(text, maxChars = DEFAULT_SNAPSHOT_CHARS) {
  if (!text || text.length <= maxChars) return { snapshot: text || "", truncated: false };
  return {
    snapshot: `${text.slice(0, maxChars)}\n...[truncated — ${text.length.toLocaleString()} chars total, showing first ${maxChars.toLocaleString()}]`,
    truncated: true,
    totalChars: text.length,
    shownChars: maxChars,
  };
}

function parseTargetRef(target) {
  if (!target || typeof target !== "string") return undefined;
  const m = target.match(/^(?:f\d+)?(e\d+)$/);
  return m ? m[1] : undefined;
}

/**
 * Capture accessibility snapshot of the current page (Playwright MCP-style YAML).
 */
export async function browser_snapshot({ tabId, target, depth, boxes, maxChars = DEFAULT_SNAPSHOT_CHARS }) {
  const id = await ensureInjected(tabId);
  const nextGen = (tabGenerations.get(id) ?? 0) + 1;
  tabGenerations.set(id, nextGen);

  const targetRef = parseTargetRef(target);
  const raw = await runInTab(
    id,
    (opts) => globalThis.__baCaptureSnapshot(opts),
    [{
      generation: nextGen,
      depth,
      boxes: !!boxes,
      targetRef,
    }],
  );

  if (!raw?.ok) return raw;

  const yaml = renderSnapshotYaml(raw.nodes || [], { depth, boxes: !!boxes });
  const truncated = truncateSnapshot(yaml, maxChars);

  return {
    url: raw.url,
    title: raw.title,
    snapshot: truncated.snapshot,
    refCount: raw.refCount,
    generation: nextGen,
    ...(truncated.truncated
      ? { truncated: true, totalChars: truncated.totalChars, shownChars: truncated.shownChars }
      : {}),
  };
}

/**
 * Click an element by ref from browser_snapshot or by CSS selector.
 */
export async function browser_click({
  tabId,
  target,
  element: _element,
  doubleClick,
  button,
  modifiers,
}) {
  if (!target) return { ok: false, error: "target is required" };

  const id = await ensureInjected(tabId);
  const generation = tabGenerations.get(id);

  return runInTab(
    id,
    (opts) => globalThis.__baClickByTarget(opts),
    [{
      target,
      generation: parseTargetRef(target) != null ? generation : undefined,
      doubleClick: !!doubleClick,
      button: button || "left",
      modifiers: modifiers || [],
    }],
  );
}
