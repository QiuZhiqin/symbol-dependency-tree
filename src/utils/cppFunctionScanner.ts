import { maskCppCommentsAndLiterals } from "./textScanner";

export interface CppFunctionDefinition {
  readonly name: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

const nonFunctionNames = new Set([
  "alignas",
  "catch",
  "decltype",
  "for",
  "if",
  "noexcept",
  "sizeof",
  "static_assert",
  "switch",
  "while"
]);

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}

function skipWhitespaceBackward(source: string, index: number): number {
  let cursor = index;
  while (cursor >= 0 && /\s/u.test(source[cursor] ?? "")) {
    cursor -= 1;
  }
  return cursor;
}

function matchingOpenParen(source: string, closeParen: number): number | undefined {
  let depth = 0;
  for (let index = closeParen; index >= 0; index -= 1) {
    if (source[index] === ")") {
      depth += 1;
    } else if (source[index] === "(") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function matchingCloseBrace(source: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return source.length - 1;
}

function signatureBoundary(source: string, nameStart: number): number {
  let boundary =
    Math.max(
      source.lastIndexOf(";", nameStart - 1),
      source.lastIndexOf("}", nameStart - 1),
      source.lastIndexOf("{", nameStart - 1)
    ) + 1;
  let lineStart = boundary;
  let inDirective = false;
  while (lineStart < nameStart) {
    const nextNewline = source.indexOf("\n", lineStart);
    const lineEnd =
      nextNewline < 0 || nextNewline >= nameStart ? nameStart : nextNewline + 1;
    const line = source.slice(lineStart, lineEnd);
    if (inDirective || /^[ \t]*#/u.test(line)) {
      boundary = lineEnd;
      inDirective = /\\[ \t]*(?:\r?\n)?$/u.test(line);
    }
    lineStart = lineEnd;
  }
  return boundary;
}

function functionBeforeBrace(
  source: string,
  openBrace: number
): Omit<CppFunctionDefinition, "rangeEnd"> | undefined {
  const closeParen = skipWhitespaceBackward(source, openBrace - 1);
  if (source[closeParen] !== ")") {
    return undefined;
  }
  const openParen = matchingOpenParen(source, closeParen);
  if (openParen === undefined) {
    return undefined;
  }

  const nameEnd = skipWhitespaceBackward(source, openParen - 1) + 1;
  let nameStart = nameEnd;
  while (nameStart > 0 && isIdentifierCharacter(source[nameStart - 1])) {
    nameStart -= 1;
  }
  const name = source.slice(nameStart, nameEnd);
  if (name.length === 0 || nonFunctionNames.has(name)) {
    return undefined;
  }

  const rangeStart = signatureBoundary(source, nameStart);
  const signature = source.slice(rangeStart, openBrace);
  if (/^\s*#/mu.test(signature) || /=\s*(?:\[[^\]]*\])?\s*$/u.test(signature)) {
    return undefined;
  }

  return {
    name,
    rangeStart,
    selectionStart: nameStart,
    selectionEnd: nameEnd
  };
}

export function scanCppFunctionDefinitions(source: string): CppFunctionDefinition[] {
  const masked = maskCppCommentsAndLiterals(source);
  const definitions: CppFunctionDefinition[] = [];
  let cursor = 0;

  while (cursor < masked.length) {
    const openBrace = masked.indexOf("{", cursor);
    if (openBrace < 0) {
      break;
    }
    const candidate = functionBeforeBrace(masked, openBrace);
    if (candidate === undefined) {
      cursor = openBrace + 1;
      continue;
    }

    const closeBrace = matchingCloseBrace(masked, openBrace);
    definitions.push({
      ...candidate,
      rangeEnd: Math.min(masked.length, closeBrace + 1)
    });
    cursor = closeBrace + 1;
  }

  return definitions;
}

export function findContainingCppFunction(
  definitions: readonly CppFunctionDefinition[],
  offset: number
): CppFunctionDefinition | undefined {
  return definitions
    .filter((definition) => definition.rangeStart <= offset && offset < definition.rangeEnd)
    .sort(
      (left, right) =>
        left.rangeEnd - left.rangeStart - (right.rangeEnd - right.rangeStart)
    )[0];
}
