import { describe, expect, it } from "vitest";
import { extendAncestorPath } from "../../src/utils/cycles";

describe("extendAncestorPath", () => {
  it("marks only symbols already present on the current path as cycles", () => {
    const rootPath = new Set(["root"]);
    const child = extendAncestorPath(rootPath, "child");
    const recursive = extendAncestorPath(child.ancestorIds, "root");

    expect(child.cycle).toBe(false);
    expect(recursive.cycle).toBe(true);
    expect(rootPath.has("child")).toBe(false);
  });

  it("allows the same symbol in independent branches", () => {
    const rootPath = new Set(["root"]);
    const left = extendAncestorPath(rootPath, "shared");
    const right = extendAncestorPath(rootPath, "shared");

    expect(left.cycle).toBe(false);
    expect(right.cycle).toBe(false);
    expect(left.ancestorIds).not.toBe(right.ancestorIds);
  });
});
