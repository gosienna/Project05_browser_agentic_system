// Register built-in MCP tools for Dialogue (web search + browser automation).

import { registerMcpTool } from "./server.js";
import { tavilySearch } from "../dialogue/tool-runtime.js";
import * as browserTools from "../tools.js";

const TAB_ID_PROP = {
  type: "integer",
  description: "Target tab id (defaults to the active tab in the current window)",
};

function webSearchEnabled(settings) {
  return settings.dialogueWebSearch !== false;
}

function browserToolsEnabled(settings) {
  return settings.dialogueBrowserTools !== false;
}

async function resolveTabId(args, context) {
  if (args.tabId != null) return args.tabId;
  if (context.tabId != null) return context.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab — open a tab or pass tabId");
  return tab.id;
}

function withTabId(fn) {
  return async (args, context) => {
    const tabId = await resolveTabId(args, context);
    return fn({ ...args, tabId });
  };
}

export function registerBuiltinMcpTools() {
  registerMcpTool({
    name: "web_search",
    description:
      "Search the public web for current information. Returns titles, URLs, and relevant snippets. Use when the user asks about recent events, facts you are unsure of, or anything that may have changed since training.",
    groups: ["dialogue", "network"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: {
          type: "integer",
          description: "Number of results to return (1-10)",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
    },
    isEnabled: webSearchEnabled,
    handler: (args, context) => tavilySearch(args, context.settings || {}),
  });

  registerMcpTool({
    name: "read_page",
    description: "Return visible text from a browser tab.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        maxChars: { type: "integer", description: "Max characters to return (default 14000; omit or use ≤0 for default)" },
      },
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.read_page(args)),
  });

  registerMcpTool({
    name: "get_links",
    description: "Return links (text + href) from a browser tab.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID_PROP },
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.get_links(args)),
  });

  registerMcpTool({
    name: "list_tabs",
    description: "List open browser tabs (id, title, url, active).",
    groups: ["dialogue", "browser"],
    inputSchema: { type: "object", properties: {} },
    isEnabled: browserToolsEnabled,
    handler: () => browserTools.list_tabs(),
  });

  registerMcpTool({
    name: "open_tab",
    description: "Open a new browser tab at the given URL.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open" } },
      required: ["url"],
    },
    isEnabled: browserToolsEnabled,
    handler: (args) => browserTools.open_tab(args),
  });

  registerMcpTool({
    name: "navigate",
    description: "Navigate a tab to a URL.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        url: { type: "string", description: "URL to navigate to" },
      },
      required: ["url"],
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.navigate(args)),
  });

  registerMcpTool({
    name: "click",
    description: "Click an element by CSS selector or visible button/link text.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        selector: { type: "string", description: "CSS selector or visible text to match" },
      },
      required: ["selector"],
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.click(args)),
  });

  registerMcpTool({
    name: "type_text",
    description: "Type text into an input or textarea matching a CSS selector.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        selector: { type: "string", description: "CSS selector for the input" },
        text: { type: "string", description: "Text to type" },
      },
      required: ["selector", "text"],
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.type_text(args)),
  });

  registerMcpTool({
    name: "scroll",
    description: 'Scroll the tab one screen "up" or "down".',
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
      },
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.scroll(args)),
  });

  registerMcpTool({
    name: "fetch_url",
    description: "Fetch a URL's text content without opening a tab.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        maxChars: { type: "integer", description: "Max characters (default 12000; omit or use ≤0 for default)" },
      },
      required: ["url"],
    },
    isEnabled: browserToolsEnabled,
    handler: (args) => browserTools.fetch_url(args),
  });

  registerMcpTool({
    name: "wait",
    description: "Pause for a number of milliseconds (max 15000).",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: { ms: { type: "integer", description: "Milliseconds to wait" } },
    },
    isEnabled: browserToolsEnabled,
    handler: (args) => browserTools.wait(args),
  });
}
