import * as vscode from "vscode";

export interface WasmCallbacks {
  readFile(path: string): string | null;
  fileExists(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  dirList(path: string): string | null;
  getCurrentDirectory(): string | null;
  httpFetch(url: string): string | null;
  command(cmd: string): string | null;
}

export function createNodeCallbacks(): WasmCallbacks {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path") as typeof import("path");

  return {
    readFile(filePath: string): string | null {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    fileExists(filePath: string): boolean {
      return fs.existsSync(filePath);
    },
    isFile(filePath: string): boolean {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    },
    isDirectory(filePath: string): boolean {
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    },
    dirList(dirPath: string): string | null {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map((e: { name: string }) => e.name).join("\n");
      } catch {
        return null;
      }
    },
    getCurrentDirectory(): string | null {
      return process.cwd();
    },
    httpFetch(url: string): string | null {
      // HTTP fetch is handled asynchronously via postMessage in the worker
      // This synchronous fallback is only for non-worker contexts
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execSync } =
          require("child_process") as typeof import("child_process");
        return execSync(`curl -s "${url}"`, {
          encoding: "utf-8",
          timeout: 10000,
        });
      } catch {
        return null;
      }
    },
    command(cmd: string): string | null {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execSync } =
          require("child_process") as typeof import("child_process");
        return execSync(cmd, { encoding: "utf-8", timeout: 30000 });
      } catch {
        return null;
      }
    },
  };
}

export function createBrowserCallbacks(): WasmCallbacks {
  return {
    readFile(_path: string): string | null {
      // In browser, file reads are proxied via postMessage to the main thread
      // This is a placeholder - actual implementation uses async messaging
      return null;
    },
    fileExists(_path: string): boolean {
      return false;
    },
    isFile(_path: string): boolean {
      return false;
    },
    isDirectory(_path: string): boolean {
      return false;
    },
    dirList(_path: string): string | null {
      return null;
    },
    getCurrentDirectory(): string | null {
      return "/";
    },
    httpFetch(_url: string): string | null {
      return null;
    },
    command(_cmd: string): string | null {
      return null;
    },
  };
}
