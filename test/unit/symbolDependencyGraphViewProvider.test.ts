import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Position {
    public constructor(public readonly line: number, public readonly character: number) {}
  }
  class Range {
    public constructor(public readonly start: Position, public readonly end: Position) {}
  }
  class Uri {
    public constructor(private readonly value: string) {}
    public static file(path: string): Uri { return new Uri(`file://${path}`); }
    public static parse(value: string): Uri { return new Uri(value); }
    public toString(): string { return this.value; }
  }
  class CancellationTokenSource {
    private cancelled = false;
    public readonly token: { readonly isCancellationRequested: boolean };
    public constructor() {
      const cancelled = (): boolean => this.cancelled;
      this.token = { get isCancellationRequested(): boolean { return cancelled(); } };
    }
    public cancel(): void { this.cancelled = true; }
    public dispose(): void {}
  }
  return {
    Position,
    Range,
    Uri,
    CancellationTokenSource,
    SymbolKind: { Function: 11 },
    workspace: {
      asRelativePath: (uri: Uri): string => uri.toString(),
      openTextDocument: vi.fn()
    },
    window: { showTextDocument: vi.fn(), showErrorMessage: vi.fn() },
    TextEditorRevealType: { InCenterIfOutsideViewport: 0 }
  };
});

import * as vscode from "vscode";
import type {
  RootOrigin,
  ScopeReference,
  TargetSymbol
} from "../../src/model/symbolTypes";
import { SymbolDependencyGraphViewProvider } from "../../src/providers/symbolDependencyGraphViewProvider";
import { QueryCache } from "../../src/services/queryCache";
import type { ReferenceResolver } from "../../src/services/referenceResolver";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  if (resolve === undefined) { throw new Error("Deferred resolver was not initialized"); }
  return { promise, resolve };
}

function rootTarget(): TargetSymbol {
  const uri = vscode.Uri.file("/root.cpp");
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 4));
  return {
    id: "root",
    name: "root",
    kind: vscode.SymbolKind.Function,
    uri,
    range,
    selectionRange: range,
    definition: { uri, range }
  } as TargetSymbol;
}

function rootOrigin(): RootOrigin {
  return { uri: vscode.Uri.file("/root.cpp"), position: new vscode.Position(0, 0) };
}

function rootLoading(provider: SymbolDependencyGraphViewProvider): boolean | undefined {
  return provider.snapshot().nodes.find((node) => node.root)?.loading;
}

function scope(id: string): ScopeReference {
  const uri = vscode.Uri.file(`/${id}.cpp`);
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 4));
  return {
    id,
    name: id,
    kind: vscode.SymbolKind.Function,
    uri,
    range,
    selectionRange: range,
    references: [{ uri, range }],
    source: "index"
  } as ScopeReference;
}

function document(): vscode.TextDocument {
  return { lineAt: () => ({ text: "call();" }) } as unknown as vscode.TextDocument;
}

function webviewView(postMessage: ReturnType<typeof vi.fn>): vscode.WebviewView {
  return {
    onDidDispose: vi.fn(),
    webview: {
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      cspSource: "test-csp",
      html: "",
      onDidReceiveMessage: vi.fn(),
      options: {},
      postMessage
    }
  } as unknown as vscode.WebviewView;
}

describe("SymbolDependencyGraphViewProvider async ownership", () => {
  it("keeps a renewed generation loading when the stale query settles", async () => {
    const resolve = vi.fn().mockResolvedValueOnce({ scopes: [] });
    const provider = new SymbolDependencyGraphViewProvider(
      vscode.Uri.file("/extension"),
      { resolve } as unknown as ReferenceResolver,
      new QueryCache(),
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    );
    await provider.addRoot(rootTarget(), rootOrigin());
    const stale = deferred<{ readonly scopes: readonly [] }>();
    const current = deferred<{ readonly scopes: readonly [] }>();
    const staleEntered = deferred<void>();
    const currentEntered = deferred<void>();
    resolve.mockImplementationOnce(() => { staleEntered.resolve(); return stale.promise; });
    resolve.mockImplementationOnce(() => { currentEntered.resolve(); return current.promise; });

    const staleInvalidation = provider.invalidate();
    await staleEntered.promise;
    const currentInvalidation = provider.invalidate();
    await currentEntered.promise;
    stale.resolve({ scopes: [] });
    await staleInvalidation;

    expect(rootLoading(provider)).toBe(true);
    current.resolve({ scopes: [] });
    await currentInvalidation;
    expect(rootLoading(provider)).toBe(false);
    provider.dispose();
  });

  it("G1: ignores OLD reference payload completion after a renewed NEW child is published", async () => {
    const oldDocument = deferred<vscode.TextDocument>();
    const oldDocumentEntered = deferred<void>();
    const openTextDocument = vi.mocked(vscode.workspace.openTextDocument);
    openTextDocument.mockImplementationOnce(() => {
      oldDocumentEntered.resolve();
      return oldDocument.promise;
    });
    openTextDocument.mockResolvedValue(document());
    const resolve = vi.fn()
      .mockResolvedValueOnce({ scopes: [] })
      .mockResolvedValueOnce({ scopes: [scope("old")] })
      .mockResolvedValueOnce({ scopes: [scope("new")] });
    const postMessage = vi.fn().mockResolvedValue(true);
    const provider = new SymbolDependencyGraphViewProvider(
      vscode.Uri.file("/extension"),
      { resolve } as unknown as ReferenceResolver,
      new QueryCache(),
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    );

    try {
      provider.resolveWebviewView(webviewView(postMessage));
      await provider.addRoot(rootTarget(), rootOrigin());
      const oldInvalidation = provider.invalidate();
      await oldDocumentEntered.promise;
      const newInvalidation = provider.invalidate();
      await newInvalidation;

      const snapshot = provider.snapshot();
      const root = snapshot.nodes.find((node) => node.root);
      const newNode = snapshot.nodes.find((node) => node.label === "new");
      expect(newNode).toBeDefined();
      expect(snapshot.nodes.some((node) => node.label === "old")).toBe(false);
      expect(root?.childIds).toContain(newNode?.id);
      expect(root?.loading).toBe(false);
      const snapshotCopy = structuredClone(snapshot);
      const postCount = postMessage.mock.calls.length;

      oldDocument.resolve(document());
      await oldInvalidation;

      expect(provider.snapshot()).toEqual(snapshotCopy);
      expect(provider.snapshot().nodes.some((node) => node.label === "old")).toBe(false);
      expect(postMessage).toHaveBeenCalledTimes(postCount);
    } finally {
      provider.dispose();
    }
  });
});
