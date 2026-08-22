// Render accessibility snapshot nodes as Playwright-style YAML lines.

function yamlEscapeValue(value) {
  if (value == null || value === "") return '""';
  const s = String(value);
  if (/[:#\n\r\t[\]{},"'&*!?|>'@%`]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) {
    return JSON.stringify(s);
  }
  return JSON.stringify(s);
}

function indent(depth) {
  return "  ".repeat(depth);
}

/**
 * @param {object[]} nodes
 * @param {{ depth?: number, boxes?: boolean }} options
 */
export function renderSnapshotYaml(nodes, options = {}) {
  const lines = [];
  const maxDepth = options.depth != null && options.depth >= 0 ? options.depth : undefined;

  function visit(node, depth) {
    if (maxDepth != null && depth > maxDepth) return;

    let key = node.role;
    if (node.name) key += ` ${yamlEscapeValue(node.name)}`;

    const attrs = [];
    if (node.level != null) attrs.push(`level=${node.level}`);
    if (node.checked === true) attrs.push("checked");
    else if (node.checked === "mixed") attrs.push("checked=mixed");
    if (node.disabled) attrs.push("disabled");
    if (node.expanded) attrs.push("expanded");
    if (node.selected) attrs.push("selected");
    if (node.pressed === true) attrs.push("pressed");
    else if (node.pressed === "mixed") attrs.push("pressed=mixed");
    if (node.ref) {
      attrs.push(`ref=${node.ref}`);
      if (node.cursor === "pointer") attrs.push("cursor=pointer");
    }
    if (options.boxes && node.box) {
      const b = node.box;
      attrs.push(`box=${b.x},${b.y},${b.width},${b.height}`);
    }
    if (node.url) attrs.push(`url=${yamlEscapeValue(node.url)}`);

    for (const a of attrs) key += ` [${a}]`;

    lines.push(`${indent(depth)}- ${key}`);

    if (node.text) {
      const textLines = String(node.text).split("\n");
      for (const t of textLines) {
        if (t.trim()) lines.push(`${indent(depth + 1)}- text: ${yamlEscapeValue(t)}`);
      }
    }

    for (const child of node.children || []) visit(child, depth + 1);
  }

  for (const node of nodes) visit(node, 0);
  return lines.join("\n");
}
