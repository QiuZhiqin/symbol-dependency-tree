import { describe, expect, it } from "vitest";
import type {
  IndexedFileRecord,
  PersistentIndexDocument
} from "../../src/model/persistentIndexTypes";
import {
  decodeCompactCallIndex,
  encodeCompactCallIndex,
  isCompactCallIndex
} from "../../src/utils/compactCallIndex";
import { encodeCompressedJson } from "../../src/utils/compressedJson";

function fixtureFile(): IndexedFileRecord {
  return {
    uri: "file:///workspace/source.cpp",
    mtime: 123456789,
    size: 2048,
    definitions: [
      {
        name: "second",
        rangeStart: 120,
        rangeEnd: 180,
        selectionStart: 125,
        selectionEnd: 131,
        kind: "function",
        isStatic: false,
        memberOwner: "Widget"
      },
      {
        name: "first",
        rangeStart: 10,
        rangeEnd: 80,
        selectionStart: 20,
        selectionEnd: 25,
        kind: "initializer",
        isStatic: true
      }
    ],
    calls: [
      {
        callee: "member",
        offset: 150,
        kind: "symbol",
        scope: { kind: "member", owner: "Widget" },
        memberOwnerPath: {
          rootOwner: "Context",
          members: ["ops", "events"]
        },
        implicitMemberOwner: "Widget",
        callerIndex: 0
      },
      {
        callee: "local_value",
        offset: 35,
        kind: "callable",
        scope: {
          kind: "local",
          functionSelectionStart: 20,
          declarationOffset: 30
        },
        callerIndex: 1
      }
    ],
    memberTypes: [
      { owner: "Context", member: "ops", typeName: "Operations" }
    ]
  };
}

describe("compact call-index persistence", () => {
  it("round-trips every exact scope and offset while remapping sorted callers", () => {
    const document: PersistentIndexDocument = {
      roots: ["file:///workspace", "file:///shared"],
      files: [fixtureFile()],
      deletedUris: ["file:///workspace/deleted.c"]
    };

    const encoded = encodeCompactCallIndex(document);
    expect(isCompactCallIndex(encoded)).toBe(true);
    expect(isCompactCallIndex({ ...encoded, v: 11 })).toBe(false);
    const decoded = decodeCompactCallIndex(encoded);

    expect(decoded.roots).toEqual(document.roots);
    expect(decoded.deletedUris).toEqual(document.deletedUris);
    expect(decoded.files[0]?.definitions.map((definition) => definition.name)).toEqual([
      "first",
      "second"
    ]);
    expect(decoded.files[0]?.calls).toEqual([
      {
        callee: "local_value",
        offset: 35,
        kind: "callable",
        scope: {
          kind: "local",
          functionSelectionStart: 20,
          declarationOffset: 30
        },
        callerIndex: 0
      },
      {
        callee: "member",
        offset: 150,
        kind: "symbol",
        scope: { kind: "member", owner: "Widget" },
        memberOwnerPath: {
          rootOwner: "Context",
          members: ["ops", "events"]
        },
        implicitMemberOwner: "Widget",
        callerIndex: 1
      }
    ]);
  });

  it("is materially smaller than keyed JSON without dropping records", async () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      ...fixtureFile(),
      uri: `file:///workspace/source-${index}.cpp`
    }));
    const compact = await encodeCompressedJson(
      encodeCompactCallIndex({ roots: ["file:///workspace"], files, deletedUris: [] })
    );
    const keyed = await encodeCompressedJson({ version: 10, files });

    expect(compact.bytes.byteLength).toBeLessThan(keyed.bytes.byteLength * 0.8);
  });
});
