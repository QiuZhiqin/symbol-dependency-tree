import { describe, expect, it, vi } from "vitest";
import { QueryCache } from "../../src/services/queryCache";

describe("QueryCache", () => {
  it("creates a value once and reuses it", () => {
    const cache = new QueryCache();
    const factory = vi.fn(() => ({ value: 1 }));

    expect(cache.getOrCreate("key", factory)).toEqual({ value: 1 });
    expect(cache.getOrCreate("key", factory)).toEqual({ value: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("invalidates values by prefix", () => {
    const cache = new QueryCache();
    cache.set("document:a:1", 1);
    cache.set("document:a:2", 2);
    cache.set("references:a", 3);

    cache.deleteByPrefix("document:a:");

    expect(cache.get("document:a:1")).toBeUndefined();
    expect(cache.get("document:a:2")).toBeUndefined();
    expect(cache.get("references:a")).toBe(3);
  });

  it("clears all cached values", () => {
    const cache = new QueryCache();
    cache.set("one", 1);
    cache.clear();
    expect(cache.get("one")).toBeUndefined();
  });
});
