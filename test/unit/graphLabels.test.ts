import { describe, expect, it } from "vitest";
import { graphNodeLabel } from "../../src/utils/graphLabels";

describe("graph node labels", () => {
  it("shows only the function name and ignores signatures and metadata", () => {
    expect(
      graphNodeLabel({
        name: "project::Widget::render(const Frame&) const",
        displayName: "function • src/widgets/widget.cpp:42"
      })
    ).toBe("render");
  });

  it("preserves operator function names without their parameters", () => {
    expect(
      graphNodeLabel({
        name: "project::Value::operator +=(const Value&)"
      })
    ).toBe("operator +=");
  });
});
