// Meta-editor: LLM loop that can read/write every component of the current
// agent system stored in IndexedDB.

import { runEditorLoop } from "./editor-loop.js";
import {
  COMPONENT_KINDS,
  getAllComponents,
  getComponent,
  getSystem,
  listComponents,
  writeComponent,
} from "./system-store.js";

const EDITOR_PROMPT = `You are an agent-system editor with full control. You modify any component of the currently selected agent system in IndexedDB.

Component kinds:
- html: home page markup
- css: home page styles
- script: home page JavaScript (runs in a sandbox after html/css mount)

Tools:
- list_components(): list kinds and byte sizes for the current system
- read_component({ kind }): return full content of one component (kind: html|css|script)
- write_component({ kind, content }): replace a component with the full new content string
- reload_home(): refresh the home UI so the user sees the latest components

Rules:
- Always write COMPLETE file contents (not patches).
- Prefer editing script/css/html for visual/behavior changes on the home page.
- The runtime injects api into the script with listTabs, getActiveTab, executeInTab, readPage, click, typeText, scroll, navigate, captureTab.
- After write_component edits that affect the home page, call reload_home before finishing.
- On every turn reply with exactly ONE JSON object:
  - Tool: {"thought":"...","tool":"<name>","args":{...}}
  - Done: {"thought":"...","final":"<summary for the user>"}
Do not wrap JSON in markdown fences.`;

export async function runSystemEditor({
  systemId,
  task,
  settings,
  onEvent,
  onReloadHome,
  onComponentWritten,
  onComplete,
}) {
  const system = await getSystem(systemId);
  if (!system) throw new Error(`Unknown system "${systemId}"`);

  const tools = {
    list_components: () => listComponents(systemId),
    read_component: async ({ kind }) => {
      const comp = await getComponent(systemId, kind);
      if (!comp) return { kind, content: "", error: "empty or missing" };
      return { kind: comp.kind, content: comp.content, updatedAt: comp.updatedAt };
    },
    write_component: async ({ kind, content }) => {
      if (content === undefined) throw new Error("write_component requires content");
      const record = await writeComponent(systemId, kind, content);
      if (typeof onComponentWritten === "function") await onComponentWritten(record.kind);
      return { ok: true, kind: record.kind, bytes: record.content.length, updatedAt: record.updatedAt };
    },
    reload_home: async () => {
      if (typeof onReloadHome === "function") await onReloadHome();
      return { ok: true };
    },
    get_all_components: () => getAllComponents(systemId),
  };

  return runEditorLoop({
    systemPrompt: EDITOR_PROMPT,
    userIntro: `Current system: "${system.name}" (id: ${systemId})\nTask: ${task}\nAvailable kinds: ${COMPONENT_KINDS.join(", ")}`,
    tools,
    settings,
    onEvent,
    onComplete,
  });
}
