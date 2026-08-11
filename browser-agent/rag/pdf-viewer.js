// In-extension PDF viewer with text highlight overlays (reads blobs from IndexedDB).

import { toArrayBuffer } from "./binary.js";
import * as ragStore from "./rag-store.js";

let pdfjsModule = null;

function vendorUrl(file) {
  return new URL(`../vendor/pdf/${file}`, import.meta.url).href;
}

async function loadPdfJs() {
  if (!pdfjsModule) {
    try {
      pdfjsModule = await import(vendorUrl("pdf.min.mjs"));
    } catch (err) {
      throw new Error(
        `Failed to load PDF.js (${err?.message || err}). Run "npm run build:vendor" in browser-agent/, then reload the extension.`
      );
    }
    if (pdfjsModule.GlobalWorkerOptions) {
      pdfjsModule.GlobalWorkerOptions.workerSrc = vendorUrl("pdf.worker.mjs");
    }
  }
  return pdfjsModule;
}

/** Build page text + char offsets (same rules as pdf-parse.js). */
function buildPageTextMap(items) {
  let text = "";
  const ranges = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const str = item?.str ?? "";
    if (!str) continue;
    const prefix = text.length > 0 && !text.endsWith(" ") ? " " : "";
    if (prefix) {
      ranges.push({ itemIndex, charStart: 0, charEnd: 0, isSpace: true });
      text += prefix;
    }
    const start = text.length;
    text += str;
    ranges.push({ itemIndex, charStart: 0, charEnd: str.length, isSpace: false, textStart: start });
    for (let i = 1; i < str.length; i++) {
      ranges.push({ itemIndex, charStart: i, charEnd: i + 1, isSpace: false, textStart: start + i });
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return { text: normalized, items, ranges };
}

function itemBounds(pdfjs, viewport, item) {
  const tx = pdfjs.Util.transform(viewport.transform, item.transform);
  const x = tx[4];
  const y = tx[5];
  const w = item.width * viewport.scale;
  const h = item.height * viewport.scale;
  return { left: x, top: y - h, width: w, height: h };
}

function pdfToggleButton() {
  return typeof document !== "undefined" ? document.getElementById("dialogue-pdf-toggle") : null;
}

/**
 * @param {HTMLElement} root
 * @param {{ panel?: HTMLElement }} [options]
 */
export function initPdfViewer(root, { panel: panelEl, onPanelChange } = {}) {
  const panel = panelEl || root.closest(".dialogue-pdf-panel");

  function openPanel() {
    panel?.classList.remove("collapsed");
    pdfToggleButton()?.setAttribute("aria-expanded", "true");
    onPanelChange?.();
  }

  function closePanel() {
    panel?.classList.add("collapsed");
    pdfToggleButton()?.setAttribute("aria-expanded", "false");
    onPanelChange?.();
  }

  const state = {
    pdf: null,
    docName: "",
    page: 1,
    pageCount: 1,
    scale: 1.2,
  };

  root.innerHTML = `
    <div class="pdf-viewer-toolbar">
      <span class="pdf-viewer-title"></span>
      <button type="button" class="secondary-btn pdf-prev">Prev</button>
      <input type="number" class="pdf-page-input" min="1" value="1" />
      <span class="pdf-page-count"></span>
      <button type="button" class="secondary-btn pdf-next">Next</button>
      <button type="button" class="secondary-btn pdf-zoom-out">−</button>
      <button type="button" class="secondary-btn pdf-zoom-in">+</button>
      <button type="button" class="icon-btn pdf-close" title="Close viewer">✕</button>
    </div>
    <div class="pdf-viewer-error hidden"></div>
    <div class="pdf-viewer-snippet hidden"></div>
    <div class="pdf-viewer-canvas-wrap">
      <canvas class="pdf-canvas"></canvas>
      <div class="pdf-highlight-layer"></div>
    </div>
  `;

  const titleEl = root.querySelector(".pdf-viewer-title");
  const errorEl = root.querySelector(".pdf-viewer-error");
  const snippetEl = root.querySelector(".pdf-viewer-snippet");
  const canvas = root.querySelector(".pdf-canvas");
  const layer = root.querySelector(".pdf-highlight-layer");
  const pageInput = root.querySelector(".pdf-page-input");
  const pageCountEl = root.querySelector(".pdf-page-count");
  const ctx = canvas.getContext("2d");

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
    canvas.style.display = "none";
    layer.style.display = "none";
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
    canvas.style.display = "";
    layer.style.display = "";
  }

  async function renderPage(highlight) {
    if (!state.pdf) return;
    clearError();
    const pdfjs = await loadPdfJs();
    const page = await state.pdf.getPage(state.page);
    const viewport = page.getViewport({ scale: state.scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    layer.innerHTML = "";

    await page.render({ canvasContext: ctx, viewport }).promise;
    pageCountEl.textContent = `/ ${state.pageCount}`;
    pageInput.value = String(state.page);
    titleEl.textContent = state.docName;

    if (highlight?.charStart != null && highlight?.charEnd != null) {
      const content = await page.getTextContent();
      const { text } = buildPageTextMap(content.items);
      if (text) {
        const start = Math.max(0, highlight.charStart);
        const end = Math.min(text.length, highlight.charEnd);
        const slice = text.slice(start, end);
        if (slice) snippetEl.textContent = slice;
        snippetEl.classList.remove("hidden");

        const itemSet = new Set();
        let pos = 0;
        for (const item of content.items) {
          const str = item?.str ?? "";
          if (!str) continue;
          const prefix = pos > 0 ? 1 : 0;
          const itemStart = pos + prefix;
          const itemEnd = itemStart + str.length;
          if (itemEnd > start && itemStart < end) itemSet.add(item);
          pos = itemEnd;
        }
        for (const item of itemSet) {
          const b = itemBounds(pdfjs, viewport, item);
          const div = document.createElement("div");
          div.className = "pdf-highlight";
          div.style.left = `${b.left}px`;
          div.style.top = `${b.top}px`;
          div.style.width = `${b.width}px`;
          div.style.height = `${b.height}px`;
          layer.appendChild(div);
        }
      }
    } else {
      snippetEl.classList.add("hidden");
      snippetEl.textContent = "";
    }
  }

  async function loadDoc(docId, highlight) {
    const doc = await ragStore.getDocument(docId);
    if (!doc) throw new Error(`Document "${docId}" not found.`);

    const blobRow = await ragStore.getPdfBlob(docId);
    const data = toArrayBuffer(blobRow?.blob);
    if (!data?.byteLength) {
      throw new Error(`PDF file data missing for "${doc.name}". Try re-ingesting the document.`);
    }

    const pdfjs = await loadPdfJs();
    state.pdf = await pdfjs.getDocument({ data, disableWorker: true }).promise;
    state.docName = doc.name || "PDF";
    state.pageCount = state.pdf.numPages;
    state.page = highlight?.page || 1;
    await renderPage(highlight?.loc || highlight);
  }

  root.querySelector(".pdf-prev").addEventListener("click", async () => {
    if (state.page > 1) {
      state.page--;
      try {
        await renderPage();
      } catch (err) {
        showError(err.message);
      }
    }
  });
  root.querySelector(".pdf-next").addEventListener("click", async () => {
    if (state.page < state.pageCount) {
      state.page++;
      try {
        await renderPage();
      } catch (err) {
        showError(err.message);
      }
    }
  });
  pageInput.addEventListener("change", async () => {
    const n = Math.min(Math.max(1, Number(pageInput.value) || 1), state.pageCount);
    state.page = n;
    try {
      await renderPage();
    } catch (err) {
      showError(err.message);
    }
  });
  root.querySelector(".pdf-zoom-in").addEventListener("click", async () => {
    state.scale = Math.min(state.scale + 0.2, 3);
    try {
      await renderPage();
    } catch (err) {
      showError(err.message);
    }
  });
  root.querySelector(".pdf-zoom-out").addEventListener("click", async () => {
    state.scale = Math.max(state.scale - 0.2, 0.6);
    try {
      await renderPage();
    } catch (err) {
      showError(err.message);
    }
  });
  root.querySelector(".pdf-close").addEventListener("click", () => {
    closePanel();
  });

  async function openWithHighlight(docId, highlight) {
    openPanel();
    clearError();
    try {
      await loadDoc(docId, highlight);
    } catch (err) {
      console.error("[pdf-viewer] open failed", err);
      showError(err?.message || String(err));
    }
  }

  return {
    openCitation({ docId, chunkId, page, loc }) {
      if (chunkId) {
        return ragStore.getChunk(chunkId).then((chunk) => {
          if (!chunk) throw new Error(`Citation chunk "${chunkId}" not found.`);
          return openWithHighlight(docId, { page: chunk.page, loc: chunk.loc });
        }).catch((err) => {
          console.error("[pdf-viewer] citation open failed", err);
          openPanel();
          showError(err?.message || String(err));
        });
      }
      return openWithHighlight(docId, { page, loc });
    },
    openDoc(docId) {
      return openWithHighlight(docId, { page: 1 });
    },
    openPanel,
    close() {
      closePanel();
    },
  };
}
