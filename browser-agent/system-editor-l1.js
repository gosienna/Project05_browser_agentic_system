// Level 1 script editor: LLM loop restricted to ONE designated component of
// the current agent system. It cannot read or write any other component —
// e.g. it may edit only the Curve Plotter's "ui" script (the code that turns
// "y = x^2" into the plotted curve) while agent/tools/html/css stay locked.

import { runEditorLoop } from "./editor-loop.js";
import { COMPONENT_KINDS, getComponent, getSystem, writeComponent } from "./system-store.js";

const L1_PROMPT = `You are a LEVEL 1 script editor with restricted access. You may modify exactly ONE component ("the script") of the current agent system — the one named in the task context. Every other component is locked.

Tools:
- read_script(): return the full current content of the script
- write_script({ content }): replace the script with the full new content string
- reload_home(): refresh the home UI so the user sees the latest script

Rules:
- Always write COMPLETE file contents (not patches).
- You have no tools to list, read, or write other components. If the task requires touching them, say so in your final answer instead of attempting it.
- If the script is home-page JavaScript (ui), it runs in a sandbox after the html/css mount, with (api, tools) in scope.
- If the script is a tools component, keep it plain JS that assigns self.__agentTools = { name: async (args, api) => ... }.
- After write_script, call reload_home before finishing.
- On every turn reply with exactly ONE JSON object:
  - Tool: {"thought":"...","tool":"<name>","args":{...}}
  - Done: {"thought":"...","final":"<summary for the user>"}
Do not wrap JSON in markdown fences.`;

const KIND_DESCRIPTIONS = {
  agent: "the system prompt / policy text for the system's own agent loop",
  tools: "the JS tool functions (assigns self.__agentTools)",
  html: "the home page markup",
  css: "the home page styles",
  ui: "the home page JavaScript (runs in a sandbox after html/css mount; e.g. the code that turns an equation like y = x^2 into the plotted curve)",
};

export async function runScriptEditor({
  systemId,
  kind = "ui",
  task,
  settings,
  onEvent,
  onReloadHome,
  onComponentWritten,
  onComplete,
}) {
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`Unknown component kind "${kind}"`);
  const system = await getSystem(systemId);
  if (!system) throw new Error(`Unknown system "${systemId}"`);

  const tools = {
    read_script: async () => {
      const comp = await getComponent(systemId, kind);
      return { kind, content: comp?.content || "", updatedAt: comp?.updatedAt };
    },
    write_script: async ({ content }) => {
      if (content === undefined) throw new Error("write_script requires content");
      const record = await writeComponent(systemId, kind, content);
      if (typeof onComponentWritten === "function") await onComponentWritten(kind);
      return { ok: true, kind, bytes: record.content.length, updatedAt: record.updatedAt };
    },
    reload_home: async () => {
      if (typeof onReloadHome === "function") await onReloadHome();
      return { ok: true };
    },
  };

  return runEditorLoop({
    systemPrompt: L1_PROMPT,
    userIntro: `Current system: "${system.name}" (id: ${systemId})\nEditable script: the "${kind}" component — ${KIND_DESCRIPTIONS[kind]}.\nAll other components are locked.\nTask: ${task}`,
    tools,
    settings,
    onEvent,
    onComplete,
  });
}
