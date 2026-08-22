// Drag-to-resize widths for Dialogue side panels (Documents, PDF viewer).

const STORAGE_KEY = "dialoguePanelWidths";

const PANELS = {
  documents: {
    id: "dialogue-documents-panel",
    cssVar: "--dialogue-documents-width",
    defaultWidth: 240,
    min: 160,
    max: 520,
  },
  pdf: {
    id: "dialogue-pdf-panel",
    cssVar: "--dialogue-pdf-width",
    defaultWidth: 300,
    min: 200,
    max: 640,
  },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function maxForPanel(panelEl, config) {
  const layout = panelEl?.closest(".dialogue-layout");
  const layoutW = layout?.getBoundingClientRect().width || 800;
  return Math.min(config.max, Math.floor(layoutW * 0.55));
}

function applyPanelWidth(panelEl, config, widthPx) {
  const w = clamp(widthPx, config.min, maxForPanel(panelEl, config));
  panelEl.style.setProperty(config.cssVar, `${w}px`);
  return w;
}

async function loadWidths() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] || {};
  } catch {
    return {};
  }
}

async function saveWidths(widths) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: widths });
  } catch {
    // ignore persistence errors
  }
}

function wirePanelResize(panelEl, config, getSavedWidth, setSavedWidth) {
  const handle = document.createElement("div");
  handle.className = "dialogue-panel-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize panel");
  handle.tabIndex = 0;
  panelEl.prepend(handle);

  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  function currentWidth() {
    const raw = getComputedStyle(panelEl).getPropertyValue(config.cssVar).trim();
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : config.defaultWidth;
  }

  function beginDrag(clientX) {
    if (panelEl.classList.contains("collapsed")) return;
    dragging = true;
    startX = clientX;
    startWidth = currentWidth();
    panelEl.classList.add("resizing");
    document.body.classList.add("dialogue-panel-resizing");
  }

  function moveDrag(clientX) {
    if (!dragging) return;
    const delta = startX - clientX;
    applyPanelWidth(panelEl, config, startWidth + delta);
  }

  async function endDrag() {
    if (!dragging) return;
    dragging = false;
    panelEl.classList.remove("resizing");
    document.body.classList.remove("dialogue-panel-resizing");
    const w = applyPanelWidth(panelEl, config, currentWidth());
    setSavedWidth(w);
    await saveWidths(getSavedWidth());
  }

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    beginDrag(e.clientX);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    moveDrag(e.clientX);
  });
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  handle.addEventListener("keydown", (e) => {
    if (panelEl.classList.contains("collapsed")) return;
    let step = 0;
    if (e.key === "ArrowLeft") step = 12;
    else if (e.key === "ArrowRight") step = -12;
    else return;
    e.preventDefault();
    const w = applyPanelWidth(panelEl, config, currentWidth() + step);
    setSavedWidth(w);
    saveWidths(getSavedWidth());
  });
}

/**
 * @param {{ $: (id: string) => HTMLElement | null }} deps
 */
export async function initDialoguePanelResize({ $ }) {
  const saved = await loadWidths();
  const widths = { ...saved };

  for (const [key, config] of Object.entries(PANELS)) {
    const panelEl = $(`#${config.id}`);
    if (!panelEl) continue;

    const initial = widths[key] ?? config.defaultWidth;
    applyPanelWidth(panelEl, config, initial);
    widths[key] = applyPanelWidth(panelEl, config, initial);

    wirePanelResize(
      panelEl,
      config,
      () => widths,
      (w) => {
        widths[key] = w;
      }
    );
  }

  window.addEventListener("resize", () => {
    for (const [key, config] of Object.entries(PANELS)) {
      const panelEl = $(`#${config.id}`);
      if (!panelEl || panelEl.classList.contains("collapsed")) continue;
      const w = applyPanelWidth(panelEl, config, currentWidthFromPanel(panelEl, config));
      widths[key] = w;
    }
  });
}

function currentWidthFromPanel(panelEl, config) {
  const raw = getComputedStyle(panelEl).getPropertyValue(config.cssVar).trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : config.defaultWidth;
}
