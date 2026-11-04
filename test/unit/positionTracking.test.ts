import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Position {
    public constructor(public readonly line: number, public readonly character: number) {}
  }
  class Range {
    public constructor(public readonly start: Position, public readonly end: Position) {}
  }
  return { Position, Range };
});

import * as vscode from "vscode";
import { trackRange, type TrackedEdit } from "../../src/utils/positionTracking";

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): vscode.Range {
  return new vscode.Range(
    new vscode.Position(startLine, startCharacter),
    new vscode.Position(endLine, endCharacter)
  );
}

function edit(replaced: vscode.Range, text: string): TrackedEdit {
  return { range: replaced, text };
}

function span(tracked: vscode.Range | undefined): number[] | undefined {
  return tracked === undefined
    ? undefined
    : [tracked.start.line, tracked.start.character, tracked.end.line, tracked.end.character];
}

// The name of the tracked symbol sits on line 5, columns 4-10.
const name = range(5, 4, 5, 10);

describe("trackRange", () => {
  it("follows lines inserted or deleted above, with any line breaks", () => {
    expect(span(trackRange(name, [edit(range(1, 0, 1, 0), "a\nb\n")]))).toEqual([7, 4, 7, 10]);
    expect(span(trackRange(name, [edit(range(1, 0, 1, 0), "a\r\nb\r\n")]))).toEqual([7, 4, 7, 10]);
    expect(span(trackRange(name, [edit(range(1, 0, 3, 0), "")]))).toEqual([3, 4, 3, 10]);
  });

  it("follows edits that end on the name's line before it", () => {
    expect(span(trackRange(name, [edit(range(5, 4, 5, 4), "\n")]))).toEqual([6, 0, 6, 6]);
    expect(span(trackRange(name, [edit(range(5, 0, 5, 0), "static ")]))).toEqual([5, 11, 5, 17]);
    expect(span(trackRange(name, [edit(range(4, 3, 5, 0), "")]))).toEqual([4, 7, 4, 13]);
  });

  it("ignores edits after the name, including text typed right after it", () => {
    expect(span(trackRange(name, [edit(range(5, 10, 5, 10), "_x"), edit(range(9, 0, 9, 0), "x\n")])))
      .toEqual([5, 4, 5, 10]);
  });

  it("gives up when an edit replaces text inside the name", () => {
    expect(trackRange(name, [edit(range(5, 6, 5, 8), "zz")])).toBeUndefined();
    expect(trackRange(name, [edit(range(4, 0, 5, 5), "")])).toBeUndefined();
  });

  it("applies the changes of one event in order", () => {
    // VS Code lists multi-cursor changes bottom-up, each relative to the text after the previous one.
    expect(span(trackRange(name, [edit(range(8, 0, 8, 0), "x\n"), edit(range(2, 0, 2, 0), "y\n")])))
      .toEqual([6, 4, 6, 10]);
  });
});
