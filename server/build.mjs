import { build } from "esbuild";
await build({
  entryPoints: [
    "server/index.ts",
    "server/sqlite-worker.ts",
    "server/import.ts",
  ],
  outdir: "dist/server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
