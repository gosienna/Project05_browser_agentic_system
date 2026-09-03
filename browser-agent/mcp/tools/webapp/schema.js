// MCP schemas for WebApp component tools.

import { COMPONENT_KINDS } from "../../../modes/WebApp/system-store.js";

export const WEBAPP_MCP_TOOLS = new Set([
  "list_components",
  "read_component",
  "write_component",
  "reload_home",
]);

export const KIND_PROP = {
  type: "string",
  enum: COMPONENT_KINDS,
  description: "Component kind: html, css, or script",
};

export const WEBAPP_MCP_TOOL_DEFS = [
  {
    name: "list_components",
    description:
      "List component kinds and byte sizes for the currently selected WebApp system (html, css, script).",
    groups: ["dialogue", "webapp"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_component",
    description: "Return the full content of one WebApp component (html, css, or script).",
    groups: ["dialogue", "webapp"],
    inputSchema: {
      type: "object",
      properties: { kind: KIND_PROP },
      required: ["kind"],
    },
  },
  {
    name: "write_component",
    description:
      "Replace a WebApp component with the complete new content string (not a patch). kind is html, css, or script.",
    groups: ["dialogue", "webapp"],
    inputSchema: {
      type: "object",
      properties: {
        kind: KIND_PROP,
        content: { type: "string", description: "Full replacement content for the component" },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "reload_home",
    description: "Refresh the WebApp home UI so the user sees the latest html/css/script components.",
    groups: ["dialogue", "webapp"],
    inputSchema: { type: "object", properties: {} },
  },
];
