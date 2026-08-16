// System prompt for the WebApp dock (component editing). Separate from Dialogue's MCP_TOOL_HINT.

import { WEBAPP_MCP_TOOLS } from "./tools/schema.js";

export { WEBAPP_MCP_TOOLS };

export const WEBAPP_TOOL_HINT =
`You can edit the selected WebApp system. 
Always write COMPLETE file contents (not patches) with write_component. 
After visual or script changes, call reload_home so the user sees the result. 
Component kinds: html, css, script.`;

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
