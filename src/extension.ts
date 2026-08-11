import * as vscode from "vscode";
import type {
  GraphNodeMeasurement,
  GraphRange,
  GraphStatePayload
} from "./model/graphTypes";
import {
  SymbolDependencyGraphViewProvider,
  type GraphTabSnapshot
} from "./providers/symbolDependencyGraphViewProvider";
import { PersistentIndexStatusBar } from "./providers/persistentIndexStatusBar";
import {
  PersistentCallIndex,
  type PersistentIndexStatus
} from "./services/persistentCallIndex";
import { QueryCache } from "./services/queryCache";
import { ReferenceResolver } from "./services/referenceResolver";
import { SymbolResolver } from "./services/symbolResolver";
import { expandReferenceSelection } from "./utils/sourceSelection";

const graphViewId = "symbolDependencyTree.view";

export type GraphPanelSnapshot = GraphTabSnapshot;

export interface SymbolDependencyTreeApi {
  readonly getGraphState: () => GraphStatePayload;
  readonly getLayoutMeasurements: () => readonly GraphNodeMeasurement[];
  readonly getGraphPanels: () => readonly GraphPanelSnapshot[];
  readonly getIndexStatus: () => PersistentIndexStatus;
}

interface OpenReferenceArgument {
  readonly hit?: {
    readonly uri: vscode.Uri;
    readonly range: vscode.Range;
  };
  readonly uri?: string;
  readonly range?: GraphRange;
}

async function openReference(argument: OpenReferenceArgument): Promise<void> {
  try {
    const uri =
      argument.hit?.uri ??
      (argument.uri === undefined ? undefined : vscode.Uri.parse(argument.uri));
    const range =
      argument.hit?.range ??
      (argument.range === undefined
        ? undefined
        : new vscode.Range(
            argument.range.start.line,
            argument.range.start.character,
            argument.range.end.line,
            argument.range.end.character
          ));
    if (uri === undefined || range === undefined) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const expanded = expandReferenceSelection(
      document.getText(),
      document.offsetAt(range.start),
      document.offsetAt(range.end)
    );
    const selection = new vscode.Range(
      document.positionAt(expanded.start),
      document.positionAt(expanded.end)
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: false,
      selection
    });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    void vscode.window.showErrorMessage(`Unable to open reference: ${String(error)}`);
  }
}

export function activate(context: vscode.ExtensionContext): SymbolDependencyTreeApi {
  const output = vscode.window.createOutputChannel("Symbol Dependency Tree", { log: true });
  const cache = new QueryCache();
  const symbolResolver = new SymbolResolver();
  const persistentIndex = new PersistentCallIndex(context.globalStorageUri, output);
  const indexStatusBar = new PersistentIndexStatusBar(persistentIndex.status());
  const referenceResolver = new ReferenceResolver(persistentIndex, cache);
  const graphProvider = new SymbolDependencyGraphViewProvider(
    context.extensionUri,
    referenceResolver,
    cache,
    output
  );
  const graphView = vscode.window.registerWebviewViewProvider(
    graphViewId,
    graphProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  const generateAt = async (
    uri: vscode.Uri,
    position: vscode.Position
  ): Promise<void> => {
    const source = new vscode.CancellationTokenSource();
    try {
      const target = await symbolResolver.resolveAt(uri, position, source.token);
      if (target === undefined) {
        void vscode.window.showInformationMessage("No C/C++ symbol was found at the cursor.");
        return;
      }

      await vscode.commands.executeCommand(`${graphViewId}.focus`);
      await graphProvider.addRoot(target, { uri, position });
    } catch (error) {
      output.error(`Generate failed: ${String(error)}`);
      void vscode.window.showErrorMessage(
        `Unable to generate symbol reference tree: ${String(error)}`
      );
    } finally {
      source.dispose();
    }
  };

  const showCommand = vscode.commands.registerCommand(
    "symbolDependencyTree.show",
    async (): Promise<void> => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        void vscode.window.showInformationMessage(
          "Open a C/C++ source file before generating a call tree."
        );
        return;
      }
      await generateAt(editor.document.uri, editor.selection.active);
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    "symbolDependencyTree.refresh",
    async (): Promise<void> => {
      cache.clear();
      if (graphProvider.origin === undefined) {
        await vscode.commands.executeCommand("symbolDependencyTree.show");
        return;
      }
      await graphProvider.invalidate();
    }
  );

  const clearCommand = vscode.commands.registerCommand(
    "symbolDependencyTree.clear",
    (): void => graphProvider.clear()
  );

  const collapseCommand = vscode.commands.registerCommand(
    "symbolDependencyTree.collapseAll",
    (): void => graphProvider.collapseAll()
  );

  const openCommand = vscode.commands.registerCommand(
    "symbolDependencyTree.openReference",
    openReference
  );

  const rebuildIndexCommand = vscode.commands.registerCommand(
    "symbolDependencyTree.rebuildIndex",
    async (): Promise<void> => {
      const stats = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Building C/C++ call index",
          cancellable: true
        },
        async (_progress, token) => {
          if (
            persistentIndex.status().phase === "loading" ||
            persistentIndex.status().phase === "building"
          ) {
            await persistentIndex.ensureReady(token);
          }
          return persistentIndex.rebuild(token);
        }
      );
      cache.clear();
      await graphProvider.invalidateAll();
      if (persistentIndex.status().phase === "cancelled") {
        void vscode.window.showInformationMessage("Symbol index rebuild cancelled.");
        return;
      }
      void vscode.window.showInformationMessage(
        `Symbol index ready: ${stats.files} files, ${stats.functions} functions, ${stats.calls} references.`
      );
    }
  );

  const indexChanges = persistentIndex.onDidChange(() => {
    cache.clear();
    void graphProvider.invalidateAll().catch((error: unknown) => {
      output.error(`Automatic graph refresh failed: ${String(error)}`);
    });
  });
  const indexStatusChanges = persistentIndex.onDidStatusChange((status) => {
    indexStatusBar.update(status);
  });
  const startupIndexSource = new vscode.CancellationTokenSource();

  const documentChanges = vscode.workspace.onDidChangeTextDocument((event) => {
    cache.clear();
    persistentIndex.scheduleDocumentUpdate(event.document);
  });

  const savedDocuments = vscode.workspace.onDidSaveTextDocument((document) => {
    persistentIndex.scheduleDocumentUpdate(document, 0);
  });

  const closedDocuments = vscode.workspace.onDidCloseTextDocument((document) => {
    persistentIndex.scheduleFileUpdate(document.uri, 0);
  });

  const deletedFiles = vscode.workspace.onDidDeleteFiles((event) => {
    for (const uri of event.files) {
      graphProvider.markDeletedUri(uri);
    }
  });

  context.subscriptions.push(
    output,
    persistentIndex,
    indexStatusBar,
    graphProvider,
    graphView,
    showCommand,
    refreshCommand,
    clearCommand,
    collapseCommand,
    openCommand,
    rebuildIndexCommand,
    indexChanges,
    indexStatusChanges,
    documentChanges,
    savedDocuments,
    closedDocuments,
    deletedFiles
  );

  context.subscriptions.push(startupIndexSource);
  void persistentIndex.ensureReady(startupIndexSource.token).catch((error: unknown) => {
    output.error(`Unable to initialize the persistent call index: ${String(error)}`);
  });

  return {
    getGraphState: () => graphProvider.snapshot(),
    getLayoutMeasurements: () => graphProvider.layoutMeasurements(),
    getGraphPanels: () => graphProvider.graphTabs(),
    getIndexStatus: () => persistentIndex.status()
  };
}

export function deactivate(): void {
  // VS Code disposes all subscriptions registered on the extension context.
}
