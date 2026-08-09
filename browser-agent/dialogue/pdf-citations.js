// Clickable PDF citation chips in Dialogue.

let openCitationFn = null;

export function bindPdfCitationOpener(fn) {
  openCitationFn = fn;
}

export function renderCitationChips(citations, container) {
  if (!container || !citations?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "dialogue-citations";
  for (const c of citations) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dialogue-citation-chip";
    btn.textContent = `p.${c.page} · ${c.doc_name || "PDF"}`;
    btn.title = (c.text || "").slice(0, 200);
    btn.addEventListener("click", () => {
      openCitationFn?.({
        docId: c.doc_id,
        chunkId: c.chunk_id,
        page: c.page,
        loc: c.loc,
      });
    });
    wrap.appendChild(btn);
  }
  container.appendChild(wrap);
}

export function formatSearchDocumentsDisplay(result) {
  const hits = result?.results || [];
  if (!hits.length) {
    if (result?.message) return result.message;
    return "(no document matches)";
  }
  const lines = hits.map((h, i) => {
    const score = typeof h.score === "number" ? h.score.toFixed(3) : "n/a";
    const preview = (h.text || "").slice(0, 240).replace(/\s+/g, " ");
    return `${i + 1}. [p.${h.page} · ${h.doc_name}] (score ${score})\n   ${preview}${h.text?.length > 240 ? "…" : ""}`;
  });
  return `${lines.join("\n\n")}\n\n(Click “View in PDF” chips below the message to verify sources.)`;
}

export function citationsFromSearchResult(result) {
  return (result?.results || []).map((h) => ({
    chunk_id: h.chunk_id,
    doc_id: h.doc_id,
    doc_name: h.doc_name,
    page: h.page,
    text: h.text,
    loc: h.loc,
  }));
}
