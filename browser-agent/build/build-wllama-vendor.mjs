// Copies @wllama/wllama ESM + wasm into vendor/ for MV3 (no remote code).
// Re-bundling with esbuild would break the embedded Blob worker strings.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(buildDir, "..");
const outDir = path.join(root, "vendor", "wllama");
const require = createRequire(import.meta.url);

const pkgJson = require.resolve("@wllama/wllama/package.json");
const pkgRoot = path.dirname(pkgJson);
const esmDir = path.join(pkgRoot, "esm");

fs.mkdirSync(outDir, { recursive: true });

const copies = [
  ["index.min.js", "wllama.min.js"],
  ["index.js", "wllama.js"],
  [path.join("wasm", "wllama.wasm"), "wllama.wasm"],
];

console.log("[build:wllama] copying @wllama/wllama assets…");
for (const [srcRel, destName] of copies) {
  const src = path.join(esmDir, srcRel);
  const dest = path.join(outDir, destName);
  if (!fs.existsSync(src)) {
    throw new Error(`[build:wllama] missing ${src}`);
  }
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[build:wllama]   ${destName} (${mb} MB)`);
}

console.log(`[build:wllama] done → ${path.relative(root, outDir)}/`);
