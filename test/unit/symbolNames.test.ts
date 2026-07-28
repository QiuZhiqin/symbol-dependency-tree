import { describe, expect, it } from "vitest";
import {
  fullCallableName,
  mostDetailedSymbolName,
  shortSymbolName,
  symbolNameMatches
} from "../../src/utils/symbolNames";

describe("symbol names", () => {
  it("keeps a complete signature for display and a stable identifier for queries", () => {
    expect(shortSymbolName("project::Widget::render(const Frame&) const")).toBe("render");
    expect(symbolNameMatches("project::Widget::render(const Frame&) const", "render")).toBe(true);
  });

  it("preserves operators as lookup names", () => {
    expect(shortSymbolName("project::Value::operator +=(const Value&)")).toBe("operator +=");
  });

  it("combines call hierarchy details without treating source paths as signatures", () => {
    expect(fullCallableName("render", "(const Frame&) const")).toBe(
      "render(const Frame&) const"
    );
    expect(fullCallableName("render", "project::Widget")).toBe(
      "render — project::Widget"
    );
    expect(fullCallableName("render", "src/widget.cpp")).toBe("render");
  });

  it("prefers the most qualified signature available", () => {
    expect(
      mostDetailedSymbolName("render", "render(const Frame&)", "project::Widget::render")
    ).toBe("project::Widget::render");
    expect(
      mostDetailedSymbolName("render", "project::Widget::render(const Frame&) const")
    ).toBe("project::Widget::render(const Frame&) const");
  });
});
