/** Replaces every UTF-16 code unit except line breaks with a space, so offsets stay aligned. */
export function blankPreservingLineBreaks(text: string): string {
  // No `u` flag: a surrogate pair must become two spaces, not one.
  return text.replace(/[^\r\n]/g, " ");
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
  const parts: string[] = [];
  let copied = 0;
  const mask = (start: number, end: number): void => {
    parts.push(source.slice(copied, start), blankPreservingLineBreaks(source.slice(start, end)));
    copied = end;
  };
  // Jump between the only positions that can open a comment or literal.
  const special = /R"|\/[/*]|["']/gu;
  let index = 0;

  while (index < source.length) {
    special.lastIndex = index;
    const match = special.exec(source);
    if (match === null) {
      break;
    }
    index = match.index;
    const current = source[index];

    if (current === "R") {
      const rawEnd = rawStringEnd(source, index);
      if (rawEnd === undefined) {
        index += 1;
      } else {
        mask(index, rawEnd);
        index = rawEnd;
      }
      continue;
    }

    if (current === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      const stop = end < 0 ? source.length : end;
      mask(index, stop);
      index = stop;
      continue;
    }

    if (current === "/") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      mask(index, stop);
      index = stop;
      continue;
    }

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
    const stop = Math.min(end, source.length);
    mask(index, stop);
    index = stop;
  }

  parts.push(source.slice(copied));
  return parts.join("");
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
