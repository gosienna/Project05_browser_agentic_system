/** Collapsible JSON tree for Dialogue raw I/O panels. */

const DEFAULT_EXPAND_DEPTH = 2;

/** Normalize snapshot/raw shapes into one object for tree display. */
export function extractDialogueRawPayload(raw) {
  if (!raw || typeof raw !== "object") return {};

  const requestPayload =
    raw.request !== undefined
      ? raw.tools?.length > 0
        ? { messages: raw.request, tools: raw.tools }
        : raw.request
      : undefined;

  if (requestPayload !== undefined && raw.response !== undefined) {
    return { request: requestPayload, response: raw.response };
  }
  if (requestPayload !== undefined) {
    if (Array.isArray(requestPayload)) return { messages: requestPayload };
    return requestPayload;
  }
  if (raw.response !== undefined) return { response: raw.response };
  const { prompt: _prompt, tools: _tools, ...rest } = raw;
  return rest;
}

export function serializeDialogueRawPayload(data) {
  return JSON.stringify(data ?? {}, null, 2);
}

/** Parse edited JSON and validate minimal chat payload shape. */
export function parseDialogueRawPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { data: null, error: `Invalid JSON: ${err.message || String(err)}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: null, error: "Root must be a JSON object." };
  }

  const messages = extractMessagesFromPayload(parsed);
  if (!messages) {
    return { data: null, error: "Payload must include a messages array (top-level or under request)." };
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { data: null, error: `messages[${i}] must be an object.` };
    }
    if (typeof m.role !== "string" || !m.role.trim()) {
      return { data: null, error: `messages[${i}] must have a string role.` };
    }
  }

  const tools = extractToolsFromPayload(parsed);
  if (tools !== undefined && !Array.isArray(tools)) {
    return { data: null, error: "tools must be an array when present." };
  }

  const normalized = normalizePayloadForOverride(parsed, messages, tools);
  return { data: normalized, error: null };
}

/** Build override object { messages, tools? } from parsed root. */
export function normalizePayloadForOverride(parsed, messages, tools) {
  const out = { messages };
  if (tools?.length) out.tools = tools;
  return out;
}

export function extractMessagesFromPayload(parsed) {
  if (Array.isArray(parsed.messages)) return parsed.messages;
  if (parsed.request && Array.isArray(parsed.request.messages)) return parsed.request.messages;
  if (Array.isArray(parsed.request)) return parsed.request;
  return null;
}

export function extractToolsFromPayload(parsed) {
  if (Array.isArray(parsed.tools)) return parsed.tools;
  if (parsed.request && Array.isArray(parsed.request.tools)) return parsed.request.tools;
  return undefined;
}

/**
 * Mount a collapsible JSON tree into container (replaces children).
 * @param {HTMLElement} container
 * @param {unknown} data
 * @param {{ defaultExpandDepth?: number }} options
 */
export function mountCollapsibleJsonTree(container, data, options = {}) {
  if (!container) return;
  container.innerHTML = "";
  const depth = options.defaultExpandDepth ?? DEFAULT_EXPAND_DEPTH;
  const root = buildJsonNode(data, { keyLabel: "root", depth: 0, expandDepth: depth, isRoot: true });
  if (root) container.appendChild(root);
  else {
    const empty = document.createElement("div");
    empty.className = "dialogue-json-empty";
    empty.textContent = "(empty)";
    container.appendChild(empty);
  }
}

function buildJsonNode(value, ctx) {
  if (value === null || value === undefined) {
    return buildPrimitiveLeaf(ctx.keyLabel, value, ctx);
  }

  if (Array.isArray(value)) {
    return buildArrayNode(value, ctx);
  }

  if (typeof value === "object") {
    return buildObjectNode(value, ctx);
  }

  return buildPrimitiveLeaf(ctx.keyLabel, value, ctx);
}

function buildObjectNode(obj, ctx) {
  const node = document.createElement("div");
  node.className = "dialogue-json-node";
  const role = typeof obj.role === "string" ? obj.role : null;
  if (role) {
    node.classList.add("dialogue-json-message");
    node.dataset.role = role;
  }

  const keys = Object.keys(obj);
  const collapsed = ctx.depth >= ctx.expandDepth;
  if (collapsed) node.classList.add("collapsed");

  const row = document.createElement("div");
  row.className = "dialogue-json-row";
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    node.classList.toggle("collapsed");
    updateChevron(node);
  });

  const chevron = document.createElement("span");
  chevron.className = "dialogue-json-chevron";
  chevron.textContent = collapsed ? "▸" : "▾";

  const keySpan = document.createElement("span");
  keySpan.className = "dialogue-json-key";
  keySpan.textContent = ctx.isRoot ? "" : `${ctx.keyLabel}: `;

  if (role) {
    const badge = document.createElement("span");
    badge.className = `dialogue-json-role dialogue-json-role-${role}`;
    badge.textContent = role;
    row.appendChild(chevron);
    if (!ctx.isRoot) row.appendChild(keySpan);
    row.appendChild(badge);
  } else {
    row.appendChild(chevron);
    row.appendChild(keySpan);
    const preview = document.createElement("span");
    preview.className = "dialogue-json-preview";
    preview.textContent = collapsed ? `{${keys.length} keys}` : "{";
    row.appendChild(preview);
  }

  node.appendChild(row);

  const children = document.createElement("div");
  children.className = "dialogue-json-children";
  for (const k of keys) {
    const child = buildJsonNode(obj[k], {
      keyLabel: k,
      depth: ctx.depth + 1,
      expandDepth: ctx.expandDepth,
      isRoot: false,
    });
    if (child) children.appendChild(child);
  }
  node.appendChild(children);

  return node;
}

function buildArrayNode(arr, ctx) {
  const node = document.createElement("div");
  node.className = "dialogue-json-node";
  const collapsed = ctx.depth >= ctx.expandDepth;
  if (collapsed) node.classList.add("collapsed");

  const row = document.createElement("div");
  row.className = "dialogue-json-row";
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    node.classList.toggle("collapsed");
    updateChevron(node);
  });

  const chevron = document.createElement("span");
  chevron.className = "dialogue-json-chevron";
  chevron.textContent = collapsed ? "▸" : "▾";

  const keySpan = document.createElement("span");
  keySpan.className = "dialogue-json-key";
  keySpan.textContent = ctx.isRoot ? "" : `${ctx.keyLabel}: `;

  const preview = document.createElement("span");
  preview.className = "dialogue-json-preview";
  preview.textContent = collapsed ? `[${arr.length}]` : "[";

  row.appendChild(chevron);
  row.appendChild(keySpan);
  row.appendChild(preview);
  node.appendChild(row);

  const children = document.createElement("div");
  children.className = "dialogue-json-children";
  arr.forEach((item, i) => {
    const itemCtx = {
      keyLabel: `[${i}]`,
      depth: ctx.depth + 1,
      expandDepth: ctx.expandDepth,
      isRoot: false,
    };
    if (item && typeof item === "object" && !Array.isArray(item) && typeof item.role === "string") {
      itemCtx.keyLabel = `[${i}]`;
    }
    const child = buildJsonNode(item, itemCtx);
    if (child) children.appendChild(child);
  });
  node.appendChild(children);

  return node;
}

function buildPrimitiveLeaf(keyLabel, value, ctx) {
  const leaf = document.createElement("div");
  leaf.className = "dialogue-json-leaf";

  if (!ctx.isRoot && keyLabel) {
    const keySpan = document.createElement("span");
    keySpan.className = "dialogue-json-key";
    keySpan.textContent = `${keyLabel}: `;
    leaf.appendChild(keySpan);
  }

  const valSpan = document.createElement("span");
  valSpan.className = "dialogue-json-value";
  if (typeof value === "string" && (value.includes("\n") || value.length > 120)) {
    valSpan.classList.add("dialogue-json-value-block");
    valSpan.textContent = JSON.stringify(value);
  } else {
    valSpan.textContent = formatPrimitive(value);
  }
  leaf.appendChild(valSpan);

  return leaf;
}

function updateChevron(node) {
  const chevron = node.querySelector(":scope > .dialogue-json-row > .dialogue-json-chevron");
  if (chevron) chevron.textContent = node.classList.contains("collapsed") ? "▸" : "▾";
}

function formatPrimitive(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
