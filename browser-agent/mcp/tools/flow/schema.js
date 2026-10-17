// MCP schemas for Flow session / node tools.

export const FLOW_MCP_TOOLS = new Set([
  "list_flow_nodes",
  "read_flow_node",
  "write_flow_node",
  "add_flow_node",
  "delete_flow_node",
  "run_flow_node",
  "run_flow_session",
  "reload_flow_ui",
]);

export const FLOW_MCP_TOOL_DEFS = [
  {
    name: "list_flow_nodes",
    description:
      "List nodes in the currently selected Flow session (id, title, model, status, input keys, script bytes, has outputs).",
    groups: ["dialogue", "flow"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_flow_node",
    description:
      "Return the full content of one Flow node (title, model, inputs, script, outputs, status, error). Empty model means dialogue/settings default.",
    groups: ["dialogue", "flow"],
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node id from list_flow_nodes (alias: node_id)" },
        node_id: { type: "string", description: "Alias for nodeId" },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "write_flow_node",
    description:
      "Update a Flow node. Pass fields at the TOP LEVEL: nodeId plus any of title, model, inputs, script, outputs. " +
      "Example: {\"nodeId\":\"n1\",\"title\":\"Open Bing weather search\",\"inputs\":{\"url\":\"https://www.bing.com/search?q=weather+taipei\"}}. " +
      "Also accepts a nested node object (same shape as read_flow_node). Omitted fields are left unchanged. Empty model = dialogue default.",
    groups: ["dialogue", "flow"],
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node id (alias: node_id)" },
        node_id: { type: "string", description: "Alias for nodeId" },
        title: { type: "string", description: "Node title" },
        model: {
          type: "string",
          description:
            "Chat model id for this node's api.llm calls. Empty string uses the current dialogue/settings model. Must be a model on the active provider.",
        },
        inputs: { type: "object", description: "Replacement inputs object" },
        script: { type: "string", description: "Full replacement script body" },
        outputs: { description: "Replacement outputs (object or null)" },
        node: {
          type: "object",
          description:
            "Optional nested node payload (read_flow_node shape). Fields here are used when the same top-level field is omitted.",
        },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "add_flow_node",
    description: "Append a new node to the current Flow session.",
    groups: ["dialogue", "flow"],
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        model: {
          type: "string",
          description: "Optional chat model id for api.llm (empty = dialogue default)",
        },
        inputs: { type: "object" },
        script: { type: "string" },
      },
    },
  },
  {
    name: "delete_flow_node",
    description: "Delete a node from the current Flow session by id.",
    groups: ["dialogue", "flow"],
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node id (alias: node_id)" },
        node_id: { type: "string", description: "Alias for nodeId" },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "run_flow_node",
    description: "Execute one node's script with the Flow runtime and persist its outputs/status.",
    groups: ["dialogue", "flow"],
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node id (alias: node_id)" },
        node_id: { type: "string", description: "Alias for nodeId" },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "run_flow_session",
    description: "Execute every node in the current Flow session in order. Stops on first error.",
    groups: ["dialogue", "flow"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reload_flow_ui",
    description: "Refresh the Flow sidepanel so the user sees the latest nodes.",
    groups: ["dialogue", "flow"],
    inputSchema: { type: "object", properties: {} },
  },
];
