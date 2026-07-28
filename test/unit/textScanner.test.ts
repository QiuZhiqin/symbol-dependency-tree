import { describe, expect, it } from "vitest";
import { findSymbolOffsets, maskCppCommentsAndLiterals } from "../../src/utils/textScanner";

describe("maskCppCommentsAndLiterals", () => {
  it("masks line comments, block comments, strings, and character literals", () => {
    const source = [
      "int target = 1;",
      "// target should be ignored",
      "const char* text = \"target with \\\\\"escape\\\\\"\";",
      "char value = 't';",
      "/* target",
      "   target */",
      "return target;"
    ].join("\n");

    const masked = maskCppCommentsAndLiterals(source);
    const matches = findSymbolOffsets(masked, "target");

    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(matches).toHaveLength(2);
    expect(matches.map((offset) => source.slice(offset, offset + 6))).toEqual([
      "target",
      "target"
    ]);
  });

  it("masks C++ raw string literals with custom delimiters", () => {
    const source = 'auto text = R"tag(target\\n// target)tag";\ntarget();';
    const masked = maskCppCommentsAndLiterals(source);

    expect(findSymbolOffsets(masked, "target")).toHaveLength(1);
    expect(masked).toHaveLength(source.length);
  });

  it("masks unterminated comments and strings without changing offsets", () => {
    const comment = "target(); /* target";
    const literal = 'target(); "target';

    expect(findSymbolOffsets(maskCppCommentsAndLiterals(comment), "target")).toHaveLength(1);
    expect(findSymbolOffsets(maskCppCommentsAndLiterals(literal), "target")).toHaveLength(1);
  });
});

describe("findSymbolOffsets", () => {
  it("uses C/C++ identifier boundaries", () => {
    const source = "target target_ _target ns::target target2 target";

    expect(findSymbolOffsets(source, "target")).toEqual([0, 27, 42]);
  });

  it("supports operator-like symbols", () => {
    const source = "value += other; operator+= (value);";

    expect(findSymbolOffsets(source, "+=")).toEqual([6, 24]);
  });

  it("honors the result limit and treats zero as unlimited", () => {
    const source = "x x x x";

    expect(findSymbolOffsets(source, "x", 2)).toEqual([0, 2]);
    expect(findSymbolOffsets(source, "x", 0)).toEqual([0, 2, 4, 6]);
  });
});
