function maskCharacter(character: string): string {
  return character === "\n" || character === "\r" ? character : " ";
}

function maskSpan(characters: string[], source: string, start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    characters[index] = maskCharacter(source[index] ?? "");
  }
}

function rawStringEnd(source: string, start: number): number | undefined {
  if (source[start] !== "R" || source[start + 1] !== "\"") {
    return undefined;
  }
  const delimiterStart = start + 2;
  const openParen = source.indexOf("(", delimiterStart);
  if (openParen < 0 || openParen - delimiterStart > 16) {
    return undefined;
  }
  const delimiter = source.slice(delimiterStart, openParen);
  if (/[\s\\()]/u.test(delimiter)) {
    return undefined;
  }
  const terminator = `)${delimiter}"`;
  const close = source.indexOf(terminator, openParen + 1);
  return close < 0 ? source.length : close + terminator.length;
}

export function maskCppCommentsAndLiterals(source: string): string {
  const output = [...source];
  let index = 0;

  while (index < source.length) {
    const rawEnd = rawStringEnd(source, index);
    if (rawEnd !== undefined) {
      maskSpan(output, source, index, rawEnd);
      index = rawEnd;
      continue;
    }

    const current = source[index];
    const next = source[index + 1];

    if (current === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      const stop = end < 0 ? source.length : end;
      maskSpan(output, source, index, stop);
      index = stop;
      continue;
    }

    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      maskSpan(output, source, index, stop);
      index = stop;
      continue;
    }

    if (current === "\"" || current === "'") {
      const quote = current;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        end += 1;
        if (source[end - 1] === quote) {
          break;
        }
      }
      maskSpan(output, source, index, Math.min(end, source.length));
      index = Math.min(end, source.length);
      continue;
    }

    index += 1;
  }

  return output.join("");
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}

export function findSymbolOffsets(source: string, symbol: string, limit = 0): number[] {
  if (symbol.length === 0) {
    return [];
  }

  const matches: number[] = [];
  let offset = 0;
  const requireLeftBoundary = isIdentifierCharacter(symbol[0]);
  const requireRightBoundary = isIdentifierCharacter(symbol[symbol.length - 1]);

  while (offset <= source.length - symbol.length) {
    const found = source.indexOf(symbol, offset);
    if (found < 0) {
      break;
    }

    const leftIsValid = !requireLeftBoundary || !isIdentifierCharacter(source[found - 1]);
    const rightIsValid =
      !requireRightBoundary || !isIdentifierCharacter(source[found + symbol.length]);

    if (leftIsValid && rightIsValid) {
      matches.push(found);
      if (limit > 0 && matches.length >= limit) {
        break;
      }
    }
    offset = found + Math.max(1, symbol.length);
  }

  return matches;
}
