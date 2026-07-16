// Level 1 script editor: LLM loop restricted to a user-chosen SUBSET of
// components of the current agent system (system.editableKinds). It cannot
// read or write any component outside that grant — e.g. it may be limited to
// only the Curve Plotter's "ui" script (the code that turns "y = x^2" into
// the plotted curve) while agent/tools/html/css stay locked.
//
// The system prompt sent to the LLM has two parts: an editable persona
// (L1_DEFAULT_PERSONA, or the system's own custom `systemPrompt` if set) and
// a fixed protocol suffix (L1_PROTOCOL) describing the tool contract and the
// strict JSON reply format that editor-loop.js's parser depends on. The
// protocol suffix is always appended verbatim so a custom persona can never
// break response parsing.

import { runEditorLoop } from "./editor-loop.js";
import { getComponent, getEditableKinds, getSystem, writeComponent } from "./system-store.js";
import { buildL1SystemPrompt } from "./l1-prompt.js";

const KIND_DESCRIPTIONS = {
  agent: "the system prompt / policy text for the system's own agent loop",
  tools: "the JS tool functions (assigns self.__agentTools)",
  html: "the home page markup",
  css: "the home page styles",
  ui: "the home page JavaScript (runs in a sandbox after html/css mount; e.g. the code that turns an equation like y = x^2 into the plotted curve)",
};

export async function runScriptEditor({
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
  const kinds = getEditableKinds(system);

  const tools = {
    list_scripts: () => kinds.map((k) => ({ kind: k, description: KIND_DESCRIPTIONS[k] })),
    read_script: async ({ kind }) => {
      if (!kinds.includes(kind)) throw new Error(`"${kind}" is not an editable script for this system`);
      const comp = await getComponent(systemId, kind);
      return { kind, content: comp?.content || "", updatedAt: comp?.updatedAt };
    },
    write_script: async ({ kind, content }) => {
      if (!kinds.includes(kind)) throw new Error(`"${kind}" is not an editable script for this system`);
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

  const systemPrompt = buildL1SystemPrompt(system.systemPrompt);
  const kindsDesc = kinds.map((k) => `${k} (${KIND_DESCRIPTIONS[k]})`).join("; ");

  return runEditorLoop({
    systemPrompt,
    userIntro: `Current system: "${system.name}" (id: ${systemId})\nEditable scripts: ${kindsDesc}.\nAll other components are locked.\nTask: ${task}`,
    tools,
    settings,
    onEvent,
    onComplete,
  });
}
