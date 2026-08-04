// MCP tool schema ↔ OpenAI chat.completions tools conversion.

/** MCP tools/list entry → OpenAI function tool. */
export function mcpToolToOpenAi(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
}

export function mcpToolsToOpenAi(tools) {
  return (tools || []).map(mcpToolToOpenAi);
}

/** OpenAI function tool → MCP tools/list entry (schema only). */
export function openAiToolToMcp(tool) {
  const fn = tool?.function || {};
  return {
    name: fn.name,
    description: fn.description || "",
    inputSchema: fn.parameters || { type: "object", properties: {} },
  };
}
