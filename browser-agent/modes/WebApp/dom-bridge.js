// Route browser DOM tools into the WebApp sandbox iframe (extension pages block executeScript).

export const WEBAPP_HOST_PAGE = "modes/WebApp/system-host.html";

export function isWebAppHostUrl(url = "") {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "chrome-extension:") return false;
    const path = parsed.pathname.replace(/^\//, "");
    return path === WEBAPP_HOST_PAGE || path.endsWith(`/${WEBAPP_HOST_PAGE}`);
  } catch {
    return false;
  }
}

export async function isWebAppHostTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return isWebAppHostUrl(tab.url || tab.pendingUrl || "");
  } catch {
    return false;
  }
}

export function runInWebAppSandbox(tabId, funcSource, args = [], { world = "ISOLATED" } = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "webapp-dom-exec", funcSource, args, world },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) reject(new Error(response.error));
        else resolve(response?.result);
      }
    );
  });
}
