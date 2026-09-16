import { describe, expect, it } from "vitest";
import { countArgumentsAfterName } from "../../src/utils/arityMatcher";

function count(source: string): number | undefined {
  const nameEnd = source.indexOf("TARGET") + "TARGET".length;
  return countArgumentsAfterName(source, nameEnd);
}

describe("countArgumentsAfterName", () => {
  it("counts call arguments", () => {
    expect(count("TARGET(mac, sec, ifname, flags);")).toBe(4);
    expect(count("TARGET(a);")).toBe(1);
  });

  it("counts definition parameters", () => {
    expect(count("TARGET(const char *mac, void *sec) { return 0; }")).toBe(2);
  });

  it("treats empty and void parameter lists as zero", () => {
    expect(count("TARGET() { }")).toBe(0);
    expect(count("TARGET(void) { }")).toBe(0);
  });

  it("ignores commas nested in parentheses, brackets, and braces", () => {
    expect(count("TARGET(cb(a, b), table[1, 2], {1, 2});")).toBe(3);
  });

  it("ignores commas inside string and char literals", () => {
    expect(count('TARGET("a,b", \'x\');')).toBe(2);
  });

  it("returns undefined when no parenthesized list follows", () => {
    expect(count("TARGET = other;")).toBeUndefined();
    expect(count("TARGET;")).toBeUndefined();
  });

  it("skips whitespace and comments before the parenthesis", () => {
    expect(count("TARGET /* comment */ (a, b);")).toBe(2);
    expect(count("TARGET // note\n(a);")).toBe(1);
  });
});
