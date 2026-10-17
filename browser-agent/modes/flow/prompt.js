// System prompt for the Flow dock (node editing + run). Separate from Dialogue's MCP_TOOL_HINT.

import { FLOW_MCP_TOOLS } from "../../mcp/tools/flow/schema.js";

export { FLOW_MCP_TOOLS };

export const FLOW_TOOL_HINT =
`You can edit and run the currently selected Flow session.
Each node is self-contained: it has inputs (JSON), a script (async JS body), outputs, and an optional model (chat model id for api.llm; empty = dialogue/settings default on the same provider).
Scripts receive (inputs, outputs, api). Use api.open_tab, api.navigate, api.list_tabs, api.browser_snapshot, api.get_page_html, api.wait(ms), api.llm(prompt). Assign fields on outputs.
write_flow_node takes FLAT args: nodeId plus title/model/inputs/script/outputs at the top level (not only nested under "node").
Example: call:write_flow_node{"nodeId":"n1","inputs":{"url":"https://www.bing.com/search?q=weather+taipei"},"title":"Open Bing weather search"}
Always write COMPLETE inputs/script values with write_flow_node (not patches of fragments unless intentional).
After structural edits, call reload_flow_ui so the sidepanel refreshes.
After each tool call, read the next message that starts with "Tool <name> result:" — that JSON is live state.
For models without native tools, call tools as: call:<tool_name>{arg:value} or call:<tool_name>{}`;

/** System messages for the Flow dock: optional custom prompt + Flow tool instructions. */
export function buildFlowSystemMessages({ customPrompt = "", mcpToolNames = [] } = {}) {
  const parts = [];
  if (customPrompt.trim()) parts.push(customPrompt.trim());
  const flowToolNames = mcpToolNames.filter((n) => FLOW_MCP_TOOLS.has(n));
  if (flowToolNames.length) {
    parts.push(`${FLOW_TOOL_HINT}\nAvailable Flow tools: ${flowToolNames.join(", ")}`);
  }
  if (!parts.length) return [];
  return [{ role: "system", content: parts.join("\n\n") }];
}
