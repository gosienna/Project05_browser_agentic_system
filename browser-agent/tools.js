// Browser tools invoked by the agent loop. Each export takes a single args
// object (always includes tabId when relevant) and returns a plain
// string/object result suitable for feeding back into the chat transcript.

export async function read_page({ tabId, maxChars = 14000 }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: requireTabId(tabId) },
    func: () => document.body?.innerText || "",
  });
  return truncate(result || "", maxChars);
}

export async function get_links({ tabId }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: requireTabId(tabId) },
    func: () =>
      Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 200)
        .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href })),
  });
  return result;
}

export async function list_tabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

export async function open_tab({ url }) {
  const tab = await chrome.tabs.create({ url });
  return { id: tab.id, url: tab.url };
}

export async function navigate({ tabId, url }) {
  await chrome.tabs.update(requireTabId(tabId), { url });
  return { ok: true };
}

export async function click({ tabId, selector }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: requireTabId(tabId) },
    func: (sel) => {
      let el = document.querySelector(sel);
      if (!el) {
        el = Array.from(document.querySelectorAll("a, button, [role='button'], input[type=submit]")).find((n) =>
          n.innerText?.trim().toLowerCase().includes(sel.trim().toLowerCase())
        );
      }
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true };
    },
    args: [selector],
  });
  return result;
}

export async function type_text({ tabId, selector, text }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: requireTabId(tabId) },
    func: (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    args: [selector, text],
  });
  return result;
}

export async function scroll({ tabId, direction = "down" }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: requireTabId(tabId) },
    func: (dir) => {
      window.scrollBy(0, dir === "up" ? -window.innerHeight * 0.9 : window.innerHeight * 0.9);
      return { ok: true, scrollY: window.scrollY };
    },
    args: [direction],
  });
  return result;
}

export async function fetch_url({ url, maxChars = 12000 }) {
  const res = await fetch(url);
  const text = await res.text();
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return truncate(stripped, maxChars);
}

export function wait({ ms = 1000 }) {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), Math.min(ms, 15000)));
}

function requireTabId(tabId) {
  if (tabId == null) throw new Error("This tool requires an active tabId");
  return tabId;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "\n...[truncated]" : str;
}
