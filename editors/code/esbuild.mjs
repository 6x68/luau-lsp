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

// Browser build (web VSCode)
const browserCtx = await esbuild.context({
  entryPoints: ["src/extension.browser.ts"],
  bundle: true,
  format: "esm",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "dist/extension.browser.mjs",
  external: ["vscode", "vscode-languageclient", "vscode-languageclient/*"],
  logLevel: "warning",
  define: {
    "process.env": "{}",
    global: "globalThis",
  },
  plugins: [
    {
      name: "external-wasm-module",
      setup(build) {
        // Mark the Emscripten WASM module as external - it's a build artifact
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

if (watch) {
  await nodeCtx.watch();
  await browserCtx.watch();
} else {
  await nodeCtx.rebuild();
  await nodeCtx.dispose();
  await browserCtx.rebuild();
  await browserCtx.dispose();
}
