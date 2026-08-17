import * as vscode from "vscode";
import * as os from "os";
import {
  Executable,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import * as utils from "./utils";

function resolveNativeBinary(extensionUri: vscode.Uri): string | null {
  const binName = os.platform() === "win32" ? "server.exe" : "server";
  const binPath = vscode.Uri.joinPath(extensionUri, "bin", binName).fsPath;
  return binPath;
}

function resolveWasmModule(extensionUri: vscode.Uri): string | null {
  const wasmPath = vscode.Uri.joinPath(extensionUri, "bin", "server.js").fsPath;
  return wasmPath;
}

export async function createServerOptions(
  context: vscode.ExtensionContext,
  args: string[],
  debugArgs: string[],
  transport: (typeof TransportKind)[keyof typeof TransportKind] = TransportKind.stdio,
): Promise<ServerOptions> {
  const serverConfiguration =
    vscode.workspace.getConfiguration("luau-lsp.server");

  // 1. Check user-configured path
  const serverBinConfig = serverConfiguration.get("path", "").trim();
  if (serverBinConfig !== "") {
    const serverBinUri =
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
        ? utils.resolveUri(
            vscode.workspace.workspaceFolders[0].uri,
            serverBinConfig,
          )
        : vscode.Uri.file(serverBinConfig);

    if (await utils.exists(serverBinUri)) {
      return createNativeServerOptions(
        serverBinUri.fsPath,
        args,
        debugArgs,
        transport,
      );
    } else {
      vscode.window.showWarningMessage(
        `Server binary at path \`${serverBinUri.fsPath}\` does not exist, falling back to bundled binary`,
      );
    }
  }

  // 2. Try native bundled binary
  const nativeBin = resolveNativeBinary(context.extensionUri);
  if (nativeBin && (await utils.exists(vscode.Uri.file(nativeBin)))) {
    return createNativeServerOptions(nativeBin, args, debugArgs, transport);
  }

  // 3. Fall back to WASM
  const wasmModule = resolveWasmModule(context.extensionUri);
  if (wasmModule && (await utils.exists(vscode.Uri.file(wasmModule)))) {
    vscode.window.showInformationMessage(
      "Luau LSP: Using WASM fallback (native binary not available for this platform)",
    );
    return createWasmServerOptions(context, args, debugArgs);
  }

  throw new Error(
    "Could not find Luau Language Server binary. Please set luau-lsp.server.path in settings.",
  );
}

function createNativeServerOptions(
  binPath: string,
  args: string[],
  debugArgs: string[],
  transport: (typeof TransportKind)[keyof typeof TransportKind],
): ServerOptions {
  const run: Executable = {
    command: binPath,
    args,
    transport,
  };

  const debug: Executable = {
    command: process.env["LUAU_LSP_SERVER_PATH"]
      ? vscode.Uri.file(process.env["LUAU_LSP_SERVER_PATH"]).fsPath
      : binPath,
    args: debugArgs,
    transport,
  };

  return { run, debug };
}

function createWasmServerOptions(
  context: vscode.ExtensionContext,
  args: string[],
  debugArgs: string[],
): ServerOptions {
  const wasmPath = vscode.Uri.joinPath(
    context.extensionUri,
    "bin",
    "server.js",
  );

  const run: Executable = {
    command: "node",
    args: [wasmPath.fsPath, ...args],
    transport: TransportKind.stdio,
  };

  const debug: Executable = {
    command: "node",
    args: [wasmPath.fsPath, ...debugArgs],
    transport: TransportKind.stdio,
  };

  return { run, debug };
}
