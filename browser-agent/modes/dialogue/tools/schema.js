// Tool schema utilities: form ↔ OpenAI/Anthropic/Gemini shapes (dialogue + agent).

const PARAM_TYPES = ["string", "number", "integer", "boolean", "array", "object"];

export { PARAM_TYPES };

/** Empty form row for a new tool. */
export function emptyToolDraft() {
  return { name: "", description: "", parameters: [] };
}

/** Empty parameter row. */
export function emptyParamDraft() {
  return { name: "", type: "string", description: "", required: false, enumValues: "" };
}

/**
 * Normalize one tool-like object to OpenAI chat.completions tools shape.
 * @returns {{ type: "function", function: { name: string, description?: string, parameters?: object } } | null}
 */
function normalizeOneTool(entry) {
  if (!entry || typeof entry !== "object") return null;

  if (entry.type === "function" && entry.function && typeof entry.function === "object") {
    const fn = entry.function;
    if (!fn.name || typeof fn.name !== "string") return null;
    return {
      type: "function",
      function: {
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
      },
    };
  }

  if (typeof entry.name === "string" && entry.name) {
    return {
      type: "function",
      function: {
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
        parameters:
          entry.parameters && typeof entry.parameters === "object"
            ? entry.parameters
            : { type: "object", properties: {} },
      },
    };
  }

  return null;
}

/**
 * Convert any accepted tools payload into OpenAI-shaped tools[].
 * @param {unknown} value
 * @returns {{ tools: object[], error: string|null }}
 */
export function toOpenAiTools(value) {
  if (value == null || value === "") return { tools: [], error: null };

  let list;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "object") {
    if (Array.isArray(value.function_declarations)) list = value.function_declarations;
    else if (Array.isArray(value.tools)) list = value.tools;
    else if ((value.type === "function" && value.function) || typeof value.name === "string") list = [value];
    else return { tools: [], error: 'Expected "function_declarations", "tools", a declaration array, or a single tool object.' };
  } else {
    return { tools: [], error: "Tools must be a JSON object or array." };
  }

  const tools = [];
  for (let i = 0; i < list.length; i++) {
    const t = normalizeOneTool(list[i]);
    if (!t) {
      return { tools: [], error: `Invalid tool at index ${i}: need a name (and optional description/parameters).` };
    }
    tools.push(t);
  }
  return { tools, error: null };
}

/**
 * Parse tools JSON (session restore / legacy) into OpenAI-shaped tools.
 * @param {string} text
 * @returns {{ tools: object[], error: string|null }}
 */
export function parseToolsJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { tools: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { tools: [], error: `Invalid JSON: ${err.message}` };
  }
  return toOpenAiTools(parsed);
}

/**
 * Form drafts → OpenAI tools. Skips tools with empty names.
 * @param {Array<{name:string, description:string, parameters:Array}>} drafts
 * @returns {{ tools: object[], error: string|null }}
 */
export function draftsToOpenAiTools(drafts) {
  const tools = [];
  const list = Array.isArray(drafts) ? drafts : [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const name = String(d?.name || "").trim();
    if (!name) {
      // Allow blank draft cards; only error if they filled params/description without a name.
      const hasOther =
        String(d?.description || "").trim() ||
        (d?.parameters || []).some((p) => String(p?.name || "").trim());
      if (hasOther) {
        return { tools: [], error: `Tool ${i + 1}: name is required.` };
      }
      continue;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return { tools: [], error: `Tool "${name}": name may only contain letters, numbers, _ and -.` };
    }

    const properties = {};
    const required = [];
    for (const p of d.parameters || []) {
      const pname = String(p?.name || "").trim();
      if (!pname) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(pname)) {
        return { tools: [], error: `Tool "${name}" parameter "${pname}": invalid name.` };
      }
      const prop = {
        type: PARAM_TYPES.includes(p.type) ? p.type : "string",
      };
      const desc = String(p?.description || "").trim();
      if (desc) prop.description = desc;
      const enumRaw = String(p?.enumValues || "").trim();
      if (enumRaw) {
        prop.enum = enumRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      properties[pname] = prop;
      if (p.required) required.push(pname);
    }

    const parameters = { type: "object", properties };
    if (required.length) parameters.required = required;

    tools.push({
      type: "function",
      function: {
        name,
        description: String(d.description || "").trim(),
        parameters,
      },
    });
  }
  return { tools, error: null };
}

/**
 * OpenAI tools (or JSON string / mixed) → form drafts for the UI.
 * @param {object[]|string|null} toolsOrJson
 * @returns {Array<{name:string, description:string, parameters:Array}>}
 */
export function openAiToolsToDrafts(toolsOrJson) {
  let tools = [];
  if (typeof toolsOrJson === "string") {
    const { tools: parsed, error } = parseToolsJson(toolsOrJson);
    if (error) return [];
    tools = parsed;
  } else if (Array.isArray(toolsOrJson)) {
    tools = toolsOrJson;
  }

  return tools.map((t) => {
    const fn = t?.function || t || {};
    const schema = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {};
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const parameters = Object.entries(props).map(([pname, def]) => {
      const d = def && typeof def === "object" ? def : {};
      return {
        name: pname,
        type: PARAM_TYPES.includes(d.type) ? d.type : "string",
        description: typeof d.description === "string" ? d.description : "",
        required: required.has(pname),
        enumValues: Array.isArray(d.enum) ? d.enum.join(", ") : "",
      };
    });
    return {
      name: typeof fn.name === "string" ? fn.name : "",
      description: typeof fn.description === "string" ? fn.description : "",
      parameters,
    };
  });
}

/** Serialize drafts to toolsJson for IndexedDB (OpenAI tools array). */
export function draftsToToolsJson(drafts) {
  const { tools, error } = draftsToOpenAiTools(drafts);
  if (error || !tools.length) return error ? null : "";
  return JSON.stringify(tools, null, 2);
}

/** OpenAI tools → Anthropic /v1/messages tools. */
export function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

/** JSON Schema keys accepted by Gemini function declaration parameters. */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "nullable",
  "required",
  "format",
  "description",
  "properties",
  "items",
  "enum",
  "anyOf",
  "$ref",
  "$defs",
]);

/**
 * Strip JSON Schema fields Gemini rejects (e.g. additionalProperties, $schema).
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling
 */
export function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [pname, pdef] of Object.entries(value)) {
        props[pname] = sanitizeGeminiSchema(pdef);
      }
      out.properties = props;
      continue;
    }

    if (key === "items") {
      out.items = sanitizeGeminiSchema(value);
      continue;
    }

    if (key === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map(sanitizeGeminiSchema);
      continue;
    }

    if (key === "$defs" && value && typeof value === "object" && !Array.isArray(value)) {
      const defs = {};
      for (const [dname, ddef] of Object.entries(value)) {
        defs[dname] = sanitizeGeminiSchema(ddef);
      }
      out.$defs = defs;
      continue;
    }

    out[key] = value;
  }
  return out;
}

/** OpenAI tools → Gemini-style { function_declarations }. */
export function toGemmaFunctionDeclarations(tools) {
  return {
    function_declarations: (tools || []).map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: sanitizeGeminiSchema(t.function.parameters || { type: "object", properties: {} }),
    })),
  };
}

/** OpenAI tools → Gemini generateContent `tools` array. */
export function toGeminiTools(tools) {
  const declarations = (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    parameters: sanitizeGeminiSchema(t.function.parameters || { type: "object", properties: {} }),
  }));
  if (!declarations.length) return undefined;
  return [{ functionDeclarations: declarations }];
}
