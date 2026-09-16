import { describe, expect, it } from "vitest";
import { findMacroDefinitionOffset } from "../../src/utils/macroDefinition";

describe("macro definition lookup", () => {
  it("locates an object-like macro definition", () => {
    const source =
      "#define VIRTUAL_BSS_LIMIT 8\nint use() { return VIRTUAL_BSS_LIMIT; }\n";

    const offset = findMacroDefinitionOffset(source, "VIRTUAL_BSS_LIMIT");

    expect(offset).toBe(source.indexOf("VIRTUAL_BSS_LIMIT"));
  });

  it("locates a function-like macro definition with spaced directives", () => {
    const source = "# define MAX(a, b) ((a) > (b) ? (a) : (b))\nint m = MAX(1, 2);\n";

    const offset = findMacroDefinitionOffset(source, "MAX");

    expect(offset).toBe(source.indexOf("MAX"));
  });

  it("does not match similarly named macros or commented-out directives", () => {
    const source = "// #define LIMIT 1\n#define LIMIT_EX 2\n#define LIMIT 3\n";

    const offset = findMacroDefinitionOffset(source, "LIMIT");

    expect(offset).toBe(source.lastIndexOf("LIMIT"));
  });

  it("returns undefined when the name is never defined", () => {
    expect(findMacroDefinitionOffset("int x = LIMIT;\n", "LIMIT")).toBeUndefined();
    expect(findMacroDefinitionOffset("#define OTHER 1\n", "LIMIT")).toBeUndefined();
    expect(findMacroDefinitionOffset("#define LIMIT 1\n", "")).toBeUndefined();
  });
});
