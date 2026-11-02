// Mock-heavy vscode shim: return-type annotations are omitted on the inlined
// fakes to keep the fixture readable.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

// Real-world regression check: runs the full navigation chain against the
// actual prplMesh/libvbss/mtk7990k sources — the call to the free function
// vbss_if_get_sta_entry inside ApManager::handle_vbss_security_request, with
// two same-name definitions in the index (the 4-arg facade and the 3-arg
// mt7990 implementation). The vi.mock factory is hoisted, so all setup —
// including reading the real files — happens inside it.

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
        typeof start === "number" ? new MockPosition(start, end as number) : start;
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

  const realRoot =
    "E:/qiuzhiqin/code/ct-dbus_fttr_r388393_20260806_multista/source/compatible_branch/component";
  const realFiles: ReadonlyArray<[string, string]> = [
    [
      "ap_manager.cpp",
      `${realRoot}/romfs/application/mesh/prplmesh_skyworth/sys/prplMesh/agent/src/beerocks/fronthaul_manager/ap_manager/ap_manager.cpp`
    ],
    [
      "ap_manager.h",
      `${realRoot}/romfs/application/mesh/prplmesh_skyworth/sys/prplMesh/agent/src/beerocks/fronthaul_manager/ap_manager/ap_manager.h`
    ],
    ["vbss_interface.c", `${realRoot}/romfs/lib/libvbss/source/vbss_interface.c`],
    ["vbss_interface.h", `${realRoot}/romfs/lib/libvbss/include/vbss_interface.h`],
    [
      "son_slave_thread.cpp",
      `${realRoot}/romfs/application/mesh/prplmesh_skyworth/sys/prplMesh/agent/src/beerocks/slave/son_slave_thread.cpp`
    ],
    [
      "vbss_interface_impl_mt7990.c",
      `${realRoot}/kmodule/mtk7990k_mesh/vbss/vbss_interface_impl_mt7990.c`
    ]
  ];

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
      getText(range?: { start: MockPosition; end: MockPosition }): string {
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

  const documents = new Map<string, unknown>();
  const texts = new Map<string, string>();
  const uris: MockUri[] = [];
  for (const [name, path] of realFiles) {
    const text = readFileSync(path, "utf8");
    const uri = mockUri(`file:///e:/real/${name}`);
    uris.push(uri);
    texts.set(name, text);
    documents.set(uri.toString(), makeDocument(uri, text));
  }

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
      workspaceFolders: [{ uri: mockUri("file:///e:/real"), name: "real", index: 0 }],
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
      findFiles: async () => [...uris],
      openTextDocument: async (uri: MockUri) => {
        const document = documents.get(uri.toString());
        if (document === undefined) {
          throw new Error(`unknown document ${uri.toString()}`);
        }
        return document;
      },
      getWorkspaceFolder: () => ({ uri: mockUri("file:///e:/real"), name: "real", index: 0 }),
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
    __test: { documents, texts, uris: uris.map((uri) => uri.toString()), fileCount: realFiles.length }
  });
  return module;
});

import * as vscode from "vscode";
import { QueryCache } from "../../src/services/queryCache";
import { ReferenceResolver } from "../../src/services/referenceResolver";
import { PersistentCallIndex } from "../../src/services/persistentCallIndex";
import { SymbolResolver } from "../../src/services/symbolResolver";
import { createTempStorage } from "./helpers/tempStorage";

const token = { isCancellationRequested: false } as vscode.CancellationToken;
const fixtures = (vscode as unknown as {
  __test: {
    documents: Map<string, { positionAt: (offset: number) => { line: number } }>;
    texts: Map<string, string>;
    fileCount: number;
  };
}).__test;

describe("real-world vbss_if_get_sta_entry navigation", () => {
  it("binds the 4-argument facade from a call inside a member function", async () => {
    const output = { appendLine: () => undefined, error: () => undefined };
    const storage = createTempStorage();
    const index = new PersistentCallIndex(
      storage.uri,
      output as unknown as vscode.OutputChannel
    );
    onTestFinished(() => {
      index.dispose();
      storage.remove();
    });
    await index.ensureReady(token);
    expect(index.status().phase).toBe("ready");
    expect(index.status().stats.files).toBe(fixtures.fileCount);

    const callSiteText = fixtures.texts.get("ap_manager.cpp")!;
    const callOffset = callSiteText.indexOf("vbss_if_get_sta_entry(sta_mac_str");
    expect(callOffset).toBeGreaterThanOrEqual(0);
    const callSiteDoc = fixtures.documents.get("file:///e:/real/ap_manager.cpp")!;

    const resolver = new SymbolResolver();
    const probePosition = callSiteDoc.positionAt(callOffset) as unknown as vscode.Position;
    console.log(
      "probe position:",
      JSON.stringify({ line: (probePosition as unknown as { line: number }).line, character: (probePosition as unknown as { character: number }).character })
    );
    const probeDoc = fixtures.documents.get("file:///e:/real/ap_manager.cpp") as unknown as {
      getWordRangeAtPosition(position: unknown, regex?: RegExp): { start: unknown; end: unknown } | undefined;
      getText(range?: unknown): string;
      offsetAt(position: unknown): number;
    };
    const probeRange = probeDoc.getWordRangeAtPosition(probePosition);
    console.log("probe word:", probeDoc.getText(probeRange));
    console.log("probe offsetAt:", probeDoc.offsetAt(probePosition));
    const target = await resolver.resolveAt(
      vscode.Uri.parse("file:///e:/real/ap_manager.cpp") as unknown as vscode.Uri,
      probePosition,
      token
    );
    expect(target).toBeDefined();
    expect(target?.name).toBe("vbss_if_get_sta_entry");
    console.log("resolver scope:", JSON.stringify(target?.scope));
    console.log("resolver definition:", target?.definition === undefined ? "NONE" : "SET");

    const result = await new ReferenceResolver(index, new QueryCache()).resolve(target!, token);
    console.log("tree callers:", result.scopes.map((scope) => scope.name).join(", "));
    console.log(
      "bound definition:",
      result.definition === undefined
        ? "NONE"
        : `${result.definition.uri.toString()} line ${result.definition.range.start.line + 1}`
    );

    expect(result.definition).toBeDefined();
    expect(result.definition!.uri.toString()).toBe("file:///e:/real/vbss_interface.c");
  });
});
