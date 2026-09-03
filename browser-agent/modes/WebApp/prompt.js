// System prompt for the WebApp dock (component editing). Separate from Dialogue's MCP_TOOL_HINT.

import { WEBAPP_MCP_TOOLS } from "../../mcp/tools/webapp/schema.js";

export { WEBAPP_MCP_TOOLS };

export const WEBAPP_TOOL_HINT =
`You can edit the selected WebApp system.
Always write COMPLETE file contents (not patches) with write_component.
After visual or script changes, call reload_home so the user sees the result.
Component kinds: html, css, script.
After each tool call, read the next message that starts with "Tool <name> result:" — that JSON is the live system state (do not invent emptiness).
list_components returns { systemId, components: [{ kind, bytes, updatedAt }, ...] }. A non-empty components array means those files exist; use read_component(kind) for their contents.
For models without native tools, call tools as: call:<tool_name>{arg:value} or call:<tool_name>{}`;

/** System messages for the WebApp dock: optional custom prompt + WebApp tool instructions. */
export function buildWebAppSystemMessages({ customPrompt = "", mcpToolNames = [] } = {}) {
  const parts = [];
  if (customPrompt.trim()) parts.push(customPrompt.trim());
  const webAppToolNames = mcpToolNames.filter((n) => WEBAPP_MCP_TOOLS.has(n));
  if (webAppToolNames.length) {
    parts.push(`${WEBAPP_TOOL_HINT}\nAvailable WebApp tools: ${webAppToolNames.join(", ")}`);
  }
  if (!parts.length) return [];
  return [{ role: "system", content: parts.join("\n\n") }];
}
