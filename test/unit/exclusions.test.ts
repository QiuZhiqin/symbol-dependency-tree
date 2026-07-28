import { describe, expect, it } from "vitest";
import {
  buildExcludeGlob,
  buildExtensionGlob,
  normalizeExtension
} from "../../src/utils/exclusions";

describe("extension globs", () => {
  it("normalizes extensions and removes duplicates", () => {
    expect(normalizeExtension("CPP")).toBe(".cpp");
    expect(normalizeExtension(".HPP")).toBe(".hpp");
    expect(buildExtensionGlob([".c", "cpp", ".c"])).toBe("**/*.{c,cpp}");
  });

  it("supports an empty extension list", () => {
    expect(buildExtensionGlob([])).toBe("**/*");
  });
});

describe("exclude globs", () => {
  it("combines defaults with enabled VS Code exclusions", () => {
    const glob = buildExcludeGlob(
      { "**/generated/**": true, "**/included/**": false },
      { "**/*.min.cpp": true }
    );

    expect(glob).toContain("**/.git/**");
    expect(glob).toContain("**/generated/**");
    expect(glob).toContain("**/*.min.cpp");
    expect(glob).not.toContain("**/included/**");
  });
});
