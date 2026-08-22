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

patchWorkerDocumentBase(path.join(outDir, "wllama.js"));
patchWorkerDocumentBase(path.join(outDir, "wllama.min.js"));

console.log(`[build:wllama] done → ${path.relative(root, outDir)}/`);

/**
 * @wllama/wllama resolves wasm URLs with `document.baseURI`. That throws
 * `document is not defined` inside wllama-worker.js (Dedicated Worker).
 * Keep the library on the window path, fall back to `self.location.href`.
 */
function patchWorkerDocumentBase(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const replacements = [
    [
      "var absoluteUrl = (relativePath) => new URL(relativePath, document.baseURI).href;",
      'var absoluteUrl = (relativePath) => new URL(relativePath, typeof document !== "undefined" ? document.baseURI : self.location.href).href;',
    ],
    [
      "absoluteUrl=e=>new URL(e,document.baseURI).href",
      'absoluteUrl=e=>new URL(e,"undefined"!=typeof document?document.baseURI:self.location.href).href',
    ],
  ];
  let next = src;
  let hits = 0;
  for (const [from, to] of replacements) {
    if (!next.includes(from)) continue;
    const count = next.split(from).length - 1;
    next = next.split(from).join(to);
    hits += count;
  }
  if (hits === 0) {
    const alreadyPatched =
      next.includes('typeof document !== "undefined" ? document.baseURI : self.location.href') ||
      next.includes('"undefined"!=typeof document?document.baseURI:self.location.href');
    if (alreadyPatched) {
      console.log(`[build:wllama]   ${path.basename(filePath)} already worker-patched`);
      return;
    }
    throw new Error(
      `[build:wllama] ${path.basename(filePath)} is missing document.baseURI; ` +
        `update the Dedicated Worker patch for this @wllama/wllama version.`
    );
  }
  fs.writeFileSync(filePath, next);
  console.log(`[build:wllama]   patched ${path.basename(filePath)} for Dedicated Worker`);
}
