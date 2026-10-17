// Flow session/node tools for the currently selected Flow session.

import { callMcpTool } from "../../server.js";
import { chatCompletions } from "../../../llm.js";
import { getMaxTokens } from "../../../llm-config.js";
import { resolveChatModel } from "../../../llm-providers.js";
import {
  addFlowNode,
  deleteFlowNode,
  getFlowSession,
  writeFlowNode,
} from "../../../modes/flow/flow-store.js";
import {
  assistantTextFromCompletion,
  createFlowApi,
  executeFlowNode,
} from "../../../modes/flow/runner.js";

export function resolveFlowSessionId(context = {}) {
  const id = context.flowSessionId || context.settings?.flowSessionId;
  if (!id) throw new Error("No Flow session selected");
  return id;
}

export function broadcastFlowReload(flowSessionId) {
  chrome.runtime.sendMessage({ type: "flow.reload", flowSessionId }).catch(() => {});
}

export function broadcastFlowUpdated(flowSessionId, nodeId = null) {
  chrome.runtime.sendMessage({ type: "flow.updated", flowSessionId, nodeId }).catch(() => {});
}

/** Accept nodeId or common LLM alias node_id; also from nested node.id. */
function resolveNodeId(args = {}) {
  const nested = args.node && typeof args.node === "object" ? args.node : null;
  const id = args.nodeId ?? args.node_id ?? nested?.id ?? nested?.nodeId;
  if (id == null || String(id).trim() === "") return "";
  return String(id);
}

/**
 * Flatten write_flow_node args. Models often echo read_flow_node shape as { nodeId, node: {...} }.
 * Top-level fields win over nested node fields.
 */
function resolveWriteFlowPatch(args = {}) {
  const nested = args.node && typeof args.node === "object" ? args.node : {};
  const pick = (key) => (args[key] !== undefined ? args[key] : nested[key]);
  const patch = {};
  const title = pick("title");
  const model = pick("model");
  const inputs = pick("inputs");
  const script = pick("script");
  const outputs = pick("outputs");
  if (title !== undefined) patch.title = title;
  if (model !== undefined) patch.model = model == null ? "" : String(model);
  if (inputs !== undefined) patch.inputs = inputs;
  if (script !== undefined) patch.script = script;
  if (outputs !== undefined) patch.outputs = outputs;
  return patch;
}

function summarizeNode(node) {
  return {
    id: node.id,
    title: node.title,
    model: node.model || "",
    status: node.status || "idle",
    inputKeys: Object.keys(node.inputs || {}),
    scriptBytes: String(node.script || "").length,
    hasOutputs: node.outputs != null && Object.keys(node.outputs || {}).length > 0,
    error: node.error || null,
  };
}

export async function list_flow_nodes({ flowSessionId }) {
  const session = await getFlowSession(flowSessionId);
  if (!session) throw new Error(`Flow session not found: ${flowSessionId}`);
  return {
    flowSessionId,
    title: session.title,
    nodes: (session.nodes || []).map(summarizeNode),
  };
}

export async function read_flow_node(args = {}) {
  const { flowSessionId } = args;
  const nodeId = resolveNodeId(args);
  if (!nodeId) throw new Error('read_flow_node requires nodeId (or node_id)');
  const session = await getFlowSession(flowSessionId);
  if (!session) throw new Error(`Flow session not found: ${flowSessionId}`);
  const node = session.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Flow node not found: ${nodeId}`);
  return {
    flowSessionId,
    node: {
      id: node.id,
      title: node.title,
      model: node.model || "",
      inputs: node.inputs || {},
      script: node.script || "",
      outputs: node.outputs,
      status: node.status || "idle",
      error: node.error || null,
    },
  };
}

export async function write_flow_node(args = {}) {
  const { flowSessionId } = args;
  const nodeId = resolveNodeId(args);
  if (!nodeId) throw new Error("write_flow_node requires nodeId (or node_id)");
  const patch = resolveWriteFlowPatch(args);
  if (!Object.keys(patch).length) {
    throw new Error(
      "write_flow_node needs at least one of title, model, inputs, script, outputs " +
        "(top-level or inside a node object)"
    );
  }
  const { node } = await writeFlowNode(flowSessionId, nodeId, patch);
  broadcastFlowUpdated(flowSessionId, nodeId);
  return {
    ok: true,
    flowSessionId,
    node: summarizeNode(node),
  };
}

export async function add_flow_node({ flowSessionId, title, model, inputs, script }) {
  const { node } = await addFlowNode(flowSessionId, { title, model, inputs, script });
  broadcastFlowUpdated(flowSessionId, node.id);
  return { ok: true, flowSessionId, node: summarizeNode(node) };
}

export async function delete_flow_node(args = {}) {
  const { flowSessionId } = args;
  const nodeId = resolveNodeId(args);
  if (!nodeId) throw new Error("delete_flow_node requires nodeId (or node_id)");
  await deleteFlowNode(flowSessionId, nodeId);
  broadcastFlowUpdated(flowSessionId, nodeId);
  return { ok: true, flowSessionId, nodeId };
}

function resolveNodeChatModel(settings, nodeModel) {
  const override = nodeModel != null ? String(nodeModel).trim() : "";
  return override || resolveChatModel(settings || {});
}

function buildApi(context, nodeModel = "") {
  return createFlowApi({
    model: nodeModel,
    callTool: (name, args) => callMcpTool(name, args || {}, context),
    llm: async (prompt, model) => {
      const settings = context.settings || {};
      const res = await chatCompletions(
        {
          model: resolveNodeChatModel(settings, model),
          messages: [{ role: "user", content: prompt }],
          temperature: settings.temperature ?? 0.2,
          max_tokens: getMaxTokens(settings),
        },
        settings
      );
      return assistantTextFromCompletion(res);
    },
  });
}

export async function run_flow_node(args = {}, context = {}) {
  const { flowSessionId } = args;
  const nodeId = resolveNodeId(args);
  if (!nodeId) throw new Error("run_flow_node requires nodeId (or node_id)");
  const session = await getFlowSession(flowSessionId);
  if (!session) throw new Error(`Flow session not found: ${flowSessionId}`);
  const node = session.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Flow node not found: ${nodeId}`);

  await writeFlowNode(flowSessionId, nodeId, { status: "running", error: null });
  broadcastFlowUpdated(flowSessionId, nodeId);

  const result = await executeFlowNode(node, buildApi(context, node.model));
  const { node: saved } = await writeFlowNode(flowSessionId, nodeId, {
    outputs: result.outputs,
    status: result.status,
    error: result.error,
  });
  broadcastFlowUpdated(flowSessionId, nodeId);
  return {
    ok: result.status === "done",
    flowSessionId,
    node: {
      ...summarizeNode(saved),
      outputs: saved.outputs,
      error: saved.error,
    },
  };
}

export async function run_flow_session({ flowSessionId }, context = {}) {
  const session = await getFlowSession(flowSessionId);
  if (!session) throw new Error(`Flow session not found: ${flowSessionId}`);
  const results = [];
  for (const node of session.nodes) {
    const one = await run_flow_node({ flowSessionId, nodeId: node.id }, context);
    results.push(one.node);
    if (!one.ok) {
      return { ok: false, flowSessionId, stoppedAt: node.id, nodes: results };
    }
  }
  return { ok: true, flowSessionId, nodes: results };
}

export async function reload_flow_ui({ flowSessionId }) {
  broadcastFlowReload(flowSessionId);
  return { ok: true, flowSessionId };
}
