import { describe, expect, it } from "vitest";
import type { GraphReference } from "../../src/model/graphTypes";
import { primaryGraphReference } from "../../src/utils/graphNavigation";

function reference(uri: string, line: number): GraphReference {
  return {
    uri,
    path: "src/caller.cpp",
    line,
    range: {
      start: { line: line - 1, character: 2 },
      end: { line: line - 1, character: 3 }
    },
    preview: "a();"
  };
}

describe("graph navigation", () => {
  it("uses the first caller reference as the function-name click target", () => {
    const first = reference("file:///src/caller.cpp", 12);
    const second = reference("file:///src/caller.cpp", 28);

    expect(primaryGraphReference([first, second])).toBe(first);
  });

  it("returns no call target for a root node without references", () => {
    expect(primaryGraphReference([])).toBeUndefined();
  });
});
