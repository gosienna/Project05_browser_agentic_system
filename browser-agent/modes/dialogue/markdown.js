// Lightweight Markdown → safe HTML for Dialogue bubbles (GFM-ish subset).

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);
}

/** Render Markdown to sanitized HTML. Unknown / raw HTML is escaped. */
export function renderMarkdown(src) {
  const text = String(src ?? "").replace(/\r\n?/g, "\n");
  if (!text) return "";

  const codeBlocks = [];
  const withFences = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    const language = String(lang || "").trim().replace(/[^\w.+#-]/g, "");
    const body = escapeHtml(String(code).replace(/\n$/, ""));
    const langAttr = language ? ` class="language-${escapeHtml(language)}" data-lang="${escapeHtml(language)}"` : "";
    codeBlocks.push(`<pre class="dialogue-md-code"><code${langAttr}>${body}</code></pre>`);
    return `\n\n%%CODEBLOCK_${i}%%\n\n`;
  });

  const blocks = splitBlocks(withFences);
  const html = blocks.map((block) => renderBlock(block, codeBlocks)).join("");
  return html.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)] || "");
}

function splitBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^%%CODEBLOCK_\d+%%$/.test(line.trim())) {
      blocks.push({ type: "raw", text: line.trim() });
      i += 1;
      continue;
    }

    if (/^(\|{0,1}.+\|.+)$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      blocks.push({ type: "heading", level: m[1].length, text: m[2].replace(/\s+#+\s*$/, "") });
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", text: quoted.join("\n") });
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ type: ordered ? "ol" : "ul", items });
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^%%CODEBLOCK_\d+%%$/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      if (/^(\|{0,1}.+\|.+)$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        break;
      }
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) {
      blocks.push({ type: "paragraph", text: para.join("\n") });
    }
  }
  return blocks;
}

function renderBlock(block, codeBlocks) {
  switch (block.type) {
    case "raw":
      return block.text.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)] || "");
    case "heading": {
      const level = Math.min(6, Math.max(1, block.level));
      return `<h${level}>${renderInline(block.text)}</h${level}>`;
    }
    case "hr":
      return "<hr />";
    case "blockquote":
      return `<blockquote>${renderInline(block.text).replace(/\n/g, "<br />")}</blockquote>`;
    case "ul":
      return `<ul>${block.items.map((item) => `<li>${renderInline(item).replace(/\n/g, "<br />")}</li>`).join("")}</ul>`;
    case "ol":
      return `<ol>${block.items.map((item) => `<li>${renderInline(item).replace(/\n/g, "<br />")}</li>`).join("")}</ol>`;
    case "table":
      return renderTable(block.rows);
    case "paragraph":
      return `<p>${renderInline(block.text).replace(/\n/g, "<br />")}</p>`;
    default:
      return "";
  }
}

function renderTable(rows) {
  if (rows.length < 2) return `<p>${renderInline(rows.join(" "))}</p>`;
  const alignRow = rows[1];
  const aligns = splitTableRow(alignRow).map((cell) => {
    const t = cell.trim();
    if (/^:-+:$/.test(t)) return "center";
    if (/^-+:$/.test(t)) return "right";
    if (/^:-+$/.test(t)) return "left";
    return "";
  });
  const head = splitTableRow(rows[0]);
  const body = rows.slice(2).map(splitTableRow);
  const th = head
    .map((cell, i) => {
      const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
      return `<th${align}>${renderInline(cell.trim())}</th>`;
    })
    .join("");
  const trs = body
    .map((cols) => {
      const tds = cols
        .map((cell, i) => {
          const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
          return `<td${align}>${renderInline(cell.trim())}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<div class="dialogue-md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function splitTableRow(line) {
  const trimmed = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|");
}

function renderInline(text) {
  let s = String(text ?? "");
  const slots = [];
  const park = (html) => {
    const i = slots.length;
    slots.push(html);
    return `%%MDSLOT${i}%%`;
  };

  // Inline code first
  s = s.replace(/`([^`]+)`/g, (_, code) => park(`<code>${escapeHtml(code)}</code>`));

  // Images / links before escaping so we can validate URLs
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, alt, url) => {
    if (!isSafeUrl(url)) return full;
    return park(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" />`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, label, url) => {
    if (!isSafeUrl(url)) return full;
    return park(
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    );
  });

  s = escapeHtml(s);

  // Autolink bare https? URLs (already escaped text)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s&<]+)/g, (_, pre, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    if (!isSafeUrl(decoded)) return `${pre}${url}`;
    return `${pre}${park(`<a href="${escapeHtml(decoded)}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`;
  });

  // Bold / italic / strike — only on escaped plain text (placeholders have no *_~)
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return s.replace(/%%MDSLOT(\d+)%%/g, (_, i) => slots[Number(i)] || "");
}

function isSafeUrl(url) {
  const u = String(url || "").trim();
  return /^(https?:|mailto:|\/|#)/i.test(u);
}
