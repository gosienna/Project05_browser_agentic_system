// Register built-in MCP tools for Dialogue (web search + browser automation).

import { registerMcpTool } from "./server.js";
import { tavilySearch, prepareSearchToolArgs } from "../dialogue/tool-runtime.js";
import * as browserTools from "../tools/browser.js";
import { searchDocuments, formatSearchHit } from "../rag/search.js";
import { resolveSearchDocIds, setActiveDocIds, getActiveDocIds } from "../rag/active-docs.js";
import * as ragStore from "../rag/rag-store.js";

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

function ragToolsEnabled(settings) {
  return settings.dialogueRagTools !== false;
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
    handler: (args, context) => {
      const resolved = prepareSearchToolArgs("web_search", args, context.userQuery);
      return tavilySearch(resolved, context.settings || {});
    },
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
    name: "get_page_html",
    description:
      "Return raw HTML from a live browser tab (after JS rendering). Omit selector for full document; pass selector for one element's outerHTML. Use before modify_element to pick selectors. Changes are not persisted — reload reverts the page.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        selector: { type: "string", description: "Optional CSS selector; omit for full document HTML" },
        maxChars: { type: "integer", description: "Max characters (default 14000; use selector to limit size; omit or use ≤0 for default)" },
      },
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.get_page_html(args)),
  });

  registerMcpTool({
    name: "modify_element",
    description:
      "Change DOM content or styles on a tab. Provide selector plus at least one of styles (camelCase CSS), text (textContent), or innerHTML. Set all:true to update up to 100 matches. Example: enlarge title — selector \"h1\", styles {fontSize:\"2.5rem\"}. Example: bold red text — styles {color:\"red\", fontWeight:\"bold\"}. Reload reverts changes.",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        selector: { type: "string", description: "CSS selector for target element(s)" },
        styles: {
          type: "object",
          description: "CamelCase CSS properties, e.g. { color: \"red\", fontSize: \"2rem\" }",
          additionalProperties: { type: "string" },
        },
        text: { type: "string", description: "Set element textContent" },
        innerHTML: { type: "string", description: "Set element innerHTML" },
        all: { type: "boolean", description: "Apply to all matching elements (max 100)" },
      },
      required: ["selector"],
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.modify_element(args)),
  });

  registerMcpTool({
    name: "execute_script",
    description:
      "Run a JavaScript function in the tab (isolated world: DOM access yes, page JS variables no). script is a function source string; args is an optional array passed to it. Return value must be JSON-serializable. Example: highlight download links — script \"() => { const sel = 'a[download], a[href$=\\\\\".pdf\\\\\"]'; let n = 0; document.querySelectorAll(sel).forEach(el => { el.style.outline = '3px solid red'; n++; }); return { highlighted: n }; }\"",
    groups: ["dialogue", "browser"],
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID_PROP,
        script: { type: "string", description: "Function source, e.g. \"() => document.title\" or \"(sel) => ...\"" },
        args: {
          type: "array",
          description: "Optional arguments passed to the function",
          items: {},
        },
      },
      required: ["script"],
    },
    isEnabled: browserToolsEnabled,
    handler: withTabId((args) => browserTools.execute_script(args)),
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

  registerMcpTool({
    name: "search_documents",
    description:
      "Semantic search over selected PDF documents (check Include in RAG search in Documents). Returns relevant text chunks with page numbers and citation ids for the PDF viewer. Pass doc_ids to search specific documents.",
    groups: ["dialogue", "rag"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        doc_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional document ids; defaults to documents checked for RAG search",
        },
        top_k: {
          type: "integer",
          description: "Number of chunks to return (1-20, default 5)",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
    },
    isEnabled: ragToolsEnabled,
    handler: async (args, context) => {
      const resolved = prepareSearchToolArgs("search_documents", args, context.userQuery);
      const docIds = await resolveSearchDocIds(resolved.doc_ids);
      if (!docIds.length) {
        return {
          results: [],
          message: "No documents selected for RAG search. Check documents in Dialogue or pass doc_ids.",
        };
      }
      const hits = await searchDocuments(resolved.query, context.settings || {}, {
        docIds,
        topK: resolved.top_k,
      });
      return { results: hits.map(formatSearchHit) };
    },
  });

  registerMcpTool({
    name: "list_documents",
    description: "List ingested PDF documents (metadata only).",
    groups: ["dialogue", "rag"],
    inputSchema: { type: "object", properties: {} },
    isEnabled: ragToolsEnabled,
    handler: async () => {
      const docs = await ragStore.listDocuments();
      return {
        documents: docs.map((d) => ({
          doc_id: d.id,
          name: d.name,
          page_count: d.pageCount,
          chunk_count: d.chunkCount,
          size_bytes: d.sizeBytes,
          chunk_size: d.chunkSize,
          chunk_overlap: d.chunkOverlap,
          embed_provider: d.embedProvider,
          embed_model: d.embedModel,
          created_at: d.createdAt,
        })),
      };
    },
  });

  registerMcpTool({
    name: "delete_document",
    description: "Delete an ingested PDF and all its chunks from local storage.",
    groups: ["dialogue", "rag"],
    inputSchema: {
      type: "object",
      properties: { doc_id: { type: "string", description: "Document id to delete" } },
      required: ["doc_id"],
    },
    isEnabled: ragToolsEnabled,
    handler: async (args) => {
      await ragStore.deleteDocument(args.doc_id);
      const active = await getActiveDocIds();
      if (active.includes(args.doc_id)) {
        await setActiveDocIds(active.filter((id) => id !== args.doc_id));
      }
      return { ok: true, doc_id: args.doc_id };
    },
  });
}
