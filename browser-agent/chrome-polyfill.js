// Module Dedicated Workers spawned from extension pages often lack `chrome.*`.
 // Provide a minimal shim so engine.js / model-cache can resolve URLs and notify
 // the parent offscreen document (which owns the real chrome.runtime).

if (typeof globalThis.chrome === "undefined" || !globalThis.chrome?.runtime?.getURL) {
  const origin = self.location.origin; // chrome-extension://<id>

  globalThis.chrome = {
    runtime: {
      getURL(path) {
        return `${origin}/${String(path).replace(/^\//, "")}`;
      },
      sendMessage(message) {
        // Parent offscreen.js forwards this onto chrome.runtime.
        self.postMessage({ type: "chrome.runtime.sendMessage", message });
        return Promise.resolve();
      },
      // Present for feature detects in some libraries.
      id: origin.replace("chrome-extension://", ""),
    },
  };

  console.log("[onnx] chrome.* shim installed in ort-worker");
}
