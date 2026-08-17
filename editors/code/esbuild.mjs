import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Node.js build (desktop)
const nodeCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "warning",
  plugins: [
    {
      name: "esbuild-problem-matcher",
      setup(build) {
        build.onStart(() => {
          console.log("[watch] build started");
        });
        build.onEnd((result) => {
          for (const { text, location } of result.errors) {
            console.error(
              `✘ [ERROR] ${text}`,
              location
                ? `${location.file}:${location.line}:${location.column}:`
                : "",
            );
          }
          console.log("[watch] build finished");
        });
      },
    },
  ],
});

// Browser build (web VSCode) - extension entry point
const browserCtx = await esbuild.context({
  entryPoints: ["src/extension.browser.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "dist/extension.browser.js",
  external: ["vscode"],
  logLevel: "warning",
  define: {
    "process.env": "{}",
    global: "globalThis",
  },
  plugins: [
    {
      name: "external-wasm-module",
      setup(build) {
        build.onResolve({ filter: /\.\.\/bin\/server/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
    {
      name: "esbuild-problem-matcher-browser",
      setup(build) {
        build.onStart(() => {
          console.log("[watch] browser build started");
        });
        build.onEnd((result) => {
          for (const { text, location } of result.errors) {
            console.error(
              `✘ [ERROR] ${text}`,
              location
                ? `${location.file}:${location.line}:${location.column}:`
                : "",
            );
          }
          console.log("[watch] browser build finished");
        });
      },
    },
  ],
});

// Browser build - WASM worker (separate entry, runs in a Web Worker)
const workerCtx = await esbuild.context({
  entryPoints: ["src/wasmWorker.ts"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "dist/wasmWorker.js",
  external: [],
  logLevel: "warning",
  define: {
    "process.env": "{}",
    global: "globalThis",
  },
  plugins: [
    {
      name: "external-wasm-module-worker",
      setup(build) {
        build.onResolve({ filter: /\.\.\/bin\/server/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
});

if (watch) {
  await nodeCtx.watch();
  await browserCtx.watch();
  await workerCtx.watch();
} else {
  await nodeCtx.rebuild();
  await nodeCtx.dispose();
  await browserCtx.rebuild();
  await browserCtx.dispose();
  await workerCtx.rebuild();
  await workerCtx.dispose();
}
