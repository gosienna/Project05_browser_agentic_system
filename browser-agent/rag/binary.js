// Normalize PDF bytes from IndexedDB, structured clone, or base64.

export function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }
  if (typeof data === "string" && data.length) {
    return base64ToArrayBuffer(data);
  }
  if (Array.isArray(data) && data.length) {
    return new Uint8Array(data).buffer;
  }
  if (data && typeof data === "object") {
    const len = data.byteLength ?? data.length;
    if (typeof len === "number" && len > 0) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = data[i] ?? 0;
      return out.buffer;
    }
  }
  return null;
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
