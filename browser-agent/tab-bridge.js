// Privileged tab APIs for sandbox tools (called from background).

import * as tools from "./tools/browser.js";

export async function handleTabBridge(msg) {
  const op = msg?.op;
  switch (op) {
    case "listTabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      }));
    }
    case "getActiveTab": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return null;
      return { id: tab.id, title: tab.title, url: tab.url, active: tab.active, windowId: tab.windowId };
    }
    case "executeInTab": {
      const tabId = await resolveTabId(msg.tabId);
      const fnSource = msg.fnSource;
      const args = Array.isArray(msg.args) ? msg.args : [];
      if (typeof fnSource !== "string" || !fnSource.trim()) {
        throw new Error("executeInTab requires fnSource string");
      }
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: (source, callArgs) => {
          // Dynamic tool code from the agent system (sandbox → bridge).
          const fn = (0, eval)(`(${source})`);
          return fn(...callArgs);
        },
        args: [fnSource, args],
      });
      return result;
    }
    case "readPage":
      return tools.read_page({ tabId: await resolveTabId(msg.tabId), maxChars: msg.maxChars });
    case "click":
      return tools.click({ tabId: await resolveTabId(msg.tabId), selector: msg.selector });
    case "typeText":
      return tools.type_text({
        tabId: await resolveTabId(msg.tabId),
        selector: msg.selector,
        text: msg.text,
      });
    case "scroll":
      return tools.scroll({ tabId: await resolveTabId(msg.tabId), direction: msg.direction });
    case "navigate":
      return tools.navigate({ tabId: await resolveTabId(msg.tabId), url: msg.url });
    case "captureTab": {
      const tabId = await resolveTabId(msg.tabId);
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId == null) throw new Error(`Tab ${tabId} has no windowId`);
      if (!tab.active) await chrome.tabs.update(tabId, { active: true });
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    }
    default:
      throw new Error(`Unknown tab-bridge op "${op}"`);
  }
}

async function resolveTabId(tabId) {
  if (tabId != null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab.id;
}
