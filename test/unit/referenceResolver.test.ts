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

interface Deferred<Value> {
  readonly entered: Promise<void>;
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  signalEntered(): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  let signalEntered: () => void = () => undefined;
  let entered = false;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });

  return {
    entered: enteredPromise,
    promise,
    resolve: resolvePromise,
    signalEntered: (): void => {
      if (!entered) {
        entered = true;
        signalEntered();
      }
    }
  };
}

function result(id: string): { readonly scopes: readonly ScopeReference[] } {
  return { scopes: [{ ...indexedCaller, id }] };
}

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

  it("C1: keeps NEW when it completes before the old pre-clear query", async () => {
    const old = deferred<{ readonly scopes: readonly ScopeReference[] }>();
    const current = deferred<{ readonly scopes: readonly ScopeReference[] }>();
    const cache = new QueryCache();
    const query = vi.fn()
      .mockImplementationOnce(() => {
        old.signalEntered();
        return old.promise;
      })
      .mockImplementationOnce(() => {
        current.signalEntered();
        return current.promise;
      });
    const resolver = new ReferenceResolver(
      { query } as unknown as PersistentCallIndex,
      cache
    );

    const oldResolve = resolver.resolve(target, token);
    await old.entered;
    cache.clear();
    const newResolve = resolver.resolve(target, token);
    await current.entered;
    current.resolve(result("new"));
    await expect(newResolve).resolves.toEqual(result("new"));
    old.resolve(result("old"));
    await expect(oldResolve).resolves.toEqual(result("old"));

    expect(query).toHaveBeenCalledTimes(2);
    await expect(resolver.resolve(target, token)).resolves.toEqual(result("new"));
    expect(query).toHaveBeenCalledTimes(2);
    expect(cache.get("index:target")).toEqual(result("new"));
  });

  it("C2: keeps the cache empty when OLD settles before NEW after clear", async () => {
    const old = deferred<{ readonly scopes: readonly ScopeReference[] }>();
    const current = deferred<{ readonly scopes: readonly ScopeReference[] }>();
    const cache = new QueryCache();
    const query = vi.fn()
      .mockImplementationOnce(() => {
        old.signalEntered();
        return old.promise;
      })
      .mockImplementationOnce(() => {
        current.signalEntered();
        return current.promise;
      });
    const resolver = new ReferenceResolver(
      { query } as unknown as PersistentCallIndex,
      cache
    );

    const oldResolve = resolver.resolve(target, token);
    await old.entered;
    cache.clear();
    const newResolve = resolver.resolve(target, token);
    await current.entered;
    old.resolve(result("old"));
    await expect(oldResolve).resolves.toEqual(result("old"));

    expect(query).toHaveBeenCalledTimes(2);
    expect(cache.get("index:target")).toBeUndefined();
    current.resolve(result("new"));
    await expect(newResolve).resolves.toEqual(result("new"));
    expect(cache.get("index:target")).toEqual(result("new"));
  });

  it("C3: returns a cancelled pending result without caching it", async () => {
    const pending = deferred<{ readonly scopes: readonly ScopeReference[] }>();
    const cancellation = { isCancellationRequested: false };
    const cancelledToken = cancellation as vscode.CancellationToken;
    const cache = new QueryCache();
    const query = vi.fn(() => {
      pending.signalEntered();
      return pending.promise;
    });
    const resolver = new ReferenceResolver(
      { query } as unknown as PersistentCallIndex,
      cache
    );

    const resolve = resolver.resolve(target, cancelledToken);
    await pending.entered;
    cancellation.isCancellationRequested = true;
    pending.resolve(result("cancelled"));

    await expect(resolve).resolves.toEqual(result("cancelled"));
    expect(query).toHaveBeenCalledOnce();
    expect(cache.get("index:target")).toBeUndefined();
  });
});
