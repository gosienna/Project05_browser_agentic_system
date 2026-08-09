// Dialogue RAG UI: PDF attach, documents panel, ingest progress.

import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from "../rag/config.js";
import { isDocumentCompatible } from "../rag/search.js";
import { putStagingPdf } from "../rag/rag-store.js";
import { parsePdfBuffer } from "../rag/pdf-parse.js";

let $;
let sendMessage;
let saveSettings;
let getSettings;
let escapeHtml;
let onOpenPdf;
let onRagContextChange;

function setRagStatus(text, { error = false } = {}) {
  const status = $("#dialogue-rag-status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("hidden", !text);
  status.classList.toggle("dialogue-rag-status-error", error);
}

function formatEngineProgress(msg) {
  if (!msg) return "";
  const pct =
    msg.total && msg.loaded != null ? `${Math.min(100, Math.round((msg.loaded / msg.total) * 100))}%` : "";
  const file = msg.file ? String(msg.file).split("/").pop() : "";
  return [msg.status || "downloading", file, pct].filter(Boolean).join(" ");
}

export function initRagUi(deps) {
  $ = deps.$;
  sendMessage = deps.sendMessage;
  saveSettings = deps.saveSettings;
  getSettings = deps.getSettings;
  escapeHtml = deps.escapeHtml;
  onOpenPdf = deps.onOpenPdf;
  onRagContextChange = deps.onRagContextChange;
}

export function wireRagUi() {
  $("#dialogue-pdf-btn")?.addEventListener("click", () => $("#dialogue-pdf-input")?.click());
  $("#dialogue-pdf-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await ingestPdfFile(file);
  });
  $("#dialogue-documents-toggle")?.addEventListener("click", () => {
    const panel = $("#dialogue-documents-panel");
    const collapsed = panel?.classList.toggle("collapsed");
    $("#dialogue-documents-toggle")?.setAttribute("aria-expanded", String(!collapsed));
    if (!collapsed) refreshDocumentsPanel();
  });
  $("#dialogue-pdf-toggle")?.addEventListener("click", () => {
    const panel = $("#dialogue-pdf-panel");
    const collapsed = panel?.classList.toggle("collapsed");
    $("#dialogue-pdf-toggle")?.setAttribute("aria-expanded", String(!collapsed));
  });
  $("#dialogue-chunk-save-default")?.addEventListener("change", () => {});
}

export async function refreshDocumentsPanel() {
  const list = $("#dialogue-docs-list");
  if (!list) return;
  let docsRes;
  let activeRes;
  try {
    [docsRes, activeRes] = await Promise.all([
      sendMessage({ type: "rag.listDocuments" }),
      sendMessage({ type: "rag.getActiveDocs" }),
    ]);
  } catch (err) {
    list.innerHTML = `<p class="dialogue-doc-warn">Could not load documents: ${escapeHtml(err.message)}</p>`;
    return;
  }

  if (docsRes?.error) {
    list.innerHTML = `<p class="dialogue-doc-warn">Could not load documents: ${escapeHtml(docsRes.error)}</p>`;
    return;
  }

  const docs = docsRes?.result || (Array.isArray(docsRes) ? docsRes : []);
  const active = new Set(activeRes?.result?.docIds || activeRes?.docIds || []);
  const settings = getSettings();

  list.innerHTML = "";
  if (!docs.length) {
    list.innerHTML = '<p class="dialogue-mcp-status">No PDFs ingested yet. Use the 📄 button below to attach a PDF.</p>';
    return;
  }

  for (const doc of docs) {
    const row = document.createElement("div");
    row.className = "dialogue-doc-row";
    const incompatible = !isDocumentCompatible(doc, settings);
    const sizeMb = (doc.sizeBytes / (1024 * 1024)).toFixed(2);
    row.innerHTML = `
      <label class="dialogue-doc-pin">
        <input type="checkbox" data-doc-id="${escapeHtml(doc.id)}" ${active.has(doc.id) ? "checked" : ""} />
        Pin for auto-retrieve
      </label>
      <div class="dialogue-doc-meta">
        <strong>${escapeHtml(doc.name)}</strong>
        <small>${doc.pageCount} pp · ${doc.chunkCount} chunks · ${sizeMb} MB · ${doc.chunkSize}/${doc.chunkOverlap}</small>
        ${incompatible ? '<span class="dialogue-doc-warn">Embed model changed — re-ingest</span>' : ""}
      </div>
      <div class="dialogue-doc-actions">
        <button type="button" class="secondary-btn doc-view" data-doc-id="${escapeHtml(doc.id)}">View</button>
        <button type="button" class="secondary-btn doc-delete" data-doc-id="${escapeHtml(doc.id)}">Delete</button>
      </div>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll(".dialogue-doc-pin input").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const ids = [...list.querySelectorAll(".dialogue-doc-pin input:checked")].map((el) => el.dataset.docId);
      await sendMessage({ type: "rag.setActiveDocs", docIds: ids });
      onRagContextChange?.();
    });
  });
  list.querySelectorAll(".doc-view").forEach((btn) => {
    btn.addEventListener("click", () => onOpenPdf?.({ docId: btn.dataset.docId }));
  });
  list.querySelectorAll(".doc-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this document and all chunks?")) return;
      await sendMessage({ type: "rag.deleteDocument", docId: btn.dataset.docId });
      await refreshDocumentsPanel();
    });
  });
}

function getChunkParams() {
  const size = Number($("#dialogue-chunk-size")?.value) || getSettings().ragChunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = Number($("#dialogue-chunk-overlap")?.value) || getSettings().ragChunkOverlap || DEFAULT_CHUNK_OVERLAP;
  return { chunkSize: size, chunkOverlap: overlap };
}

function revealDocumentsUi() {
  const panel = $("#dialogue-documents-panel");
  panel?.classList.remove("collapsed");
  $("#dialogue-documents-toggle")?.setAttribute("aria-expanded", "true");
}

async function ingestPdfFile(file) {
  const pdfBtn = $("#dialogue-pdf-btn");
  const { chunkSize, chunkOverlap } = getChunkParams();
  const saveDefault = $("#dialogue-chunk-save-default")?.checked;
  if (saveDefault) await saveSettings({ ragChunkSize: chunkSize, ragChunkOverlap: chunkOverlap });

  revealDocumentsUi();
  if (pdfBtn) pdfBtn.disabled = true;
  setRagStatus(`Reading ${file.name}…`);

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    setRagStatus(`Could not read file: ${err.message}`, { error: true });
    if (pdfBtn) pdfBtn.disabled = false;
    return;
  }

  const bytes = new Uint8Array(buffer);

  let pages;
  let pageCount;
  try {
    setRagStatus(`Parsing ${file.name}…`);
    // parsePdfBuffer hands this off to pdf.js, which detaches/transfers the
    // buffer internally — pass a throwaway copy, not `buffer` itself, since
    // `buffer` still needs to be staged into IndexedDB below.
    const parseCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const parsed = await parsePdfBuffer(parseCopy);
    pages = parsed.pages.map((p) => ({ page: p.page, text: p.text }));
    pageCount = parsed.pageCount;
  } catch (err) {
    setRagStatus(`PDF parse failed: ${err.message}`, { error: true });
    if (pdfBtn) pdfBtn.disabled = false;
    return;
  }

  const stagingId = crypto.randomUUID();
  setRagStatus(`Staging ${file.name}…`);

  try {
    await putStagingPdf(stagingId, {
      buffer,
      name: file.name,
      sizeBytes: bytes.byteLength,
    });
  } catch (err) {
    setRagStatus(`Could not stage PDF: ${err.message}`, { error: true });
    if (pdfBtn) pdfBtn.disabled = false;
    return;
  }

  setRagStatus(`Ingesting ${file.name} (${chunkSize}/${chunkOverlap})…`);

  const progressListener = (msg) => {
    if (msg?.target === "rag-progress" && msg.message) {
      setRagStatus(msg.message);
      return;
    }
    if (msg?.target === "onnx-progress" || msg?.target === "webllm-progress") {
      const label = formatEngineProgress(msg);
      if (label) setRagStatus(`Downloading embedding model… ${label}`);
      return;
    }
    if (msg?.target === "ollama-progress") {
      const pct =
        msg.total && msg.completed != null
          ? `${Math.min(100, Math.round((msg.completed / msg.total) * 100))}%`
          : "";
      const label = [msg.status || "pulling", pct].filter(Boolean).join(" ");
      if (label) setRagStatus(`Pulling embedding model… ${label}`);
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const res = await sendMessage({
      type: "rag.ingest",
      stagingId,
      name: file.name,
      pages,
      pageCount,
      chunkSize,
      chunkOverlap,
    });
    if (res?.error) throw new Error(typeof res.error === "string" ? res.error : res.error?.message || "Ingest failed");
    const r = res.result || res;
    if (!r?.docId) throw new Error("Ingest returned no document id.");
    setRagStatus(
      `Ingested ${file.name}: ${r.pageCount} pages, ${r.chunkCount} chunks (${r.chunkSize}/${r.chunkOverlap})`
    );
    const activeRes = await sendMessage({ type: "rag.getActiveDocs" });
    const pinned = activeRes?.result?.docIds || activeRes?.docIds || [];
    if (!pinned.includes(r.docId)) {
      await sendMessage({ type: "rag.setActiveDocs", docIds: [...pinned, r.docId] });
    }
    await refreshDocumentsPanel();
    onRagContextChange?.();
  } catch (err) {
    const message = err?.message || String(err);
    setRagStatus(`Ingest failed: ${message}`, { error: true });
    console.error("[rag] ingest failed", err);
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
    if (pdfBtn) pdfBtn.disabled = false;
  }
}

export function syncRagChunkInputs() {
  const s = getSettings();
  const sizeEl = $("#dialogue-chunk-size");
  const overlapEl = $("#dialogue-chunk-overlap");
  if (sizeEl && !sizeEl.matches(":focus")) sizeEl.value = String(s.ragChunkSize ?? DEFAULT_CHUNK_SIZE);
  if (overlapEl && !overlapEl.matches(":focus")) overlapEl.value = String(s.ragChunkOverlap ?? DEFAULT_CHUNK_OVERLAP);
}

export async function getPinnedAutoRetrieveContext(query, settings) {
  const activeRes = await sendMessage({ type: "rag.getActiveDocs" });
  const docIds = activeRes?.result?.docIds || activeRes?.docIds || [];
  if (!docIds.length || !query?.trim()) return { text: "", citations: [] };

  const searchRes = await sendMessage({ type: "rag.search", query, docIds, topK: 5 });
  if (searchRes?.error) {
    console.warn("[rag] auto-retrieve search failed:", searchRes.error);
    return { text: "", citations: [] };
  }
  const hits = Array.isArray(searchRes?.result) ? searchRes.result : Array.isArray(searchRes) ? searchRes : [];
  if (!hits.length) return { text: "", citations: [] };

  const lines = hits.map(
    (h) => `[doc: ${h.doc_name} p.${h.page}]\n${h.text}`
  );
  const citations = hits.map((h) => ({
    chunk_id: h.chunk_id,
    doc_id: h.doc_id,
    doc_name: h.doc_name,
    page: h.page,
    text: h.text,
    loc: h.loc,
  }));
  const text =
    "Relevant excerpts from pinned documents:\n\n" +
    lines.join("\n\n") +
    "\n\nAnswer using these excerpts when applicable. Use search_documents for broader search.";
  return { text, citations };
}

export function isRagToolsEnabled() {
  return getSettings().dialogueRagTools !== false;
}
