// Mock-heavy vscode shim: return-type annotations are omitted on the inlined
// fakes to keep the fixture readable.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it, vi } from "vitest";

// End-to-end navigation chain over real index/resolver logic with only the
// vscode API layer mocked: resolveAt at a member call site -> persistent
// index query -> the bound definition must surface on the query result so a
// root-node click jumps to the definition instead of the call site.
//
// Fixture mirrors ap_manager.cpp: class declared in a header, member defined
// with a qualified name, called unqualified from another member function.
// The vi.mock factory is hoisted, so every helper lives inside it and the
// fixtures are re-exported through the mocked module for the assertions.

vi.mock("vscode", () => {
  class MockPosition {
    constructor(
      public readonly line: number,
      public readonly character: number
    ) {}
  }

  class MockRange {
    public readonly start: MockPosition;
    public readonly end: MockPosition;
    constructor(
      start: MockPosition | number,
      end: MockPosition | number,
      endLine?: number,
      endCharacter?: number
    ) {
      this.start =
        typeof start === "number"
          ? new MockPosition(start, end as number)
          : start;
      this.end =
        typeof endLine === "number"
          ? new MockPosition(endLine, endCharacter as number)
          : (end as MockPosition);
    }
  }

  class MockLocation {
    constructor(
      public readonly uri: unknown,
      public readonly range: MockRange
    ) {}
  }

  interface MockUri {
    toString(): string;
  }

  const mockUri = (value: string): MockUri & { path: string; with: (change: { path: string }) => MockUri } => ({
    toString: () => value,
    get path(): string {
      return value.replace(/^file:\/\//u, "");
    },
    with: (change: { path: string }) => mockUri(`file://${change.path}`)
  });
  const joinPath = (base: MockUri, ...segments: string[]): MockUri => {
    let value = base.toString();
    for (const segment of segments) {
      value = `${value.replace(/\/$/u, "")}/${segment}`;
    }
    return mockUri(value);
  };

  const headerText = `struct Messenger {
  void handle_message(int cmd);
  void handle_vbss_security(int cmd);
};
`;

  const sourceText = `#include "call_chain.hpp"

void Messenger::handle_message(int cmd) {
    handle_vbss_security(cmd);
}

void Messenger::handle_vbss_security(int cmd) {
    global_total += cmd;
}
`;

  // Mirrors libvbss: two same-name definitions with different signatures —
  // the 4-argument facade and the 3-argument platform implementation.
  const facadeText = `int vbss_if_get_sta_entry(const char *mac, void *client_sec, char *iface_name, unsigned char flags) {
    (void)mac; (void)client_sec; (void)iface_name; (void)flags;
    return 0;
}
`;

  const implText = `int vbss_if_get_sta_entry(const char *ifname, const char *mac, void *client_sec) {
    (void)ifname; (void)mac; (void)client_sec;
    return 0;
}
`;

  const consumerText = `int Consumer::setup(const char *mac, void *sec, char *ifname, unsigned char flags) {
    return vbss_if_get_sta_entry(mac, sec, ifname, flags);
}
`;

  const consumerHeaderText = `class Consumer {
public:
    int setup(const char *mac, void *sec, char *ifname, unsigned char flags);
};
`;

  const consumerHeaderUri = mockUri("file:///e:/sdt-fixture/consumer.h");
  const headerUri = mockUri("file:///e:/sdt-fixture/call_chain.hpp");
  const sourceUri = mockUri("file:///e:/sdt-fixture/call_chain.cpp");
  const facadeUri = mockUri("file:///e:/sdt-fixture/vbss_interface.c");
  const implUri = mockUri("file:///e:/sdt-fixture/vbss_interface_impl_mt7990.c");
  const consumerUri = mockUri("file:///e:/sdt-fixture/consumer.cpp");

  function makeDocument(uri: MockUri, text: string) {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") {
        starts.push(index + 1);
      }
    }
    const positionAt = (offset: number) => {
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1]! <= offset) {
        line += 1;
      }
      return new MockPosition(line, offset - starts[line]!);
    };
    const offsetAt = (position: MockPosition) =>
      starts[position.line] === undefined
        ? text.length
        : Math.min(starts[position.line]! + position.character, text.length);
    return {
      uri,
      version: 1,
      getText(range?: MockRange): string {
        if (range === undefined) {
          return text;
        }
        return text.slice(offsetAt(range.start), offsetAt(range.end));
      },
      offsetAt,
      positionAt,
      getWordRangeAtPosition(
        position: MockPosition,
        regex?: RegExp
      ): MockRange | undefined {
        const pattern = regex ?? /[A-Za-z_][A-Za-z0-9_]*/u;
        const anchor = offsetAt(position);
        let start = anchor;
        while (start > 0 && pattern.test(text[start - 1]!)) {
          start -= 1;
        }
        let end = anchor;
        while (end < text.length && pattern.test(text[end]!)) {
          end += 1;
        }
        if (start === end) {
          return undefined;
        }
        return new MockRange(positionAt(start), positionAt(end));
      }
    };
  }

  const documents = new Map<string, unknown>([
    [headerUri.toString(), makeDocument(headerUri, headerText)],
    [sourceUri.toString(), makeDocument(sourceUri, sourceText)],
    [facadeUri.toString(), makeDocument(facadeUri, facadeText)],
    [implUri.toString(), makeDocument(implUri, implText)],
    [consumerHeaderUri.toString(), makeDocument(consumerHeaderUri, consumerHeaderText)],
    [consumerUri.toString(), makeDocument(consumerUri, consumerText)]
  ]);

  const module = {
    SymbolKind: {
      Function: 11,
      Method: 5,
      Constructor: 8,
      Operator: 25,
      Class: 4,
      Struct: 22,
      Interface: 10,
      Enum: 9,
      Namespace: 2,
      Module: 1,
      Variable: 12
    },
    Position: MockPosition,
    Range: MockRange,
    Location: MockLocation,
    FileType: { File: 1, Directory: 2 },
    Uri: {
      parse: (value: string) => mockUri(value),
      joinPath: (base: MockUri, ...segments: string[]) => joinPath(base, ...segments)
    },
    EventEmitter: class {
      public readonly event = () => ({ dispose: () => undefined });
      public fire(): void {}
      public dispose(): void {}
    },
    workspace: {
      workspaceFolders: [
        { uri: mockUri("file:///e:/sdt-fixture"), name: "fixture", index: 0 }
      ],
      fs: {
        readFile: async (uri: MockUri) => {
          const document = documents.get(uri.toString());
          if (document === undefined) {
            throw new Error(`no persisted index: ${uri.toString()}`);
          }
          return Buffer.from(document.getText(), "utf8");
        },
        stat: async () => ({ mtime: 12345, type: 1, size: 0 }),
        writeFile: async () => undefined,
        createDirectory: async () => undefined,
        rename: async () => undefined,
        delete: async () => undefined,
        readDirectory: async () => []
      },
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback
      }),
      findFiles: async () => [
        headerUri,
        sourceUri,
        facadeUri,
        implUri,
        consumerHeaderUri,
        consumerUri
      ],
      openTextDocument: async (uri: MockUri) => {
        const document = documents.get(uri.toString());
        if (document === undefined) {
          throw new Error(`unknown document ${uri.toString()}`);
        }
        return document;
      },
      getWorkspaceFolder: () => ({
        uri: mockUri("file:///e:/sdt-fixture"),
        name: "fixture",
        index: 0
      }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose: () => undefined }),
        onDidChange: () => ({ dispose: () => undefined }),
        onDidDelete: () => ({ dispose: () => undefined }),
        dispose: () => undefined
      }),
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined })
    }
  };
  Object.assign(module, {
    __test: {
      documents,
      headerUri,
      sourceUri,
      sourceText,
      headerText,
      facadeUri,
      facadeText,
      implUri,
      consumerUri,
      consumerText,
      MockPosition,
      MockRange
    }
  });
  return module;
});

import * as vscode from "vscode";
import { QueryCache } from "../../src/services/queryCache";
import { ReferenceResolver } from "../../src/services/referenceResolver";
import { PersistentCallIndex } from "../../src/services/persistentCallIndex";
import { SymbolResolver } from "../../src/services/symbolResolver";

const token = { isCancellationRequested: false } as vscode.CancellationToken;
const fixtures = (vscode as unknown as {
  __test: {
    documents: Map<string, { positionAt: (offset: number) => { line: number } }>;
    sourceUri: { toString(): string };
    sourceText: string;
    facadeUri: { toString(): string };
    facadeText: string;
    consumerUri: { toString(): string };
    consumerText: string;
  };
}).__test;

async function buildIndex(): Promise<PersistentCallIndex> {
  const output = { appendLine: () => undefined, error: () => undefined };
  const index = new PersistentCallIndex(
    vscode.Uri.parse("file:///e:/sdt-fixture") as vscode.Uri,
    output as unknown as vscode.OutputChannel
  );
  await index.ensureReady(token);
  return index;
}

describe("call-site root navigation binds the definition", () => {
  it("surfaces the index-bound definition for an unqualified member call", async () => {
    const index = await buildIndex();
    expect(index.status().phase).toBe("ready");
    expect(index.status().stats.files).toBe(6);

    const document = fixtures.documents.get(fixtures.sourceUri.toString())!;
    const callOffset = fixtures.sourceText.indexOf("handle_vbss_security(cmd)");
    expect(callOffset).toBeGreaterThanOrEqual(0);
    const definitionOffset = fixtures.sourceText.indexOf(
      "void Messenger::handle_vbss_security"
    );
    expect(definitionOffset).toBeGreaterThan(callOffset);

    const resolver = new SymbolResolver();
    const target = await resolver.resolveAt(
      fixtures.sourceUri as unknown as vscode.Uri,
      document.positionAt(callOffset) as unknown as vscode.Position,
      token
    );
    expect(target).toBeDefined();
    expect(target?.name).toBe("handle_vbss_security");
    // Pre-query the call site carries no definition: the class declaration
    // lives in the header, so nothing in this file can anchor the jump.
    expect(target?.definition).toBeUndefined();

    const result = await new ReferenceResolver(index, new QueryCache()).resolve(
      target!,
      token
    );
    // The tree itself is complete (the caller is found)…
    expect(result.scopes.map((scope) => scope.name)).toContain("handle_message");
    // …and the index binding must surface where the definition lives.
    expect(result.definition).toBeDefined();
    const definition = result.definition!;
    expect(definition.uri.toString()).toBe(fixtures.sourceUri.toString());
    const definitionLine = document.positionAt(definitionOffset).line + 1;
    const callLine = document.positionAt(callOffset).line + 1;
    expect(definition.range.start.line + 1).toBe(definitionLine);
    expect(definitionLine).not.toBe(callLine);
  });

  it("disambiguates same-name definitions by call arity", async () => {
    const index = await buildIndex();
    const document = fixtures.documents.get(fixtures.consumerUri.toString())!;
    const callOffset = fixtures.consumerText.indexOf(
      "vbss_if_get_sta_entry(mac, sec, ifname, flags)"
    );
    expect(callOffset).toBeGreaterThanOrEqual(0);

    const resolver = new SymbolResolver();
    const target = await resolver.resolveAt(
      fixtures.consumerUri as unknown as vscode.Uri,
      document.positionAt(callOffset) as unknown as vscode.Position,
      token
    );
    expect(target).toBeDefined();
    expect(target?.name).toBe("vbss_if_get_sta_entry");
    expect(target?.definition).toBeUndefined();

    const result = await new ReferenceResolver(index, new QueryCache()).resolve(
      target!,
      token
    );
    // The enclosing Consumer::setup is a member function, but vbss_if_get_
    // sta_entry is a free function: the caller is found even though the
    // call site sits inside a member-function body.
    expect(result.scopes.map((scope) => scope.name)).toContain("setup");
    // Two same-name definitions exist (4-arg facade, 3-arg impl); the call
    // passes four arguments, so the facade must win.
    expect(result.definition).toBeDefined();
    const definition = result.definition!;
    expect(definition.uri.toString()).toBe(fixtures.facadeUri.toString());
    const facadeDefinitionLine =
      fixtures.documents
        .get(fixtures.facadeUri.toString())!
        .positionAt(fixtures.facadeText.indexOf("int vbss_if_get_sta_entry")).line + 1;
    expect(definition.range.start.line + 1).toBe(facadeDefinitionLine);
  });

  it("does not publish a partial index when rebuild is cancelled", async () => {
    const output = { appendLine: () => undefined, error: () => undefined };
    const index = new PersistentCallIndex(
      vscode.Uri.parse("file:///e:/sdt-fixture") as vscode.Uri,
      output as unknown as vscode.OutputChannel
    );
    let cancellationChecks = 0;
    const cancellingToken = {
      get isCancellationRequested(): boolean {
        cancellationChecks += 1;
        return cancellationChecks >= 2;
      }
    } as vscode.CancellationToken;

    try {
      await index.rebuild(cancellingToken);

      expect(index.status().phase).toBe("cancelled");
      expect(index.stats()).toEqual({ files: 0, functions: 0, calls: 0 });
    } finally {
      index.dispose();
    }
  });
});
