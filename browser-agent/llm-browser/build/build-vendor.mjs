// Bundles @huggingface/transformers (ESM) plus the onnxruntime-web wasm
// binaries it needs at runtime into llm-browser/vendor/transformers/, so the extension
// ships zero remote code per MV3 CSP (plan §4.2).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(buildDir, "..");
const extRoot = path.join(root, "..");
const outDir = path.join(root, "vendor", "transformers");

fs.mkdirSync(outDir, { recursive: true });

console.log("[build:vendor] bundling @huggingface/transformers…");
await build({
  entryPoints: [path.join(buildDir, "vendor-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: path.join(outDir, "transformers.min.js"),
  minify: true,
  sourcemap: false,
  logLevel: "info",
  // onnxruntime-web dynamically imports its own wasm binaries at runtime by
  // path; we copy those separately below rather than let esbuild inline them.
  loader: { ".wasm": "copy" },
  external: ["node:*"],
});

console.log("[build:vendor] copying onnxruntime-web runtime files…");
const nodeModules = path.join(extRoot, "node_modules");
const wasmSourceDirs = [
  path.join(nodeModules, "onnxruntime-web", "dist"),
  path.join(nodeModules, "@huggingface", "transformers", "node_modules", "onnxruntime-web", "dist"),
];

let copied = 0;
for (const dir of wasmSourceDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    if (/\.(wasm|mjs)$/.test(file) && /ort-/.test(file)) {
      fs.copyFileSync(path.join(dir, file), path.join(outDir, file));
      copied++;
    }
  }
}

if (copied === 0) {
  console.warn(
    "[build:vendor] WARNING: no onnxruntime-web .wasm files found. " +
      "Run `npm install` first, or check the installed onnxruntime-web version's dist/ layout."
  );
} else {
  console.log(`[build:vendor] copied ${copied} onnxruntime-web runtime file(s).`);
}

console.log(`[build:vendor] done → ${path.relative(root, outDir)}/`);
