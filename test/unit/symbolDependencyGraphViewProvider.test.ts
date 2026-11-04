import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Position {
    public constructor(public readonly line: number, public readonly character: number) {}
  }
  class Range {
    public constructor(public readonly start: Position, public readonly end: Position) {}
  }
  class Location {
    public constructor(public readonly uri: unknown, public readonly range: Range) {}
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
    Location,
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
import * as textScanner from "../../src/utils/textScanner";

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
  it("refreshes inactive trees only when they become active", async () => {
    const resolve = vi.fn().mockResolvedValue({ scopes: [] });
    const provider = new SymbolDependencyGraphViewProvider(
      vscode.Uri.file("/extension"),
      { resolve } as unknown as ReferenceResolver,
      new QueryCache(),
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    );
    try {
      await provider.addRoot(rootTarget(), rootOrigin());
      await provider.addRoot({ ...rootTarget(), id: "second", name: "second" }, rootOrigin());
      expect(resolve).toHaveBeenCalledTimes(2);
      await provider.invalidateAll();
      expect(resolve).toHaveBeenCalledTimes(3);
      await provider.addRoot(rootTarget(), rootOrigin());
      expect(resolve).toHaveBeenCalledTimes(4);
    } finally { provider.dispose(); }
  });

  it("reads and masks each source once per expansion across caller groups", async () => {
    const mask = vi.spyOn(textScanner, "maskCppCommentsAndLiterals");
    const getText = vi.fn(() => "call();\n");
    const sharedDocument = {
      getText,
      lineAt: () => ({ text: "call();" }),
      offsetAt: (position: vscode.Position): number => position.character,
      positionAt: (offset: number): vscode.Position => new vscode.Position(0, offset)
    } as unknown as vscode.TextDocument;
    const shared = scope("shared");
    const callers = ["first", "second"].map((name) => ({
      ...scope(name),
      references: [shared.references[0]!, shared.references[0]!]
    }));
    const open = vi.mocked(vscode.workspace.openTextDocument);
    open.mockReset();
    open.mockResolvedValue(sharedDocument);
    const provider = new SymbolDependencyGraphViewProvider(
      vscode.Uri.file("/extension"),
      { resolve: vi.fn().mockResolvedValue({ scopes: callers }) } as unknown as ReferenceResolver,
      new QueryCache(),
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    );
    try {
      await provider.addRoot(rootTarget(), rootOrigin());
      expect(open).toHaveBeenCalledTimes(1);
      expect(getText).toHaveBeenCalledTimes(1);
      expect(mask).toHaveBeenCalledTimes(1);
      const references = provider.snapshot().nodes.flatMap((node) => node.references);
      expect(references).toHaveLength(4);
      expect(references.every((reference) => reference.preview === "call();")).toBe(true);

      await provider.invalidate();
      expect(getText).toHaveBeenCalledTimes(2);
      expect(mask).toHaveBeenCalledTimes(2);
    } finally {
      provider.dispose();
      mask.mockRestore();
    }
  });

  it("refreshes shared source once when its version changes during expansion", async () => {
    const mask = vi.spyOn(textScanner, "maskCppCommentsAndLiterals");
    let source = "call(\n  1\n);\n";
    const getText = vi.fn(() => source);
    const sharedDocument = {
      version: 1,
      getText,
      lineAt: (line: number): { text: string } => ({ text: source.split("\n")[line]! }),
      offsetAt: (position: vscode.Position): number =>
        source.split("\n").slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) +
        position.character,
      positionAt: (offset: number): vscode.Position => {
        const lines = source.slice(0, offset).split("\n");
        return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
      }
    };
    const shared = scope("shared");
    const blocked = deferred<vscode.TextDocument>();
    const blockedEntered = deferred<void>();
    const open = vi.mocked(vscode.workspace.openTextDocument);
    open.mockReset();
    open.mockImplementation((uri) => {
      if (uri.toString() === shared.uri.toString()) {
        return Promise.resolve(sharedDocument as unknown as vscode.TextDocument);
      }
      blockedEntered.resolve();
      return blocked.promise;
    });
    const callers = [
      { ...scope("before"), references: shared.references },
      scope("blocked"),
      { ...scope("after"), references: [shared.references[0]!, shared.references[0]!] }
    ];
    const provider = new SymbolDependencyGraphViewProvider(
      vscode.Uri.file("/extension"),
      { resolve: vi.fn().mockResolvedValue({ scopes: callers }) } as unknown as ReferenceResolver,
      new QueryCache(),
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    );
    try {
      const expansion = provider.addRoot(rootTarget(), rootOrigin());
      await blockedEntered.promise;
      source = "call(\n  1,\n  2\n);\n";
      sharedDocument.version += 1;
      blocked.resolve({
        version: 1,
        getText: () => "",
        lineAt: () => ({ text: "" }),
        offsetAt: () => 0,
        positionAt: () => new vscode.Position(0, 0)
      } as unknown as vscode.TextDocument);
      await expansion;

      const references = provider.snapshot().nodes.find((node) => node.label === "after")!.references;
      expect(references).toHaveLength(2);
      expect(references.map((reference) => reference.range.end)).toEqual([
        { line: 3, character: 2 },
        { line: 3, character: 2 }
      ]);
      expect(open).toHaveBeenCalledTimes(2);
      expect(getText).toHaveBeenCalledTimes(2);
      expect(mask).toHaveBeenCalledTimes(3);
    } finally {
      provider.dispose();
      mask.mockRestore();
    }
  });

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

describe("SymbolDependencyGraphViewProvider root location", () => {
  function graphProvider(resolve: ReturnType<typeof vi.fn>): SymbolDependencyGraphViewProvider {
    return new SymbolDependencyGraphViewProvider(
      vscode.Uri.file("/extension"),
      { resolve } as unknown as ReferenceResolver,
      new QueryCache(),
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel
    );
  }

  function at(line: number): vscode.Range {
    return new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 4));
  }

  it("moves the root with edits of its file and queries from there", async () => {
    const resolve = vi.fn().mockResolvedValue({ scopes: [] });
    const provider = graphProvider(resolve);
    try {
      await provider.addRoot(rootTarget(), rootOrigin());
      const insertTwoLines = [{ range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)), text: "// a\n// b\n" }];
      provider.trackEdits(vscode.Uri.file("/other.cpp"), insertTwoLines);
      expect(provider.rootJumpTarget()?.line).toBe(1);

      provider.trackEdits(vscode.Uri.file("/root.cpp"), insertTwoLines);
      expect(provider.rootJumpTarget()).toEqual({ uri: "file:///root.cpp", line: 3 });
      await provider.invalidate();
      const queried = resolve.mock.lastCall?.[0] as TargetSymbol;
      expect(queried.definition?.range.start.line).toBe(2);
      expect(queried.selectionRange.start.line).toBe(2);
    } finally { provider.dispose(); }
  });

  it("takes the queried definition when the stored one no longer names the root", async () => {
    const open = vi.mocked(vscode.workspace.openTextDocument);
    open.mockReset();
    open.mockResolvedValue({ getText: () => "// b" } as unknown as vscode.TextDocument);
    const resolve = vi.fn().mockResolvedValue({ scopes: [], definition: { uri: vscode.Uri.file("/root.cpp"), range: at(4) } });
    const provider = graphProvider(resolve);
    try {
      await provider.addRoot(rootTarget(), rootOrigin());
      expect(provider.rootJumpTarget()).toEqual({ uri: "file:///root.cpp", line: 5 });
    } finally { provider.dispose(); }
  });

  it("keeps a stored definition that still names the root", async () => {
    const open = vi.mocked(vscode.workspace.openTextDocument);
    open.mockReset();
    open.mockResolvedValue({ getText: () => "root" } as unknown as vscode.TextDocument);
    const resolve = vi.fn().mockResolvedValue({ scopes: [], definition: { uri: vscode.Uri.file("/elsewhere.cpp"), range: at(8) } });
    const provider = graphProvider(resolve);
    try {
      await provider.addRoot(rootTarget(), rootOrigin());
      expect(provider.rootJumpTarget()).toEqual({ uri: "file:///root.cpp", line: 1 });
    } finally { provider.dispose(); }
  });
});
