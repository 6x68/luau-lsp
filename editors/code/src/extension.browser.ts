import * as vscode from "vscode";
import {
  CloseAction,
  CloseHandlerResult,
  ErrorAction,
  ErrorHandler,
  ErrorHandlerResult,
  LanguageClient,
  LanguageClientOptions,
  Message,
} from "vscode-languageclient/browser";

import { onTypeFormattingMiddleware } from "./onTypeFormattingMiddleware";

import { registerComputeBytecode } from "./bytecode";

export type PlatformContext = { client: LanguageClient | undefined };

let client: LanguageClient | undefined = undefined;
const clientDisposables: vscode.Disposable[] = [];

const CURRENT_FFLAGS =
  "https://clientsettingscdn.roblox.com/v1/settings/application?applicationName=PCStudioApp";
const FFLAG_KINDS = ["FFlag", "FInt", "DFFlag", "DFInt"];

type FFlags = Record<string, string>;
type FFlagsEndpoint = { applicationSettings: FFlags };

const getFFlags = async (): Promise<FFlags | undefined> => {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Luau: Fetching FFlags",
      cancellable: false,
    },
    () =>
      fetch(CURRENT_FFLAGS)
        .then((r) => r.json() as Promise<FFlagsEndpoint>)
        .then((r) => r.applicationSettings),
  );
};

const isAlphanumericUnderscore = (str: string) => {
  return /^[a-zA-Z0-9_]+$/.test(str);
};

class ClientErrorHandler implements ErrorHandler {
  private readonly restarts: number[];

  constructor(private maxRestartCount: number) {
    this.restarts = [];
  }

  public error(
    _error: Error,
    _message: Message,
    count: number,
  ): ErrorHandlerResult {
    if (count && count <= 3) {
      return { action: ErrorAction.Continue };
    }
    return { action: ErrorAction.Shutdown };
  }

  public closed(): CloseHandlerResult {
    this.restarts.push(Date.now());
    if (this.restarts.length <= this.maxRestartCount) {
      return { action: CloseAction.Restart };
    } else {
      const diff = this.restarts[this.restarts.length - 1] - this.restarts[0];
      if (diff <= 3 * 60 * 1000) {
        return {
          action: CloseAction.DoNotRestart,
          message: `The Luau Language server crashed ${this.maxRestartCount + 1} times in the last 3 minutes. The server will not be restarted.`,
        };
      } else {
        this.restarts.shift();
        return { action: CloseAction.Restart };
      }
    }
  }
}

const startLanguageServer = async (context: vscode.ExtensionContext) => {
  for (const disposable of clientDisposables) {
    disposable.dispose();
  }
  clientDisposables.splice(0, clientDisposables.length);
  if (client) {
    await client.stop();
  }

  console.log("Starting Luau Language Server (WASM)");

  // Handle FFlags
  const fflags: FFlags = {};
  const fflagsConfig = vscode.workspace.getConfiguration("luau-lsp.fflags");

  if (!fflagsConfig.get<boolean>("enableByDefault")) {
    fflags["no-flags-enabled"] = "true";
  }

  if (fflagsConfig.get<boolean>("sync")) {
    try {
      const currentFlags = await getFFlags();
      if (currentFlags) {
        for (const [name, value] of Object.entries(currentFlags)) {
          for (const kind of FFLAG_KINDS) {
            if (name.startsWith(`${kind}Luau`)) {
              fflags[name.substring(kind.length)] = value;
            }
          }
        }
      }
    } catch (err) {
      vscode.window.showWarningMessage(
        "Failed to fetch current Luau FFlags: " + err,
      );
    }
  }

  if (fflagsConfig.get<boolean>("enableNewSolver")) {
    fflags["LuauSolverV2"] = "true";
  }

  const overridenFFlags = fflagsConfig.get<FFlags>("override");
  if (overridenFFlags) {
    for (let [name, value] of Object.entries(overridenFFlags)) {
      if (!isAlphanumericUnderscore(name)) {
        vscode.window.showWarningMessage(
          `Invalid FFlag name: '${name}'. It can only contain alphanumeric characters`,
        );
      }

      name = name.trim();
      value = value.trim();

      for (const kind of FFLAG_KINDS) {
        if (name.startsWith(`${kind}`)) {
          name = name.substring(kind.length);
        }
      }

      if (name.length > 0 && value.length > 0) {
        fflags[name] = value;
      }
    }
  }

  // Create the WASM web worker
  const workerScriptUri = vscode.Uri.joinPath(context.extensionUri, "dist", "wasmWorker.js");
  const worker = new Worker(workerScriptUri.toString());

  // Read the WASM module and pass it as a blob URL to the worker.
  // The worker can't resolve relative paths under vscode-web:// scheme,
  // so we provide the module content directly.
  const wasmModuleUri = vscode.Uri.joinPath(context.extensionUri, "bin", "server.js");
  const wasmBytes = await vscode.workspace.fs.readFile(wasmModuleUri);
  const wasmBlob = new Blob([wasmBytes], { type: "application/javascript" });
  const wasmBlobUrl = URL.createObjectURL(wasmBlob);

  // Pre-load workspace files into the worker's file cache before LSP starts.
  // The WASM server needs synchronous file I/O for module resolution and .luaurc,
  // so we read everything upfront and send it to the worker.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Luau: Loading workspace files",
      cancellable: false,
    },
    async () => {
      const files: Record<string, string> = {};
      const decoder = new TextDecoder();

      // Find all Luau/Lua source files and definition files
      const filePatterns = [
        "**/*.luau",
        "**/*.lua",
        "**/*.d.luau",
        "**/.luaurc",
      ];

      for (const pattern of filePatterns) {
        const uris = await vscode.workspace.findFiles(pattern);
        for (const uri of uris) {
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            files[uri.fsPath] = decoder.decode(bytes);
          } catch {
            // Skip files that can't be read
          }
        }
      }

      // Read any configured type definition files
      const typesConfig = vscode.workspace.getConfiguration("luau-lsp.types");
      const definitionFiles =
        typesConfig.get<{ [pkg: string]: string } | string[]>(
          "definitionFiles",
        ) ?? {};

      const entries = Array.isArray(definitionFiles)
        ? definitionFiles.map((p, i) => [`roblox${i}`, p])
        : Object.entries(definitionFiles);

      for (const [, defPath] of entries) {
        if (defPath.startsWith("http://") || defPath.startsWith("https://")) {
          continue;
        }
        try {
          const uri = vscode.Uri.file(defPath);
          const bytes = await vscode.workspace.fs.readFile(uri);
          files[uri.fsPath] = decoder.decode(bytes);
        } catch {
          // Skip missing definition files
        }
      }

      const workspaceRoot =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "/";

      // Send WASM module URL to worker first
  worker.postMessage({ type: "load-wasm", url: wasmBlobUrl });

  // Send files to worker and wait for confirmation
      const filesLoaded = new Promise<void>((resolve) => {
        const handler = (event: MessageEvent) => {
          if (event.data?.type === "files-loaded") {
            worker.removeEventListener("message", handler);
            resolve();
          }
        };
        worker.addEventListener("message", handler);
      });

      worker.postMessage({
        type: "load-files",
        workspaceRoot,
        files,
      });

      await filesLoaded;
    },
  );

  // The browser LanguageClient accepts a Worker directly as serverOptions.
  // It wraps it with BrowserMessageReader/Writer for JSON-RPC over postMessage.
  const serverOptions = worker;

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: "lua", scheme: "file" },
      { language: "luau", scheme: "file" },
      { language: "lua", scheme: "untitled" },
      { language: "luau", scheme: "untitled" },
    ],
    diagnosticPullOptions: {
      onChange: vscode.workspace
        .getConfiguration("luau-lsp.diagnostics")
        .get("pullOnChange", true),
      onSave: vscode.workspace
        .getConfiguration("luau-lsp.diagnostics")
        .get("pullOnSave", true),
    },
    initializationOptions: {
      fflags,
    },
    markdown: {
      supportHtml: true,
    },
    errorHandler: new ClientErrorHandler(4),
    middleware: {
      provideOnTypeFormattingEdits: onTypeFormattingMiddleware,
    },
  };

  client = new LanguageClient(
    "luau",
    "Luau Language Server (WASM)",
    clientOptions,
    serverOptions,
  );

  // Register commands
  client.onNotification(
    "$/command",
    (params: { command: string; data: unknown }) => {
      vscode.commands.executeCommand(params.command, params.data);
    },
  );

  clientDisposables.push(
    vscode.commands.registerCommand(
      "luau-lsp.rename",
      async (
        uriString: string,
        position: { line: number; character: number },
      ) => {
        const uri = vscode.Uri.parse(uriString);
        const pos = new vscode.Position(position.line, position.character);
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === uri.toString()) {
          editor.selection = new vscode.Selection(pos, pos);
          await vscode.commands.executeCommand("editor.action.rename");
        }
      },
    ),
  );

  clientDisposables.push(...registerComputeBytecode(context, client));
  clientDisposables.push(
    vscode.commands.registerCommand("luau-lsp.openWalkthrough", () => {
      return vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        "JohnnyMorganz.luau-lsp#getting-started",
        false,
      );
    }),
  );

  console.log("LSP Setup (WASM)");
  await client.start();
};

export async function activate(context: vscode.ExtensionContext) {
  console.log("Luau LSP activated (browser)");

  context.subscriptions.push(
    vscode.commands.registerCommand("luau-lsp.reloadServer", async () => {
      vscode.window.showInformationMessage("Reloading Language Server");
      await startLanguageServer(context);
    }),
    vscode.commands.registerCommand("luau-lsp.flushTimeTrace", async () => {
      if (client) {
        client.sendNotification("$/flushTimeTrace");
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("luau-lsp.server") ||
        e.affectsConfiguration("luau-lsp.fflags") ||
        e.affectsConfiguration("luau-lsp.completion.enableFragmentAutocomplete")
      ) {
        vscode.window
          .showInformationMessage(
            "Luau LSP configuration has changed, reload server for this to take effect.",
            "Reload Language Server",
          )
          .then((command) => {
            if (command === "Reload Language Server") {
              vscode.commands.executeCommand("luau-lsp.reloadServer");
            }
          });
      }
    }),
  );

  await startLanguageServer(context);
}

export async function deactivate() {
  return Promise.allSettled([client?.stop()]);
}
