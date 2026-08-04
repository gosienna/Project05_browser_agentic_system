// In-extension MCP tool server (tools/list + tools/call semantics).

import { mcpToolsToOpenAi } from "./schema.js";

/** @typedef {{ name: string, description?: string, inputSchema?: object, groups?: string[], isEnabled?: (settings: object) => boolean, handler: (args: object, ctx: object) => Promise<unknown> }} McpToolDef */

/** @type {Map<string, McpToolDef>} */
const registry = new Map();

/** Register a tool the MCP server can list and execute. */
export function registerMcpTool(def) {
  if (!def?.name || typeof def.handler !== "function") {
    throw new Error("MCP tool requires name and handler");
  }
  registry.set(def.name, {
    groups: ["dialogue"],
    ...def,
    inputSchema: def.inputSchema || { type: "object", properties: {} },
  });
}

/** MCP tools/list — returns tool definitions (no handlers). */
export function listMcpTools({ groups, settings } = {}) {
  const groupSet = groups?.length ? new Set(groups) : null;
  const out = [];
  for (const tool of registry.values()) {
    if (groupSet && !tool.groups?.some((g) => groupSet.has(g))) continue;
    if (settings && typeof tool.isEnabled === "function" && !tool.isEnabled(settings)) continue;
    out.push({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema,
    });
  }
  return out;
}

export function listMcpToolsOpenAi(options) {
  return mcpToolsToOpenAi(listMcpTools(options));
}

export function getMcpToolNames(options) {
  return listMcpTools(options).map((t) => t.name);
}

/** MCP tools/call */
export async function callMcpTool(name, args = {}, context = {}) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Unknown MCP tool "${name}"`);
  if (context.settings && typeof tool.isEnabled === "function" && !tool.isEnabled(context.settings)) {
    throw new Error(`MCP tool "${name}" is disabled in settings`);
  }
  return tool.handler(args || {}, context);
}
