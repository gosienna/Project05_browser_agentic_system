// Bundle pdfjs-dist for in-extension PDF parse + viewer.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(buildDir, "..");
const outDir = path.join(root, "vendor", "pdf");

fs.mkdirSync(outDir, { recursive: true });

const entry = `
export * from "pdfjs-dist/legacy/build/pdf.mjs";
`;

const entryPath = path.join(buildDir, "pdf-vendor-entry.mjs");
fs.writeFileSync(entryPath, entry);

console.log("[build:pdf] bundling pdfjs-dist…");
await build({
  entryPoints: [entryPath],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: path.join(outDir, "pdf.min.mjs"),
  minify: true,
  sourcemap: false,
  logLevel: "info",
});

// Copy worker for optional worker mode (viewer may use disableWorker in SW).
const workerSrc = path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
if (fs.existsSync(workerSrc)) {
  fs.copyFileSync(workerSrc, path.join(outDir, "pdf.worker.mjs"));
  console.log("[build:pdf] copied pdf.worker.mjs");
}

console.log(`[build:pdf] done → ${path.relative(root, outDir)}/`);
