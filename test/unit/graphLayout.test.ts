import { describe, expect, it } from "vitest";
import {
  layoutVariableWidthGraph,
  type VariableWidthLayoutNode,
  type VariableWidthNodeSize
} from "../../src/utils/graphLayout";

const options = {
  left: 45,
  top: 35,
  right: 45,
  bottom: 35,
  columnGap: 110,
  rowGap: 24
};

function node(
  id: string,
  childIds: readonly string[] = [],
  expanded = true
): VariableWidthLayoutNode {
  return { id, childIds, expanded };
}

describe("variable-width horizontal graph layout", () => {
  it("places the next column after the widest actual box in the previous column", () => {
    const nodes = [
      node("root", ["short", "long"]),
      node("short", ["leaf"]),
      node("long"),
      node("leaf")
    ];
    const sizes = new Map<string, VariableWidthNodeSize>([
      ["root", { width: 91, height: 36 }],
      ["short", { width: 68, height: 36 }],
      ["long", { width: 242, height: 36 }],
      ["leaf", { width: 73, height: 36 }]
    ]);

    const result = layoutVariableWidthGraph("root", nodes, sizes, options);

    expect(result.positions.get("short")?.x).toBe(45 + 91 + 110);
    expect(result.positions.get("leaf")?.x).toBe(45 + 91 + 110 + 242 + 110);
    expect(result.positions.get("root")?.width).toBe(91);
    expect(result.positions.get("long")?.width).toBe(242);
  });

  it("does not reserve space for descendants of a collapsed node", () => {
    const nodes = [
      node("root", ["caller"]),
      node("caller", ["hidden"], false),
      node("hidden")
    ];
    const sizes = new Map<string, VariableWidthNodeSize>([
      ["root", { width: 80, height: 36 }],
      ["caller", { width: 120, height: 36 }],
      ["hidden", { width: 500, height: 36 }]
    ]);

    const result = layoutVariableWidthGraph("root", nodes, sizes, options);

    expect(result.positions.has("hidden")).toBe(false);
    expect(result.width).toBe(45 + 80 + 110 + 120 + 45);
  });
});
