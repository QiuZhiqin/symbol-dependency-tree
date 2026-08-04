import { describe, expect, it } from "vitest";
import {
  expandReferenceSelection,
  type OffsetSelection
} from "../../src/utils/sourceSelection";

function selection(source: string, symbol: string): OffsetSelection {
  const start = source.indexOf(symbol);
  return expandReferenceSelection(source, start, start + symbol.length);
}

describe("source selection", () => {
  it("selects the complete physical line for a one-line call", () => {
    const source = "  result = operations.send_packet(packet); // dispatch\n";

    const range = selection(source, "send_packet");

    expect(source.slice(range.start, range.end)).toBe(
      "  result = operations.send_packet(packet); // dispatch"
    );
  });

  it("extends a multiline call through its closing semicolon", () => {
    const source = `  return operations.send_packet(
      packet,
      callback("text with )"));
next_statement();
`;

    const range = selection(source, "send_packet");

    expect(source.slice(range.start, range.end)).toBe(`  return operations.send_packet(
      packet,
      callback("text with )"));`);
  });

  it("selects a complete initializer line when the reference is not a call", () => {
    const source = "    .send_packet = driver_send_packet,\n";

    const range = selection(source, "send_packet");

    expect(source.slice(range.start, range.end)).toBe(
      "    .send_packet = driver_send_packet,"
    );
  });
});
