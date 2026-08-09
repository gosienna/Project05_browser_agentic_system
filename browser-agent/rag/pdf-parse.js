// PDF text extraction via pdf.js (text-layer PDFs only).

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

/** Normalize whitespace consistently for chunking and highlight mapping. */
export function normalizePageText(items) {
  let text = "";
  const charMap = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const str = item?.str ?? "";
    if (!str) continue;
    const prefix = text.length > 0 && !text.endsWith(" ") ? " " : "";
    if (prefix) {
      charMap.push({ itemIndex, subStart: 0, subEnd: 0, isSpace: true });
      text += prefix;
    }
    for (let i = 0; i < str.length; i++) {
      charMap.push({ itemIndex, subStart: i, subEnd: i + 1, isSpace: false });
      text += str[i];
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), charMap };
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{ pages: Array<{ page: number, text: string, items: object[] }>, pageCount: number }>}
 */
export async function parsePdfBuffer(buffer) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: buffer, disableWorker: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  let totalChars = 0;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items || [];
    const { text } = normalizePageText(items);
    totalChars += text.length;
    pages.push({ page: pageNum, text, items });
  }

  if (totalChars === 0) {
    throw new Error(
      "No extractable text in this PDF (scanned/image PDFs are not supported yet). " +
        "Use a text-based PDF or OCR in a future release."
    );
  }

  return { pages, pageCount: pdf.numPages };
}
