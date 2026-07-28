import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
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
    Module: 1
  }
}));

import type * as vscode from "vscode";
import type {
  ScopeReference,
  TargetSymbol
} from "../../src/model/symbolTypes";
import type { PersistentCallIndex } from "../../src/services/persistentCallIndex";
import { QueryCache } from "../../src/services/queryCache";
import { ReferenceResolver } from "../../src/services/referenceResolver";

const token = { isCancellationRequested: false } as vscode.CancellationToken;
const target = {
  id: "target",
  name: "__sta_info_destroy_part1"
} as TargetSymbol;
const indexedCaller = {
  id: "caller",
  name: "__sta_info_destroy",
  source: "index"
} as ScopeReference;

describe("ReferenceResolver", () => {
  it("uses the persistent call-index database as its only query source", async () => {
    const query = vi.fn(async () => ({
      scopes: [indexedCaller]
    }));
    const resolver = new ReferenceResolver(
      { query } as unknown as PersistentCallIndex,
      new QueryCache()
    );

    const result = await resolver.resolve(target, token);

    expect(query).toHaveBeenCalledOnce();
    expect(result).toEqual({ scopes: [indexedCaller] });
  });

  it("caches database results by target id", async () => {
    const query = vi.fn(async () => ({
      scopes: [indexedCaller]
    }));
    const resolver = new ReferenceResolver(
      { query } as unknown as PersistentCallIndex,
      new QueryCache()
    );

    await resolver.resolve(target, token);
    await resolver.resolve(target, token);

    expect(query).toHaveBeenCalledOnce();
  });
});
