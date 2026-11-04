import * as vscode from "vscode";

/** One content change as VS Code reports it: the replaced range before the change, and its new text. */
export interface TrackedEdit {
  readonly range: vscode.Range;
  readonly text: string;
}

function compare(left: vscode.Position, right: vscode.Position): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

/** Moves a position at or after the end of `edit` to where that text sits afterwards. */
function shiftPosition(position: vscode.Position, edit: TrackedEdit): vscode.Position {
  const lines = edit.text.split(/\r\n|\r|\n/u);
  const insertedBreaks = lines.length - 1;
  const { start, end } = edit.range;
  if (position.line !== end.line) {
    return new vscode.Position(position.line + insertedBreaks - (end.line - start.line), position.character);
  }
  const lastLineStart = insertedBreaks === 0 ? start.character : 0;
  return new vscode.Position(
    start.line + insertedBreaks,
    lastLineStart + lines[insertedBreaks]!.length + position.character - end.character
  );
}

/**
 * Follows a range through the changes of one document event, applied in order
 * the way VS Code applies them. Returns undefined when a change replaced text
 * inside the range, since its new place is then unknown.
 */
export function trackRange(
  range: vscode.Range,
  edits: readonly TrackedEdit[]
): vscode.Range | undefined {
  let current = range;
  for (const edit of edits) {
    if (compare(edit.range.start, current.end) >= 0) {
      continue;
    }
    if (compare(edit.range.end, current.start) > 0) {
      return undefined;
    }
    current = new vscode.Range(shiftPosition(current.start, edit), shiftPosition(current.end, edit));
  }
  return current;
}
