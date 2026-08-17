/// <reference lib="webworker" />

// WASM web worker for the browser extension.
// Speaks JSON-RPC over postMessage for vscode-languageclient/browser.
// File I/O is served from a pre-loaded cache populated by the main extension.

// Emscripten module - no typings available.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasmModule: any = null;

// ---- File cache ----
const fileCache = new Map<string, string>();
let workspaceRoot = "/";

function normalizePath(p: string): string {
  // Normalize separators and remove trailing slash
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// ---- JS callback implementations (plain functions, no closures for addFunction) ----

function jsReadFile(pathPtr: number): number {
  if (!wasmModule) {
    return 0;
  }
  const path = wasmModule.UTF8ToString(pathPtr);
  const content = fileCache.get(normalizePath(path));
  if (content === undefined) {
    return 0;
  }
  const len = content.length * 3 + 1;
  const ptr = wasmModule._malloc(len);
  wasmModule.stringToUTF8(content, ptr, len);
  return ptr;
}

function jsFileExists(pathPtr: number): number {
  if (!wasmModule) {
    return 0;
  }
  const path = wasmModule.UTF8ToString(pathPtr);
  return fileCache.has(normalizePath(path)) ? 1 : 0;
}

function jsIsFile(pathPtr: number): number {
  if (!wasmModule) {
    return 0;
  }
  const path = wasmModule.UTF8ToString(pathPtr);
  // A path is a file if it's in the cache and doesn't end with /
  const normalized = normalizePath(path);
  if (fileCache.has(normalized)) {
    return 1;
  }
  // Also check if any cached file starts with this path (it's a directory prefix)
  for (const key of fileCache.keys()) {
    if (key.startsWith(normalized + "/")) {
      return 0;
    }
  }
  return 0;
}

function jsIsDirectory(pathPtr: number): number {
  if (!wasmModule) {
    return 0;
  }
  const path = wasmModule.UTF8ToString(pathPtr);
  const normalized = normalizePath(path);
  if (normalized === workspaceRoot || normalized === "") {
    return 1;
  }
  // A path is a directory if any cached file starts with it
  for (const key of fileCache.keys()) {
    if (key.startsWith(normalized + "/")) {
      return 1;
    }
  }
  return 0;
}

function jsDirList(pathPtr: number): number {
  if (!wasmModule) {
    return 0;
  }
  const dirPath = wasmModule.UTF8ToString(pathPtr);
  const normalized = normalizePath(dirPath);
  const prefix = normalized === "" ? "" : normalized + "/";

  const entries = new Set<string>();
  for (const key of fileCache.keys()) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      const firstSegment = rest.split("/")[0];
      if (firstSegment) {
        entries.add(firstSegment);
      }
    }
  }

  if (entries.size === 0) {
    return 0;
  }

  const result = Array.from(entries).join("\n");
  const len = result.length * 3 + 1;
  const ptr = wasmModule._malloc(len);
  wasmModule.stringToUTF8(result, ptr, len);
  return ptr;
}

function jsGetCurrentDirectory(): number {
  if (!wasmModule) {
    return 0;
  }
  const len = workspaceRoot.length * 3 + 1;
  const ptr = wasmModule._malloc(len);
  wasmModule.stringToUTF8(workspaceRoot, ptr, len);
  return ptr;
}

function jsHttpFetch(_urlPtr: number): number {
  // HTTP fetch is not available synchronously in a web worker.
  // The WASM server will handle this gracefully (returns empty).
  return 0;
}

function jsCommand(_cmdPtr: number): number {
  // Shell commands are not available in browser.
  return 0;
}

// ---- WASM initialization ----

function registerCallbacks(): void {
  // Emscripten addFunction signature: "ii" = (i32) -> i32, "i" = () -> i32
  const readFilePtr = wasmModule.addFunction(jsReadFile, "ii");
  const fileExistsPtr = wasmModule.addFunction(jsFileExists, "ii");
  const isFilePtr = wasmModule.addFunction(jsIsFile, "ii");
  const isDirectoryPtr = wasmModule.addFunction(jsIsDirectory, "ii");
  const dirListPtr = wasmModule.addFunction(jsDirList, "ii");
  const getCurrentDirPtr = wasmModule.addFunction(jsGetCurrentDirectory, "i");
  const httpFetchPtr = wasmModule.addFunction(jsHttpFetch, "ii");
  const commandPtr = wasmModule.addFunction(jsCommand, "ii");

  wasmModule.ccall(
    "lsp_register_callbacks",
    null,
    [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ],
    [
      readFilePtr,
      fileExistsPtr,
      isFilePtr,
      isDirectoryPtr,
      dirListPtr,
      getCurrentDirPtr,
      httpFetchPtr,
      commandPtr,
    ],
  );
}

async function initWasm(): Promise<boolean> {
  try {
    const url = wasmModuleUrl ?? "../bin/server.js";
    // @ts-ignore - dynamic import of Emscripten ES module build artifact
    const moduleLoader = await import(url);
    wasmModule = await moduleLoader.default();

    registerCallbacks();
    wasmModule.lsp_init();

    return true;
  } catch (error) {
    console.error("Failed to initialize WASM module:", error);
    return false;
  }
}

// ---- Message handling ----

function processJsonRpc(jsonMessage: string): string | null {
  const msgPtr = wasmModule._malloc(jsonMessage.length * 3 + 1);
  wasmModule.stringToUTF8(jsonMessage, msgPtr, jsonMessage.length * 3 + 1);
  const responsePtr = wasmModule.lsp_process_message(msgPtr);

  let response: string | null = null;
  if (responsePtr !== 0) {
    response = wasmModule.UTF8ToString(responsePtr);
    wasmModule._free(responsePtr);
  }
  wasmModule._free(msgPtr);

  return response;
}

let initPromise: Promise<boolean> | null = null;
let wasmModuleUrl: string | null = null;

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;

  // Receive the WASM module blob URL from the main extension
  if (data.type === "load-wasm") {
    wasmModuleUrl = data.url;
    return;
  }

  // Handle file loading messages from the main extension
  if (data.type === "load-files") {
    workspaceRoot = data.workspaceRoot ?? "/";

    for (const [path, content] of Object.entries(
      data.files as Record<string, string>,
    )) {
      fileCache.set(normalizePath(path), content);
    }

    // Signal that files are loaded and WASM can now initialize
    if (!initPromise) {
      initPromise = initWasm();
    }
    await initPromise;

    self.postMessage({ type: "files-loaded" });
    return;
  }

  // Handle LSP JSON-RPC messages from vscode-languageclient/browser
  const jsonMessage = typeof data === "string" ? data : JSON.stringify(data);

  // Lazily initialize WASM on first LSP message
  if (!initPromise) {
    initPromise = initWasm();
  }

  const ready = await initPromise;
  if (!ready) {
    try {
      const msg = JSON.parse(jsonMessage);
      if (msg.id !== undefined) {
        self.postMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "WASM module failed to initialize",
            },
          }),
        );
      }
    } catch {
      // unparseable
    }
    return;
  }

  const response = processJsonRpc(jsonMessage);
  if (response) {
    self.postMessage(response);
  }
};
