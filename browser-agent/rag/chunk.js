// Text chunking with page-local char offsets for PDF citation highlights.

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;
export const MIN_CHUNK_SIZE = 200;
export const MAX_CHUNK_SIZE = 2000;
export const MAX_CHUNKS_PER_DOC = 2000;

export function validateChunkParams(chunkSize, chunkOverlap) {
  const size = Number(chunkSize);
  const overlap = Number(chunkOverlap);
  if (!Number.isFinite(size) || size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE) {
    throw new Error(`Chunk size must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}.`);
  }
  const maxOverlap = Math.floor(size / 2);
  if (!Number.isFinite(overlap) || overlap < 0 || overlap > maxOverlap) {
    throw new Error(`Chunk overlap must be between 0 and ${maxOverlap}.`);
  }
  return { chunkSize: Math.round(size), chunkOverlap: Math.round(overlap) };
}

/**
 * Split text into chunks with char offsets relative to the input string.
 * @param {string} text
 * @param {{ chunkSize?: number, chunkOverlap?: number, page?: number }} opts
 * @returns {Array<{ text: string, loc: { page: number, charStart: number, charEnd: number } }>}
 */
export function chunkPageText(text, opts = {}) {
  const { chunkSize, chunkOverlap } = validateChunkParams(
    opts.chunkSize ?? DEFAULT_CHUNK_SIZE,
    opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP
  );
  const page = opts.page ?? 1;
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const slice = normalized.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! "),
        slice.lastIndexOf("; ")
      );
      if (breakAt > chunkSize * 0.4) end = start + breakAt + 1;
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) {
      const charStart = normalized.indexOf(piece, start);
      const charEnd = charStart + piece.length;
      chunks.push({
        text: piece,
        loc: { page, charStart, charEnd },
      });
    }
    if (end >= normalized.length) break;
    start = Math.max(end - chunkOverlap, start + 1);
  }
  return chunks;
}

/**
 * Chunk multiple pages; returns flat list with global index.
 * @param {Array<{ page: number, text: string }>} pages
 * @param {{ chunkSize?: number, chunkOverlap?: number }} opts
 */
export function chunkPages(pages, opts = {}) {
  const out = [];
  for (const { page, text } of pages) {
    const pageChunks = chunkPageText(text, { ...opts, page });
    for (const c of pageChunks) {
      if (out.length >= MAX_CHUNKS_PER_DOC) {
        throw new Error(`Document exceeds ${MAX_CHUNKS_PER_DOC} chunks — use a larger chunk size.`);
      }
      out.push({ ...c, index: out.length });
    }
  }
  return out;
}
