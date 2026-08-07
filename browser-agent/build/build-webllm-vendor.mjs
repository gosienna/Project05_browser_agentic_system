// Bundles @mlc-ai/web-llm for the extension worker (MV3 CSP: no remote code).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(buildDir, "..");
const outDir = path.join(root, "vendor", "webllm");

fs.mkdirSync(outDir, { recursive: true });

console.log("[build:webllm] bundling @mlc-ai/web-llm…");
await build({
  entryPoints: [path.join(buildDir, "webllm-vendor-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: path.join(outDir, "webllm.min.js"),
  minify: true,
  sourcemap: false,
  logLevel: "info",
  loader: { ".wasm": "copy" },
  external: ["node:*"],
});

console.log(`[build:webllm] done → ${path.relative(root, outDir)}/`);
