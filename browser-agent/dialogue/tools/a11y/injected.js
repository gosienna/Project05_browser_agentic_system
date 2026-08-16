// Injected into the page (isolated world) for accessibility snapshots and ref-based clicks.
// Loaded via chrome.scripting.executeScript({ files: ["dialogue/tools/a11y/injected.js"] }).

(function () {
  if (globalThis.__baA11yInjected) return;
  globalThis.__baA11yInjected = true;

  const REF_ATTR = "data-ba-ref";
  const GEN_ATTR = "data-ba-gen";
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "searchbox",
    "slider", "spinbutton", "switch", "tab", "treeitem",
  ]);
  const STRUCTURE_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "LABEL", "LI", "OPTION"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "IFRAME"]);

  function isHidden(el) {
    if (!(el instanceof Element)) return true;
    if (el.closest("[aria-hidden=true]")) return true;
    if (el.hasAttribute("hidden")) return true;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  function implicitRole(el) {
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "INPUT") {
      const map = {
        button: "button", submit: "button", reset: "button",
        checkbox: "checkbox", radio: "radio", email: "textbox", number: "spinbutton",
        password: "textbox", search: "searchbox", tel: "textbox", text: "textbox",
        url: "textbox", range: "slider",
      };
      return map[type] || "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "LI") return "listitem";
    if (tag === "LABEL") return "label";
    return null;
  }

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase().split(/\s+/)[0];
    return implicitRole(el);
  }

  function getAccessibleName(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => {
        const n = el.ownerDocument.getElementById(id);
        return n ? (n.innerText || n.textContent || "").trim() : "";
      }).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    if (el.id) {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return (label.innerText || label.textContent || "").trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    if (el.tagName === "INPUT" && el.value && ["submit", "button", "reset"].includes((el.type || "").toLowerCase())) {
      return el.value.trim();
    }
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 200);
  }

  function isInteractable(el, role) {
    if (!role) return false;
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.tagName;
    if (tag === "A" && el.hasAttribute("href")) return true;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.getAttribute("tabindex") != null && el.getAttribute("tabindex") !== "-1") return true;
    const style = window.getComputedStyle(el);
    if (style.cursor === "pointer") return true;
    return false;
  }

  function clearRefs(root) {
    if (root instanceof Element && root.hasAttribute(REF_ATTR)) root.removeAttribute(REF_ATTR);
    root.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR));
  }

  function buildNode(el, refCounter, options, depth, maxDepth) {
    if (depth > maxDepth) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (isHidden(el)) return null;

    const role = getRole(el);
    const name = getAccessibleName(el);
    const hasRole = role || STRUCTURE_TAGS.has(el.tagName) || el.hasAttribute("aria-label");

    if (!hasRole && !el.querySelector("a,button,input,textarea,select,[role]")) {
      const children = [];
      for (const child of el.children) {
        const n = buildNode(child, refCounter, options, depth, maxDepth);
        if (n) children.push(n);
      }
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { role: "generic", name: "", children };
    }

    const node = { role: role || "generic", name: name || "", children: [] };

    if (role === "heading") {
      const m = el.tagName.match(/^H(\d)$/);
      if (m) node.level = Number(m[1]);
    }
    if (el.hasAttribute("aria-disabled") || el.disabled) node.disabled = true;
    if (el.getAttribute("aria-expanded") === "true") node.expanded = true;
    if (el.getAttribute("aria-selected") === "true") node.selected = true;
    if (el.getAttribute("aria-checked") === "mixed") node.checked = "mixed";
    else if (el.getAttribute("aria-checked") === "true" || (el.tagName === "INPUT" && el.checked)) node.checked = true;
    if (el.getAttribute("aria-pressed") === "mixed") node.pressed = "mixed";
    else if (el.getAttribute("aria-pressed") === "true") node.pressed = true;

    if (role === "link" && el.hasAttribute("href")) node.url = el.href;

    if (isInteractable(el, node.role)) {
      refCounter.n += 1;
      const ref = `e${refCounter.n}`;
      el.setAttribute(REF_ATTR, ref);
      node.ref = ref;
      const style = window.getComputedStyle(el);
      if (style.cursor === "pointer") node.cursor = "pointer";
    }

    if (options.boxes) {
      const r = el.getBoundingClientRect();
      node.box = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }

    for (const child of el.children) {
      const cn = buildNode(child, refCounter, options, depth + 1, maxDepth);
      if (cn) node.children.push(cn);
    }

    if (!node.name && !node.ref && node.children.length === 0) return null;
    if (node.role === "generic" && !node.name && node.children.length === 1) return node.children[0];
    return node;
  }

  globalThis.__baCaptureSnapshot = function (options = {}) {
    const generation = options.generation ?? 0;
    const maxDepth = options.depth != null && options.depth >= 0 ? options.depth : 50;
    const rootEl = options.targetRef
      ? document.querySelector(`[${REF_ATTR}="${options.targetRef}"]`)
      : document.body;

    if (options.targetRef && !rootEl) {
      return { ok: false, error: `Ref ${options.targetRef} not found — capture a new browser_snapshot` };
    }

    const scope = options.targetRef ? rootEl : document.documentElement;
    clearRefs(scope === document.documentElement ? document : scope);
    document.documentElement.setAttribute(GEN_ATTR, String(generation));

    const refCounter = { n: 0 };
    const start = options.targetRef ? rootEl : document.body;
    if (!start) return { ok: false, error: "Page has no body" };

    const children = [];
    if (options.targetRef) {
      const n = buildNode(rootEl, refCounter, options, 0, maxDepth);
      if (n) children.push(n);
    } else {
      for (const child of start.children) {
        const n = buildNode(child, refCounter, options, 0, maxDepth);
        if (!n) continue;
        if (Array.isArray(n)) children.push(...n);
        else children.push(n);
      }
    }

    return {
      ok: true,
      url: location.href,
      title: document.title,
      generation,
      refCount: refCounter.n,
      nodes: children,
    };
  };

  const MODIFIER_MAP = {
    Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
    Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  };

  const BUTTON_MAP = { left: 0, middle: 1, right: 2 };

  function dispatchKey(el, type, mod) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: mod.key,
      code: mod.code,
      keyCode: mod.keyCode,
      bubbles: true,
      cancelable: true,
    }));
  }

  globalThis.__baClickByTarget = function (options = {}) {
    const { target, generation, doubleClick, button, modifiers } = options;
    if (!target) return { ok: false, error: "target is required" };

    let el = null;
    const refMatch = String(target).match(/^(?:f\d+)?(e\d+)$/);
    if (refMatch) {
      const ref = refMatch[1];
      const pageGen = document.documentElement.getAttribute(GEN_ATTR);
      if (generation != null && pageGen !== String(generation)) {
        return { ok: false, error: `Ref ${ref} is stale — capture a new browser_snapshot` };
      }
      el = document.querySelector(`[${REF_ATTR}="${ref}"]`);
      if (!el) {
        return { ok: false, error: `Ref ${ref} not found — capture a new browser_snapshot` };
      }
    } else {
      try {
        el = document.querySelector(target);
      } catch {
        return { ok: false, error: `Invalid selector "${target}"` };
      }
      if (!el) return { ok: false, error: `No element matched "${target}"` };
    }

    el.scrollIntoView({ block: "center", behavior: "instant" });
    const mods = (modifiers || []).map((m) => MODIFIER_MAP[m]).filter(Boolean);
    for (const mod of mods) dispatchKey(el, "keydown", mod);

    const btn = BUTTON_MAP[button || "left"] ?? 0;
    if (doubleClick) {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: btn, view: window }));
    } else {
      el.click();
    }

    for (const mod of [...mods].reverse()) dispatchKey(el, "keyup", mod);
    return { ok: true };
  };
})();
