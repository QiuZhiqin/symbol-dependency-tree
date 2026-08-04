import { maskCppCommentsAndLiterals } from "./textScanner";

export interface OffsetSelection {
  readonly start: number;
  readonly end: number;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineEnd(source: string, offset: number): number {
  const newline = source.indexOf("\n", offset);
  const end = newline < 0 ? source.length : newline;
  return end > 0 && source[end - 1] === "\r" ? end - 1 : end;
}

function callEnd(masked: string, selectionEnd: number): number | undefined {
  let open = selectionEnd;
  while (/\s/u.test(masked[open] ?? "")) {
    open += 1;
  }
  if (masked[open] !== "(") {
    return undefined;
  }
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "(") {
      depth += 1;
    } else if (masked[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        while (/\s/u.test(masked[end] ?? "")) {
          end += 1;
        }
        return masked[end] === ";" ? end + 1 : index + 1;
      }
    }
  }
  return undefined;
}

export function expandReferenceSelection(
  source: string,
  selectionStart: number,
  selectionEnd: number
): OffsetSelection {
  const start = Math.max(0, Math.min(selectionStart, source.length));
  const end = Math.max(start, Math.min(selectionEnd, source.length));
  const physicalLineEnd = lineEnd(source, end);
  const expandedCallEnd = callEnd(maskCppCommentsAndLiterals(source), end);
  return {
    start: lineStart(source, start),
    end: Math.max(physicalLineEnd, expandedCallEnd ?? physicalLineEnd)
  };
}
