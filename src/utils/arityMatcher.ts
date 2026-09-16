/**
 * Arity-based disambiguation for same-name definitions: counts the top-level
 * arguments of the parenthesized list that directly follows a name token —
 * call arguments at a call site or declared parameters at a definition.
 */

function skipWhitespaceAndComments(source: string, index: number): number {
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index + 1 < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    break;
  }
  return index;
}

function countTopLevelArguments(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed === "void") {
    return 0;
  }
  let depth = 0;
  let commas = 0;
  let index = 0;
  while (index < content.length) {
    const char = content[index]!;
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < content.length && content[index] !== quote) {
        if (content[index] === "\\") {
          index += 1;
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      commas += 1;
    }
    index += 1;
  }
  return commas + 1;
}

/**
 * Counts arguments/parameters in the parenthesized list directly following
 * the name token that ends at `nameEnd`. Returns undefined when no
 * parenthesized list follows (e.g. taking an address, a variable use).
 */
export function countArgumentsAfterName(
  source: string,
  nameEnd: number
): number | undefined {
  let index = skipWhitespaceAndComments(source, nameEnd);
  if (source[index] !== "(") {
    return undefined;
  }
  const contentStart = index + 1;
  let depth = 0;
  for (; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return countTopLevelArguments(source.slice(contentStart, index));
      }
    }
  }
  return undefined;
}
