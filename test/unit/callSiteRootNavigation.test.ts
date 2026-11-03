// Mock-heavy vscode shim: return-type annotations are omitted on the inlined
// fakes to keep the fixture readable.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  const autoReceiverText = `class Controller {
public:
    bool update_agent_vbss_capabilities(int agent);
};

class db {
public:
    Controller *get_controller_ctx() { return m_controller_ctx; }

private:
    Controller *m_controller_ctx;
};

namespace actions {
db *g_database = nullptr;

bool update_vbss_capabilities(int agent) {
    auto controller_ctx = g_database->get_controller_ctx();
    return controller_ctx->update_agent_vbss_capabilities(agent);
}

struct sFunctions {
    const char *name;
    bool (*callback)(int agent);
};

int other_callback(int agent) {
    return agent;
}

std::vector<sFunctions> get_func_list() {
    const std::vector<sFunctions> functions_list = {
        {"update_vbss_capabilities", update_vbss_capabilities},
    };
    return functions_list;
}

std::vector<sFunctions> get_other_func_list() {
    const std::vector<sFunctions> functions_list = {
        {"other_callback", other_callback},
    };
    return functions_list;
}
}

bool Controller::update_agent_vbss_capabilities(int agent) {
    return agent != 0;
}

static int UniCmdBssInfoBcnOffloadWrapAll(void *ctx) { return 0; }
struct command_handler { int (*pfHandler)(void *); };
static command_handler UniCmdBssInfoTab[] = {
    { .pfHandler = UniCmdBssInfoBcnOffloadWrapAll }
};
`;

  const consumerHeaderUri = mockUri("file:///e:/sdt-fixture/consumer.h");
  const headerUri = mockUri("file:///e:/sdt-fixture/call_chain.hpp");
  const sourceUri = mockUri("file:///e:/sdt-fixture/call_chain.cpp");
  const facadeUri = mockUri("file:///e:/sdt-fixture/vbss_interface.c");
  const implUri = mockUri("file:///e:/sdt-fixture/vbss_interface_impl_mt7990.c");
  const consumerUri = mockUri("file:///e:/sdt-fixture/consumer.cpp");
  const autoReceiverUri = mockUri("file:///e:/sdt-fixture/auto_receiver.cpp");

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
    [consumerUri.toString(), makeDocument(consumerUri, consumerText)],
    [autoReceiverUri.toString(), makeDocument(autoReceiverUri, autoReceiverText)]
  ]);
  const binaryFiles = new Map<string, Uint8Array>();
  const watcherEvents = { deleted: (_uri: MockUri): void => undefined };

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
      private readonly listeners = new Set<(value: unknown) => void>();
      public readonly event = (listener: (value: unknown) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      public fire(value?: unknown): void {
        for (const listener of this.listeners) { listener(value); }
      }
      public dispose(): void { this.listeners.clear(); }
    },
    workspace: {
      workspaceFolders: [
        { uri: mockUri("file:///e:/sdt-fixture"), name: "fixture", index: 0 }
      ],
      fs: {
        readFile: async (uri: MockUri) => {
          const bytes = binaryFiles.get(uri.toString());
          if (bytes !== undefined) {
            return bytes;
          }
          const document = documents.get(uri.toString());
          if (document === undefined) {
            throw new Error(`no persisted index: ${uri.toString()}`);
          }
          return Buffer.from(document.getText(), "utf8");
        },
        stat: async () => ({ mtime: 12345, type: 1, size: 0 }),
        writeFile: async (uri: MockUri, bytes: Uint8Array) => {
          binaryFiles.set(uri.toString(), Uint8Array.from(bytes));
        },
        createDirectory: async () => undefined,
        rename: async (source: MockUri, target: MockUri) => {
          const bytes = binaryFiles.get(source.toString());
          if (bytes === undefined) {
            throw new Error(`missing temporary index: ${source.toString()}`);
          }
          binaryFiles.set(target.toString(), bytes);
          binaryFiles.delete(source.toString());
        },
        delete: async (uri: MockUri) => {
          binaryFiles.delete(uri.toString());
        },
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
        consumerUri,
        autoReceiverUri
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
        onDidDelete: (listener: (uri: MockUri) => void) => {
          watcherEvents.deleted = listener;
          return { dispose: () => undefined };
        },
        dispose: () => undefined
      }),
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined })
    }
  };
  Object.assign(module, {
    __test: {
      documents,
      binaryFiles,
      watcherEvents,
      makeDocument,
      headerUri,
      sourceUri,
      sourceText,
      headerText,
      facadeUri,
      facadeText,
      implUri,
      consumerUri,
      consumerText,
      autoReceiverUri,
      autoReceiverText,
      MockPosition,
      MockRange
    }
  });
  return module;
});

import { readdirSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CallIndexDatabase,
  openCallIndexDatabase
} from "../../src/services/callIndexDatabase";
import { QueryCache } from "../../src/services/queryCache";
import { ReferenceResolver } from "../../src/services/referenceResolver";
import { PersistentCallIndex } from "../../src/services/persistentCallIndex";
import { SymbolResolver } from "../../src/services/symbolResolver";
import { TypeLookup } from "../../src/services/typeLookup";
import type { IndexedFileRecord } from "../../src/model/persistentIndexTypes";
import { createTempStorage, type TempStorage } from "./helpers/tempStorage";

const token = { isCancellationRequested: false } as vscode.CancellationToken;
const fixtures = (vscode as unknown as {
  __test: {
    documents: Map<string, { positionAt: (offset: number) => { line: number } }>;
    binaryFiles: Map<string, Uint8Array>;
    watcherEvents: { deleted: (uri: { toString(): string }) => void };
    makeDocument: (uri: { toString(): string }, text: string) => vscode.TextDocument;
    sourceUri: { toString(): string };
    sourceText: string;
    facadeUri: { toString(): string };
    facadeText: string;
    consumerUri: { toString(): string };
    consumerText: string;
    autoReceiverUri: { toString(): string };
    autoReceiverText: string;
  };
}).__test;
const originalDocuments = new Map(fixtures.documents);

let storage: TempStorage;
const createdIndexes: PersistentCallIndex[] = [];

function newIndex(outputMessages?: string[]): PersistentCallIndex {
  const output = {
    appendLine: (message: string) => outputMessages?.push(message),
    error: () => undefined
  };
  const index = new PersistentCallIndex(
    storage.uri,
    output as unknown as vscode.OutputChannel
  );
  createdIndexes.push(index);
  return index;
}

async function buildIndex(outputMessages?: string[]): Promise<PersistentCallIndex> {
  const index = newIndex(outputMessages);
  await index.ensureReady(token);
  return index;
}

beforeEach(() => {
  storage = createTempStorage();
  fixtures.binaryFiles.clear();
  fixtures.documents.clear();
  for (const [uri, document] of originalDocuments) { fixtures.documents.set(uri, document); }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const index of createdIndexes.splice(0)) { index.dispose(); }
  storage.remove();
});

interface MutableIndex {
  mutationTail: Promise<void>;
  readonly database: CallIndexDatabase;
  readonly types: TypeLookup;
}

function typeSnapshot(types: TypeLookup): unknown {
  return [types.memberTypes, types.objectTypes, types.baseTypes, types.virtualMembers]
    .map((collection) => structuredClone(collection));
}

/** The type lookup a full rebuild would produce from the committed database rows. */
function committedTypes(index: MutableIndex): TypeLookup {
  const types = new TypeLookup();
  types.add(index.database.typeContributions());
  return types;
}

function databaseFile(): string {
  const name = readdirSync(storage.directory).find((entry) => entry.endsWith(".sqlite"));
  expect(name).toBeDefined();
  return path.join(storage.directory, name!);
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function flushUpdates(index: PersistentCallIndex): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
  await (index as unknown as MutableIndex).mutationTail;
}

describe("call-site root navigation binds the definition", () => {
  it("rebuilds unchanged files when upgrading the old scope semantics", async () => {
    const initial = await buildIndex();
    initial.dispose();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile());
    database.exec("PRAGMA user_version = 2");
    database.close();

    const replace = vi.spyOn(CallIndexDatabase.prototype, "replaceFile");
    const reopened = await buildIndex();

    expect(reopened.stats().files).toBe(7);
    expect(replace).toHaveBeenCalledTimes(7);
  });

  it("finds global callers in control conditions and unbraced bodies", async () => {
    const functionUri = vscode.Uri.parse("file:///e:/sdt-fixture/condition_target.cpp");
    const functionText = "int condition_target(int x) { return x; }\n";
    const userUri = vscode.Uri.parse("file:///e:/sdt-fixture/condition_user.cpp");
    const userText = `void conditional_user(int a) {
  if (a) condition_target(a);
  while (a) condition_target(a);
  if (a && condition_target(a)) {}
  for (int i = 0; a && condition_target(a); ++i) {}
  if (int value(1); a && condition_target(a)) {}
}
`;
    for (const [uri, text] of [[functionUri, functionText], [userUri, userText]] as const) {
      fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, text));
    }
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, functionUri, userUri]);
    const index = await buildIndex();
    const resolver = new ReferenceResolver(index, new QueryCache());

    for (const [uri, text] of [[functionUri, functionText], [userUri, userText]] as const) {
      const document = fixtures.makeDocument(uri, text);
      const target = await new SymbolResolver().resolveAt(uri, document.positionAt(text.indexOf("condition_target")), token);
      const result = await resolver.resolve(target!, token);

      expect(result.definition?.uri.toString()).toBe(functionUri.toString());
      expect(result.scopes.map((scope) => scope.name)).toEqual(["conditional_user"]);
      expect(result.scopes[0]!.references).toHaveLength(5);
    }
  });

  it("reopens an unchanged database without rewriting files or notifying", async () => {
    const initial = await buildIndex();
    initial.dispose();
    const index = newIndex();
    const write = vi.spyOn(CallIndexDatabase.prototype, "replaceFile");
    const changed = vi.fn();
    index.onDidChange(changed);
    await index.ensureReady(token);
    expect(index.stats().files).toBe(7);
    expect(write).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    await index.rebuild(token);
    expect(write).toHaveBeenCalledTimes(7);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("batches unsaved edits and preserves shared types when one file is deleted", async () => {
    const index = await buildIndex();
    const internal = index as unknown as MutableIndex;
    const commit = vi.spyOn(CallIndexDatabase.prototype, "commit");
    const changed = vi.fn();
    index.onDidChange(changed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const [uri, name] of [[fixtures.sourceUri, "first"], [fixtures.consumerUri, "second"]] as const) {
        const document = Object.assign(fixtures.makeDocument(uri, `
struct Shared : Base { int value; };
struct Context { int value; };
Context global_context;
void ${name}() { consume(global_context); }
`), { isDirty: true, version: 2 });
        fixtures.documents.set(uri.toString(), document);
        index.scheduleDocumentUpdate(document);
      }
      await flushUpdates(index);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(typeSnapshot(internal.types)).toEqual(typeSnapshot(committedTypes(internal)));

      fixtures.watcherEvents.deleted(fixtures.sourceUri);
      await flushUpdates(index);
      expect(internal.types.baseTypes.get("Shared")).toEqual(new Set(["Base"]));
      expect(internal.types.objectTypes.get("global_context")).toBe("Context");
      expect(typeSnapshot(internal.types)).toEqual(typeSnapshot(committedTypes(internal)));
    } finally { index.dispose(); }
  });

  it("cancels a pending file read when that file is deleted", async () => {
    const index = await buildIndex();
    const messages: string[] = [];
    const read = vi.spyOn(vscode.workspace.fs, "readFile");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      index.scheduleFileUpdate(fixtures.sourceUri as vscode.Uri, 350);
      fixtures.documents.delete(fixtures.sourceUri.toString());
      index.onDidStatusChange((status) => { messages.push(status.phase); });
      fixtures.watcherEvents.deleted(fixtures.sourceUri);
      await flushUpdates(index);
      expect(read.mock.calls.some(([uri]) => uri.toString() === fixtures.sourceUri.toString()))
        .toBe(false);
      expect(index.stats().files).toBe(6);
      expect(messages).not.toContain("error");

      const recreated = Object.assign(fixtures.makeDocument(fixtures.sourceUri,
        "void recreated() { consume(1); }\n"), { isDirty: true, version: 3 });
      fixtures.documents.set(fixtures.sourceUri.toString(), recreated);
      fixtures.watcherEvents.deleted(fixtures.sourceUri);
      index.scheduleDocumentUpdate(recreated, 0);
      await flushUpdates(index);
      expect(index.stats().files).toBe(7);
      expect((index as unknown as MutableIndex).database.definitionsByName("recreated")).toHaveLength(1);
      expect(messages).not.toContain("error");

      const internal = index as unknown as MutableIndex;
      let release!: () => void;
      internal.mutationTail = new Promise<void>((resolve) => { release = resolve; });
      read.mockClear();
      index.scheduleFileUpdate(fixtures.sourceUri as vscode.Uri, 0);
      await vi.advanceTimersByTimeAsync(5);
      fixtures.documents.delete(fixtures.sourceUri.toString());
      fixtures.watcherEvents.deleted(fixtures.sourceUri);
      await vi.advanceTimersByTimeAsync(5);
      release();
      await internal.mutationTail;
      expect(read.mock.calls.some(([uri]) => uri.toString() === fixtures.sourceUri.toString()))
        .toBe(false);
      expect(index.stats().files).toBe(6);
      expect(messages).not.toContain("error");
    } finally { index.dispose(); }
  });

  it("finds a designated callback table without a trailing field comma", async () => {
    const index = await buildIndex();
    const document = fixtures.documents.get(fixtures.autoReceiverUri.toString())!;
    const target = await new SymbolResolver().resolveAt(
      fixtures.autoReceiverUri as unknown as vscode.Uri,
      document.positionAt(fixtures.autoReceiverText.indexOf(
        "UniCmdBssInfoBcnOffloadWrapAll(void *ctx)"
      )) as unknown as vscode.Position,
      token
    );
    const result = await new ReferenceResolver(index, new QueryCache()).resolve(
      target!, token
    );
    expect(result.scopes.map((scope) => scope.name)).toEqual(["UniCmdBssInfoTab"]);
    index.dispose();
  });

  it("surfaces the index-bound definition for an unqualified member call", async () => {
    const index = await buildIndex();
    expect(index.status().phase).toBe("ready");
    expect(index.status().stats.files).toBe(7);

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

  it("finds the caller of a member invoked through an auto result", async () => {
    const index = await buildIndex();
    const document = fixtures.documents.get(fixtures.autoReceiverUri.toString())!;
    const definitionOffset = fixtures.autoReceiverText.indexOf(
      "update_agent_vbss_capabilities(int agent) {"
    );
    expect(definitionOffset).toBeGreaterThanOrEqual(0);

    const resolver = new SymbolResolver();
    const target = await resolver.resolveAt(
      fixtures.autoReceiverUri as unknown as vscode.Uri,
      document.positionAt(definitionOffset) as unknown as vscode.Position,
      token
    );
    expect(target).toBeDefined();
    expect(target?.name).toBe("update_agent_vbss_capabilities");

    const result = await new ReferenceResolver(index, new QueryCache()).resolve(
      target!,
      token
    );
    expect(result.scopes.map((scope) => scope.name)).toContain(
      "update_vbss_capabilities"
    );
  });

  it("uses a function-local callback table as the callback parent", async () => {
    const index = await buildIndex();
    const document = fixtures.documents.get(fixtures.autoReceiverUri.toString())!;
    const definitionOffset = fixtures.autoReceiverText.indexOf(
      "update_vbss_capabilities(int agent) {"
    );
    expect(definitionOffset).toBeGreaterThanOrEqual(0);

    const resolver = new SymbolResolver();
    const target = await resolver.resolveAt(
      fixtures.autoReceiverUri as unknown as vscode.Uri,
      document.positionAt(definitionOffset) as unknown as vscode.Position,
      token
    );
    expect(target).toBeDefined();
    expect(target?.name).toBe("update_vbss_capabilities");

    const result = await new ReferenceResolver(index, new QueryCache()).resolve(
      target!,
      token
    );
    const table = result.scopes.find((scope) => scope.name === "functions_list");
    expect(table).toBeDefined();
    expect(result.scopes.map((scope) => scope.name)).not.toContain("get_func_list");

    const tableResult = await new ReferenceResolver(index, new QueryCache()).resolve(
      table!.target,
      token
    );
    expect(tableResult.scopes.map((scope) => scope.name)).toContain("get_func_list");
    expect(tableResult.scopes.map((scope) => scope.name)).not.toContain(
      "get_other_func_list"
    );
  });

  it("preserves a function-local callback table scope after reopening the database", async () => {
    const initial = await buildIndex();
    initial.dispose();

    const outputMessages: string[] = [];
    const index = await buildIndex(outputMessages);
    expect(
      outputMessages.some((message) =>
        message.includes("Persistent call index loaded from")
      )
    ).toBe(true);

    const document = fixtures.documents.get(fixtures.autoReceiverUri.toString())!;
    const definitionOffset = fixtures.autoReceiverText.indexOf(
      "update_vbss_capabilities(int agent) {"
    );
    const target = await new SymbolResolver().resolveAt(
      fixtures.autoReceiverUri as unknown as vscode.Uri,
      document.positionAt(definitionOffset) as unknown as vscode.Position,
      token
    );
    const resolver = new ReferenceResolver(index, new QueryCache());
    const callbackResult = await resolver.resolve(target!, token);
    const table = callbackResult.scopes.find(
      (scope) => scope.name === "functions_list"
    );
    expect(table).toBeDefined();

    const tableResult = await resolver.resolve(table!.target, token);
    expect(tableResult.scopes.map((scope) => scope.name)).toEqual(["get_func_list"]);
  });

  it("does not publish a partial index when rebuild is cancelled", async () => {
    const index = newIndex();
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

  it("keeps an in-flight query on the committed index while a rebuild writes", async () => {
    const index = await buildIndex();
    const document = fixtures.documents.get(fixtures.autoReceiverUri.toString())!;
    const target = await new SymbolResolver().resolveAt(
      fixtures.autoReceiverUri as unknown as vscode.Uri,
      document.positionAt(fixtures.autoReceiverText.indexOf(
        "UniCmdBssInfoBcnOffloadWrapAll(void *ctx)"
      )) as unknown as vscode.Position,
      token
    );
    fixtures.documents.set(
      fixtures.autoReceiverUri.toString(),
      fixtures.makeDocument(
        fixtures.autoReceiverUri,
        fixtures.autoReceiverText.replace("UniCmdBssInfoTab", "RenamedTab")
      )
    );

    // The query passes ensureReady() and then waits for its target document.
    const openEntered = deferred();
    const openReleased = deferred();
    const openTextDocument = vscode.workspace.openTextDocument;
    vi.spyOn(vscode.workspace, "openTextDocument").mockImplementationOnce(async (uri) => {
      openEntered.resolve();
      await openReleased.promise;
      return openTextDocument(uri as vscode.Uri);
    });
    // Twelve files form one batch: the renamed table is written with the first
    // batch, and the rebuild then pauses on a file of the second batch while its
    // transaction is still open.
    const extraUris = Array.from({ length: 6 }, (_, index) => {
      const uri = vscode.Uri.parse(`file:///e:/sdt-fixture/extra_${index}.c`);
      fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, `void extra_${index}(void) {}\n`));
      return uri;
    });
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, ...extraUris]);
    const pausedUri = extraUris.at(-1)!.toString();
    const renamedWritten = deferred();
    const replaceFile = CallIndexDatabase.prototype.replaceFile;
    vi.spyOn(CallIndexDatabase.prototype, "replaceFile").mockImplementation(function (
      this: CallIndexDatabase,
      record: IndexedFileRecord
    ) {
      const previous = replaceFile.call(this, record);
      if (record.uri === fixtures.autoReceiverUri.toString()) {
        renamedWritten.resolve();
      }
      return previous;
    });
    const readReleased = deferred();
    const readFile = vscode.workspace.fs.readFile;
    vi.spyOn(vscode.workspace.fs, "readFile").mockImplementation(async (uri) => {
      if (uri.toString() === pausedUri) {
        await readReleased.promise;
      }
      return readFile(uri);
    });

    const pendingQuery = new ReferenceResolver(index, new QueryCache()).resolve(target!, token);
    await openEntered.promise;
    const rebuild = index.rebuild(token);
    await renamedWritten.promise;
    openReleased.resolve();
    const duringRebuild = await pendingQuery;
    readReleased.resolve();
    await rebuild;
    const afterRebuild = await new ReferenceResolver(index, new QueryCache()).resolve(target!, token);

    expect(duringRebuild.scopes.map((scope) => scope.name)).toEqual(["UniCmdBssInfoTab"]);
    expect(afterRebuild.scopes.map((scope) => scope.name)).toEqual(["RenamedTab"]);
  });

  it("persists names introduced by an edit so a reopened database still finds them", async () => {
    const index = await buildIndex();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const edited = Object.assign(fixtures.makeDocument(
      fixtures.sourceUri,
      `${fixtures.sourceText}\nvoid brand_new_caller() { brand_new_callee(); }\n`
    ), { isDirty: true, version: 4 });
    fixtures.documents.set(fixtures.sourceUri.toString(), edited);
    index.scheduleDocumentUpdate(edited);
    await flushUpdates(index);
    index.dispose();

    const database = await openCallIndexDatabase(databaseFile());
    try {
      expect(database.definitionsByName("brand_new_caller")).toHaveLength(1);
      expect(database.callsByCallee("brand_new_callee").map((call) => call.caller.name))
        .toEqual(["brand_new_caller"]);
    } finally { database.close(); }
  });

  it("leaves files above the size limit out of the index", async () => {
    const messages: string[] = [];
    const index = await buildIndex(messages);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const oversized = Object.assign(
      fixtures.makeDocument(fixtures.sourceUri, "x".repeat(4 * 1024 * 1024 + 1)),
      { isDirty: true, version: 6 }
    );
    fixtures.documents.set(fixtures.sourceUri.toString(), oversized);
    index.scheduleDocumentUpdate(oversized);
    await flushUpdates(index);
    expect(index.stats().files).toBe(6);
    vi.useRealTimers();

    fixtures.documents.set(fixtures.sourceUri.toString(), originalDocuments.get(fixtures.sourceUri.toString())!);
    vi.spyOn(vscode.workspace.fs, "stat").mockImplementation(async (uri) => ({
      mtime: 12345,
      ctime: 0,
      type: 1,
      size: uri.toString() === fixtures.facadeUri.toString() ? 4 * 1024 * 1024 + 1 : 0
    }));
    await index.rebuild(token);
    expect(index.stats().files).toBe(6);
    expect((index as unknown as MutableIndex).database.definitionsByName("handle_message")).toHaveLength(1);
    expect(messages.some((message) => message.startsWith("Skipped 1 files larger than 4 MB"))).toBe(true);
  });

  it("keeps the committed index when one read fails while another is still running", async () => {
    const index = await buildIndex();
    const internal = index as unknown as MutableIndex;
    const before = index.stats();
    fixtures.documents.set(
      fixtures.consumerUri.toString(),
      fixtures.makeDocument(
        fixtures.consumerUri,
        fixtures.consumerText.replace("Consumer::setup", "Consumer::renamed_setup")
      )
    );
    const facadeFailed = deferred();
    const lateRead = deferred();
    const readFile = vscode.workspace.fs.readFile;
    const read = vi.spyOn(vscode.workspace.fs, "readFile").mockImplementation(async (uri) => {
      if (uri.toString() === fixtures.facadeUri.toString()) {
        facadeFailed.resolve();
        throw new Error("simulated ENOENT during rebuild");
      }
      if (uri.toString() === fixtures.consumerUri.toString()) {
        await lateRead.promise;
      }
      return readFile(uri);
    });

    const rebuild = index.rebuild(token).then(
      () => "ready",
      (error: unknown) => String(error)
    );
    await facadeFailed.promise;
    // Let an early rejection, if any, run its rollback before the late read finishes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    lateRead.resolve();
    const outcome = await rebuild;
    // Give a write that outlived the rollback time to land before checking.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outcome).toContain("simulated ENOENT during rebuild");
    expect(internal.database.definitionsByName("renamed_setup")).toHaveLength(0);
    expect(internal.database.definitionsByName("setup")).toHaveLength(1);
    expect(index.stats()).toEqual(before);

    read.mockRestore();
    await index.rebuild(token);
    expect(internal.database.definitionsByName("renamed_setup")).toHaveLength(1);
  });

  it("indexes a file whose scan finds two definitions at one name", async () => {
    const index = await buildIndex();
    // googletest's gmock-matchers.h: the template template parameter is read as
    // a class twice, so both definitions share one name position.
    const uri = vscode.Uri.parse("file:///e:/sdt-fixture/gmock_matchers.h");
    fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, `template <template <class> class MatcherImpl, typename T>
class SomeOfArrayMatcher {
 public:
  template <typename U>
  operator Matcher<U>() const {
    return Matcher<U>(new MatcherImpl<U>(matchers_));
  }
};
`));
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, uri]);

    await index.rebuild(token);

    expect(index.status().phase).toBe("ready");
    expect(index.stats().files).toBe(8);
    const references = (index as unknown as MutableIndex).database.callsByCallee("U")
      .filter((reference) => reference.file.uri === uri.toString())
      .map((reference) => `${reference.caller.name}@${reference.call.offset}`);
    expect(new Set(references).size).toBe(references.length);
  });

  it("shows a macro as the caller of a function it wraps, and the macro's callers below it", async () => {
    const index = await buildIndex();
    const timerUri = vscode.Uri.parse("file:///e:/sdt-fixture/physical_device.c");
    const timerText = `void physical_device_init_timer(void *ad, void *timer, int repeat)
{
}
`;
    const apiUri = vscode.Uri.parse("file:///e:/sdt-fixture/physical_device_api.h");
    const apiText = `#define RTMPInitTimer(_pAd, _pTimer, _Repeat) \\
physical_device_init_timer(\\
	_pAd, _pTimer, _Repeat)
`;
    const userUri = vscode.Uri.parse("file:///e:/sdt-fixture/ap.c");
    const userText = "void ap_start(void *ad)\n{\n\tRTMPInitTimer(ad, 0, 0);\n}\n";
    for (const [uri, text] of [[timerUri, timerText], [apiUri, apiText], [userUri, userText]] as const) {
      fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, text));
    }
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, timerUri, apiUri, userUri]);
    await index.rebuild(token);

    const timerDocument = fixtures.documents.get(timerUri.toString())!;
    const target = await new SymbolResolver().resolveAt(
      timerUri as unknown as vscode.Uri,
      timerDocument.positionAt(timerText.indexOf("physical_device_init_timer")) as unknown as vscode.Position,
      token
    );
    const resolver = new ReferenceResolver(index, new QueryCache());
    const callers = await resolver.resolve(target!, token);
    expect(callers.scopes.map((scope) => scope.name)).toEqual(["RTMPInitTimer"]);

    const macroCallers = await resolver.resolve(callers.scopes[0]!.target!, token);
    expect(macroCallers.scopes.map((scope) => scope.name)).toEqual(["ap_start"]);
  });

  it("finds member callers through smart pointer receivers", async () => {
    const headerUri = vscode.Uri.parse("file:///e:/sdt-fixture/smart_task.h");
    const headerText = `#include <memory>
class vbss_task {
public:
    void handle_report(int x);
    void reset();
};
namespace actions {
class Holder {
public:
    std::shared_ptr<vbss_task> task() const;
    vbss_task *task_ptr() const;
};
}
class Controller {
public:
    void weak_lock(); void const_lock(); void shared_member();
    void shared_copy(); void unique_member(); void factory(); void raw_member();
    void smart_reset();
private:
    std::weak_ptr<vbss_task> m_vbss_task;
    std::shared_ptr<vbss_task> m_shared;
    std::unique_ptr<const vbss_task> m_unique;
    vbss_task *m_raw;
};
`;
    const globalsUri = vscode.Uri.parse("file:///e:/sdt-fixture/smart_globals.cpp");
    const globalsText = "#include \"smart_task.h\"\nnamespace actions {\nHolder g_holder;\n}\n";
    const sourceUri = vscode.Uri.parse("file:///e:/sdt-fixture/smart_task.cpp");
    const sourceText = `#include "smart_task.h"
void vbss_task::handle_report(int x) { (void)x; }
void vbss_task::reset() {}
void Controller::weak_lock() { auto task = m_vbss_task.lock(); if (task) { task->handle_report(1); } }
void Controller::const_lock() { const auto task = m_vbss_task.lock(); task->handle_report(2); }
void Controller::shared_member() { m_shared->handle_report(4); }
void Controller::shared_copy() { std::shared_ptr<vbss_task> task = m_shared; task->handle_report(5); }
void Controller::unique_member() { m_unique->handle_report(6); }
void Controller::factory() { auto task = std::make_shared<vbss_task>(); task->handle_report(7); }
void Controller::raw_member() { m_raw->handle_report(8); }
void Controller::smart_reset() { m_shared.reset(); }
namespace actions {
void use_holder() {
    auto raw = g_holder.task_ptr();
    raw->handle_report(9);
    auto task = g_holder.task();
    task->handle_report(10);
}
}
`;
    const files = [[headerUri, headerText], [globalsUri, globalsText], [sourceUri, sourceText]] as const;
    for (const [uri, text] of files) {
      fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, text));
    }
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, headerUri, globalsUri, sourceUri]);
    const index = await buildIndex();
    const resolver = new ReferenceResolver(index, new QueryCache());
    const document = fixtures.documents.get(sourceUri.toString())!;
    const resolve = async (anchor: string) => {
      const target = await new SymbolResolver().resolveAt(
        sourceUri as unknown as vscode.Uri,
        document.positionAt(sourceText.indexOf(anchor)) as unknown as vscode.Position,
        token
      );
      return resolver.resolve(target!, token);
    };

    const callers = await resolve("handle_report(int x)");
    expect(callers.scopes.map((scope) => scope.name).sort()).toEqual([
      "const_lock",
      "factory",
      "raw_member",
      "shared_copy",
      "shared_member",
      "unique_member",
      "use_holder",
      "weak_lock"
    ]);
    expect(callers.scopes.find((scope) => scope.name === "use_holder")!.references).toHaveLength(2);

    // From a call site, the receiver chain binds the definition in the source file.
    const fromCallSite = await resolve("handle_report(1)");
    expect(fromCallSite.definition?.uri.toString()).toBe(sourceUri.toString());
    expect(fromCallSite.definition?.range.start.line).toBe(
      document.positionAt(sourceText.indexOf("handle_report(int x)")).line
    );

    const resetCallers = await resolve("reset() {}");
    expect(resetCallers.scopes).toEqual([]);
  });

  it("keeps the pointee's ->get() and chained factory results apart from smart pointer accessors", async () => {
    // Codex's review fixture, plus `.get()` and `.lock()` on the smart pointer itself.
    const uri = vscode.Uri.parse("file:///e:/sdt-fixture/smart_accessors.cpp");
    const text = `#include <memory>
class Child {
public:
    void run();
};
class Holder {
public:
    Child *get();
    Child *child();
    void run();
};
Child global_child;
void Child::run() {}
void Holder::run() {}
Child *Holder::get() { return &global_child; }
Child *Holder::child() { return &global_child; }
void arrow_get(std::shared_ptr<Holder> ptr) { auto result = ptr->get(); result->run(); }
void factory_chain() { auto result = std::make_shared<Holder>()->child(); result->run(); }
void direct_factory() { auto result = std::make_shared<Holder>(); result->run(); }
void own_get(std::shared_ptr<Holder> ptr) { auto raw = ptr.get(); raw->run(); }
void own_lock(std::weak_ptr<Holder> weak) { auto locked = weak.lock(); locked->run(); }
`;
    fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, text));
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, uri]);
    const index = await buildIndex();
    const resolver = new ReferenceResolver(index, new QueryCache());
    const document = fixtures.documents.get(uri.toString())!;
    const callers = async (anchor: string): Promise<string[]> => {
      const target = await new SymbolResolver().resolveAt(
        uri as unknown as vscode.Uri,
        document.positionAt(text.indexOf(anchor)) as unknown as vscode.Position,
        token
      );
      const result = await resolver.resolve(target!, token);
      return result.scopes.map((scope) => scope.name).sort();
    };

    expect(await callers("run() {}\nvoid Holder")).toEqual(["arrow_get"]);
    expect(await callers("run() {}\nChild *Holder")).toEqual(["direct_factory", "own_get", "own_lock"]);
  });

  it("binds a name to its function from every entry point when a macro shares it", async () => {
    const index = await buildIndex();
    // Codex's layout: the macro and one caller share a header, the function
    // lives elsewhere, and one user only mentions the name without calling it.
    const functionUri = vscode.Uri.parse("file:///e:/sdt-fixture/function.cpp");
    const functionText = "int same_name(int x)\n{\n\treturn x;\n}\n";
    const macroUri = vscode.Uri.parse("file:///e:/sdt-fixture/macro.h");
    const macroText = "#define same_name(x) helper(x)\nint use_macro(void)\n{\n\treturn same_name(1);\n}\n";
    const usersUri = vscode.Uri.parse("file:///e:/sdt-fixture/users.cpp");
    const usersText =
      "void *pointer_user(void)\n{\n\treturn (void *)same_name;\n}\nint direct_user(void)\n{\n\treturn same_name(2);\n}\n";
    for (const [uri, text] of [[functionUri, functionText], [macroUri, macroText], [usersUri, usersText]] as const) {
      fixtures.documents.set(uri.toString(), fixtures.makeDocument(uri, text));
    }
    const fixtureUris = await vscode.workspace.findFiles("", "");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([...fixtureUris, functionUri, macroUri, usersUri]);
    await index.rebuild(token);

    const resolver = new ReferenceResolver(index, new QueryCache());
    for (const [uri, text, anchor] of [
      [functionUri, functionText, "same_name(int x)"],
      [macroUri, macroText, "same_name(1)"],
      [usersUri, usersText, "same_name(2)"]
    ] as const) {
      const document = fixtures.documents.get(uri.toString())!;
      const target = await new SymbolResolver().resolveAt(
        uri as unknown as vscode.Uri,
        document.positionAt(text.indexOf(anchor)) as unknown as vscode.Position,
        token
      );
      const result = await resolver.resolve(target!, token);
      expect([anchor, result.definition?.uri.toString()]).toEqual([anchor, functionUri.toString()]);
      expect([anchor, result.scopes.map((scope) => scope.name)]).toEqual([anchor, ["direct_user", "use_macro"]]);
    }
  });
});
