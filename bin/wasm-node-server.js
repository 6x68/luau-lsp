// Node.js wrapper for the Emscripten WASM LSP server.
// Loads the WASM module, registers fs-based I/O callbacks,
// and runs a JSON-RPC loop over stdio.
"use strict";

const fs = require("fs");

// The Emscripten glue code is in server.js (same directory)
const moduleFactory = require("./server.js");

async function main() {
  const wasmModule = await moduleFactory();

  const utf8Encoder = new TextEncoder();

  function toWasmString(str) {
    const bytes = utf8Encoder.encode(str);
    const ptr = wasmModule._malloc(bytes.length + 1);
    wasmModule.HEAPU8.set(bytes, ptr);
    wasmModule.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
  }

  function fromWasmString(ptr) {
    if (ptr === 0) return null;
    return wasmModule.UTF8ToString(ptr);
  }

  // ---- Callback implementations ----

  function jsReadFile(pathPtr) {
    const filePath = wasmModule.UTF8ToString(pathPtr);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return toWasmString(content);
    } catch {
      return 0;
    }
  }

  function jsFileExists(pathPtr) {
    const filePath = wasmModule.UTF8ToString(pathPtr);
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return 1;
    } catch {
      return 0;
    }
  }

  function jsIsFile(pathPtr) {
    const filePath = wasmModule.UTF8ToString(pathPtr);
    try {
      return fs.statSync(filePath).isFile() ? 1 : 0;
    } catch {
      return 0;
    }
  }

  function jsIsDirectory(pathPtr) {
    const filePath = wasmModule.UTF8ToString(pathPtr);
    try {
      return fs.statSync(filePath).isDirectory() ? 1 : 0;
    } catch {
      return 0;
    }
  }

  function jsDirList(pathPtr) {
    const dirPath = wasmModule.UTF8ToString(pathPtr);
    try {
      const entries = fs.readdirSync(dirPath);
      return toWasmString(entries.join("\n"));
    } catch {
      return 0;
    }
  }

  function jsGetCurrentDirectory() {
    return toWasmString(process.cwd());
  }

  function jsHttpFetch(urlPtr) {
    const url = wasmModule.UTF8ToString(urlPtr);
    try {
      const { execSync } = require("child_process");
      const result = execSync(`curl -sL --max-time 15 "${url}"`, {
        encoding: "utf-8",
      });
      return toWasmString(result);
    } catch {
      return 0;
    }
  }

  function jsCommand(cmdPtr) {
    const cmd = wasmModule.UTF8ToString(cmdPtr);
    try {
      const { execSync } = require("child_process");
      const result = execSync(cmd, { encoding: "utf-8", timeout: 30000 });
      return toWasmString(result);
    } catch {
      return 0;
    }
  }

  // Register all callbacks using addFunction (signatures from WASM bindings)
  // ii = (i32) -> i32, i = () -> i32
  const cb = [
    wasmModule.addFunction(jsReadFile, "ii"),
    wasmModule.addFunction(jsFileExists, "ii"),
    wasmModule.addFunction(jsIsFile, "ii"),
    wasmModule.addFunction(jsIsDirectory, "ii"),
    wasmModule.addFunction(jsDirList, "ii"),
    wasmModule.addFunction(jsGetCurrentDirectory, "i"),
    wasmModule.addFunction(jsHttpFetch, "ii"),
    wasmModule.addFunction(jsCommand, "ii"),
  ];

  wasmModule.ccall(
    "lsp_register_callbacks",
    null,
    cb.map(() => "number"),
    cb,
  );

  wasmModule.lsp_init();

  // ---- JSON-RPC over stdio ----

  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setEncoding("utf-8");

  let buffer = "";

  stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      // LSP uses Content-Length header framing
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        buffer = buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.substring(bodyStart, bodyStart + contentLength);
      buffer = buffer.substring(bodyStart + contentLength);

      // Process the JSON-RPC message synchronously
      const msgPtr = toWasmString(body);
      const responsePtr = wasmModule.lsp_process_message(msgPtr);
      const response = fromWasmString(responsePtr);

      if (responsePtr !== 0) wasmModule._free(responsePtr);
      wasmModule._free(msgPtr);

      if (response) {
        const responseBytes = utf8Encoder.encode(response);
        const header = `Content-Length: ${responseBytes.length}\r\n\r\n`;
        stdout.write(header);
        stdout.write(responseBytes);
      }
    }
  });

  stdin.on("end", () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write("WASM server failed to start: " + err.message + "\n");
  process.exit(1);
});
