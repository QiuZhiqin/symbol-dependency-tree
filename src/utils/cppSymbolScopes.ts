import type { CppFunctionDefinition } from "./cppFunctionScanner";
import { maskCppCommentsAndLiterals } from "./textScanner";

export type IndexedSymbolScope =
  | {
      readonly kind: "local";
      readonly functionSelectionStart: number;
      readonly declarationOffset: number;
    }
  | {
      readonly kind: "member";
      readonly owner: string;
    };

export interface IndexedMemberOwnerPath {
  readonly rootOwner: string;
  readonly members: readonly string[];
}

export interface IndexedSymbolDeclaration {
  readonly name: string;
  readonly offset: number;
  readonly scope: IndexedSymbolScope;
  readonly typeName?: string;
}

export interface ScopedIdentifier {
  readonly name: string;
  readonly offset: number;
  readonly scope?: IndexedSymbolScope;
  readonly memberOwnerPath?: IndexedMemberOwnerPath;
  readonly implicitMemberOwner?: string;
}

export interface IndexedGlobalInitializer extends CppFunctionDefinition {
  readonly typeName?: string;
}

export interface IndexedTypeDefinition extends CppFunctionDefinition {
  readonly typeKind: "class" | "enum" | "struct" | "union";
}

export interface CppSymbolScopeScan {
  readonly declarations: readonly IndexedSymbolDeclaration[];
  readonly identifiers: readonly ScopedIdentifier[];
  readonly functionOwners: ReadonlyMap<number, string>;
  readonly initializers: readonly IndexedGlobalInitializer[];
  readonly types: readonly IndexedTypeDefinition[];
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface TypeRange {
  readonly name: string;
  readonly typeKind: IndexedTypeDefinition["typeKind"];
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly openBrace: number;
  readonly closeBrace: number;
  readonly openTokenIndex: number;
  readonly closeTokenIndex: number;
}

interface LocalDeclaration {
  readonly name: string;
  readonly offset: number;
  readonly scopeStart: number;
  readonly typeName?: string;
}

interface ParsedDeclaration {
  readonly name: string;
  readonly offset: number;
  readonly typeName?: string;
}

interface GlobalInitializerRange extends IndexedGlobalInitializer {
  readonly openTokenIndex: number;
  readonly closeTokenIndex: number;
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const tokenPattern =
  /[A-Za-z_][A-Za-z0-9_]*|::|->|&&|\+\+|--|==|!=|<=|>=|<<|>>|[{}()[\];,.:*&=<>?+\-/~]/gu;

const declarationQualifiers = new Set([
  "_Atomic",
  "_Thread_local",
  "__attribute__",
  "__declspec",
  "alignas",
  "auto",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "extern",
  "inline",
  "mutable",
  "register",
  "restrict",
  "static",
  "thread_local",
  "volatile"
]);

const declarationRejectors = new Set([
  "break",
  "case",
  "co_return",
  "co_yield",
  "continue",
  "delete",
  "do",
  "else",
  "goto",
  "if",
  "new",
  "return",
  "sizeof",
  "static_assert",
  "switch",
  "throw",
  "typedef",
  "using",
  "while"
]);

const controlNames = new Set(["catch", "for", "if", "switch", "while"]);
const typeIntroducers = new Set(["class", "enum", "struct", "union"]);

function isIdentifier(token: Token | undefined): token is Token {
  return token !== undefined && identifierPattern.test(token.text);
}

function maskPreprocessorDirectives(source: string): string {
  const characters = [...source];
  let lineStart = 0;
  let inDirective = false;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const line = source.slice(lineStart, lineEnd);
    if (inDirective || /^[ \t]*#/u.test(line)) {
      for (let index = lineStart; index < lineEnd; index += 1) {
        if (characters[index] !== "\n" && characters[index] !== "\r") {
          characters[index] = " ";
        }
      }
      inDirective = /\\[ \t]*(?:\r?\n)?$/u.test(line);
    } else {
      inDirective = false;
    }
    lineStart = lineEnd;
  }
  return characters.join("");
}

function tokenize(source: string): Token[] {
  return [...source.matchAll(tokenPattern)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
}

function matchingTokenIndexes(
  tokens: readonly Token[],
  open: string,
  close: string
): { readonly opensToCloses: ReadonlyMap<number, number>; readonly closesToOpens: ReadonlyMap<number, number> } {
  const stack: number[] = [];
  const opensToCloses = new Map<number, number>();
  const closesToOpens = new Map<number, number>();
  tokens.forEach((token, index) => {
    if (token.text === open) {
      stack.push(index);
    } else if (token.text === close) {
      const openIndex = stack.pop();
      if (openIndex !== undefined) {
        opensToCloses.set(openIndex, index);
        closesToOpens.set(index, openIndex);
      }
    }
  });
  return { opensToCloses, closesToOpens };
}

function normalizedOwner(name: string | undefined): string | undefined {
  return name?.match(/[A-Za-z_][A-Za-z0-9_]*$/u)?.[0];
}

function typeTagName(tokens: readonly Token[]): Token | undefined {
  const candidates: Token[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  for (const token of tokens) {
    if (token.text === "(") {
      parenDepth += 1;
      continue;
    }
    if (token.text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (token.text === "[") {
      bracketDepth += 1;
      continue;
    }
    if (token.text === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (parenDepth > 0 || bracketDepth > 0) {
      continue;
    }
    if (token.text === ":") {
      break;
    }
    if (isIdentifier(token)) {
      candidates.push(token);
    }
  }
  const decorationPattern =
    /(?:^__?(?:attribute|declspec|packed|aligned?)__$)|(?:^|_)(?:API|ATTR|ATTRIBUTE|DECLSPEC|EXPORT|IMPORT|PACKED|ALIGNED?)(?:_|$)/iu;
  const decorationNames = new Set([
    "__attribute",
    "__attribute__",
    "__declspec",
    "alignas",
    "final"
  ]);
  return candidates.find(
    (candidate) =>
      !typeIntroducers.has(candidate.text) &&
      !decorationNames.has(candidate.text) &&
      !decorationPattern.test(candidate.text)
  ) ?? candidates[0];
}

function scanTypeRanges(
  tokens: readonly Token[],
  bracePairs: ReadonlyMap<number, number>
): TypeRange[] {
  const ranges: TypeRange[] = [];
  let parenDepth = 0;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const keyword = tokens[index];
    if (keyword?.text === "(") {
      parenDepth += 1;
      continue;
    }
    if (keyword?.text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (
      keyword === undefined ||
      parenDepth > 0 ||
      !typeIntroducers.has(keyword.text)
    ) {
      continue;
    }
    const headerTokens: Token[] = [];
    for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token === undefined || token.text === ";") {
        break;
      }
      if (token.text !== "{") {
        headerTokens.push(token);
        continue;
      }
      const leading = tokens[index + 1];
      if (leading !== undefined) {
        headerTokens.unshift(leading);
      }
      if (headerTokens.some((headerToken) => headerToken.text === "=")) {
        break;
      }
      const name = typeTagName(headerTokens);
      const closeTokenIndex = bracePairs.get(cursor);
      const close = closeTokenIndex === undefined ? undefined : tokens[closeTokenIndex];
      if (
        name !== undefined &&
        closeTokenIndex !== undefined &&
        close !== undefined
      ) {
        ranges.push({
          name: name.text,
          typeKind: keyword.text as IndexedTypeDefinition["typeKind"],
          rangeStart: keyword.start,
          rangeEnd:
            tokens[closeTokenIndex + 1]?.text === ";"
              ? tokens[closeTokenIndex + 1]!.end
              : close.end,
          selectionStart: name.start,
          selectionEnd: name.end,
          openBrace: token.start,
          closeBrace: close.start,
          openTokenIndex: cursor,
          closeTokenIndex
        });
      }
      break;
    }
  }
  return ranges;
}

function functionOwner(
  source: string,
  definition: CppFunctionDefinition,
  typeRanges: readonly TypeRange[]
): string | undefined {
  const qualified = /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)::\s*$/u.exec(
    source.slice(definition.rangeStart, definition.selectionStart)
  )?.[1];
  const explicitOwner = normalizedOwner(qualified);
  if (explicitOwner !== undefined) {
    return explicitOwner;
  }
  return typeRanges
    .filter(
      (range) =>
        range.openBrace < definition.selectionStart &&
        definition.selectionStart < range.closeBrace
    )
    .sort(
      (left, right) =>
        left.closeBrace - left.openBrace - (right.closeBrace - right.openBrace)
    )[0]?.name;
}

function angleDepths(tokens: readonly Token[]): number[] {
  const result: number[] = [];
  let depth = 0;
  tokens.forEach((token, index) => {
    result[index] = depth;
    if (token.text === "<") {
      depth += 1;
    } else if (token.text === ">" && depth > 0) {
      depth -= 1;
    }
  });
  return result;
}

function typeNameBefore(tokens: readonly Token[], nameIndex: number): string | undefined {
  const depths = angleDepths(tokens.slice(0, nameIndex));
  for (let index = nameIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (
      !isIdentifier(token) ||
      declarationQualifiers.has(token.text) ||
      typeIntroducers.has(token.text) ||
      (depths[index] ?? 0) > 0
    ) {
      continue;
    }
    return normalizedOwner(token.text);
  }
  return undefined;
}

function hasTypeEvidence(tokens: readonly Token[], nameIndex: number): boolean {
  for (let index = 0; index < nameIndex; index += 1) {
    const token = tokens[index];
    if (!isIdentifier(token)) {
      continue;
    }
    if (
      index > 0 &&
      (tokens[index - 1]?.text === "." || tokens[index - 1]?.text === "->")
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasTopLevelExpressionOperator(
  tokens: readonly Token[],
  endIndex: number
): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  for (let index = 0; index < endIndex; index += 1) {
    const text = tokens[index]?.text;
    if (text === "(") {
      parenDepth += 1;
    } else if (text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (text === "[") {
      bracketDepth += 1;
    } else if (text === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (text === "<") {
      angleDepth += 1;
    } else if (text === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0 &&
      [
        "=",
        "==",
        "!=",
        "<=",
        ">=",
        ".",
        "->",
        "+",
        "-",
        "/",
        "?",
        "++",
        "--"
      ].includes(text ?? "")
    ) {
      return true;
    }
  }
  return false;
}

function inferredAutoType(
  tokens: readonly Token[],
  declaratorIndex: number
): string | undefined {
  const equals = tokens.findIndex(
    (token, index) => index > declaratorIndex && token.text === "="
  );
  if (equals < 0) {
    return undefined;
  }
  for (let index = equals + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isIdentifier(token) && !declarationQualifiers.has(token.text)) {
      return normalizedOwner(token.text);
    }
  }
  return undefined;
}

function parseDeclarationSegment(rawTokens: readonly Token[]): ParsedDeclaration[] {
  let tokens = [...rawTokens];
  while (
    tokens.length >= 2 &&
    isIdentifier(tokens[0]) &&
    tokens[1]?.text === ":"
  ) {
    tokens = tokens.slice(2);
  }
  const first = tokens[0];
  if (
    first === undefined ||
    declarationRejectors.has(first.text) ||
    controlNames.has(first.text)
  ) {
    return [];
  }

  const structuredOpen = tokens.findIndex((token) => token.text === "[");
  if (
    structuredOpen > 0 &&
    hasTypeEvidence(tokens, structuredOpen) &&
    tokens.slice(0, structuredOpen).some((token) => token.text === "auto")
  ) {
    const close = tokens.findIndex(
      (token, index) => index > structuredOpen && token.text === "]"
    );
    if (close > structuredOpen) {
      return tokens
        .slice(structuredOpen + 1, close)
        .filter(isIdentifier)
        .map((token) => ({
          name: token.text,
          offset: token.start,
          typeName: inferredAutoType(tokens, close)
        }));
    }
  }

  for (let index = 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (
      tokens[index - 1]?.text === "(" &&
      (token?.text === "*" || token?.text === "&") &&
      isIdentifier(tokens[index + 1])
    ) {
      const name = tokens[index + 1]!;
      return [
        {
          name: name.text,
          offset: name.start,
          typeName: typeNameBefore(tokens, index)
        }
      ];
    }
  }

  const depths = angleDepths(tokens);
  let parenDepth = 0;
  let bracketDepth = 0;
  let declaratorIndex: number | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token.text === "(") {
      parenDepth += 1;
      continue;
    }
    if (token.text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (token.text === "[") {
      bracketDepth += 1;
      continue;
    }
    if (token.text === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (
      !isIdentifier(token) ||
      parenDepth > 0 ||
      bracketDepth > 0 ||
      (depths[index] ?? 0) > 0 ||
      declarationQualifiers.has(token.text) ||
      typeIntroducers.has(token.text) ||
      tokens[index - 1]?.text === "::" ||
      tokens[index + 1]?.text === "::" ||
      typeIntroducers.has(tokens[index - 1]?.text ?? "") ||
      !hasTypeEvidence(tokens, index) ||
      hasTopLevelExpressionOperator(tokens, index)
    ) {
      continue;
    }
    const next = tokens[index + 1]?.text;
    if (
      next === undefined ||
      ["=", ",", "[", "{", "(", ":", ")"].includes(next)
    ) {
      declaratorIndex = index;
      break;
    }
  }
  if (declaratorIndex === undefined) {
    return [];
  }

  const declarator = tokens[declaratorIndex]!;
  let typeName = typeNameBefore(tokens, declaratorIndex);
  if (typeName === "auto") {
    typeName = inferredAutoType(tokens, declaratorIndex) ?? typeName;
  }
  const declarations: ParsedDeclaration[] = [
    { name: declarator.text, offset: declarator.start, typeName }
  ];

  parenDepth = 0;
  bracketDepth = 0;
  let braceDepth = 0;
  let declarationSegmentStart: number | undefined;
  for (let index = declaratorIndex + 1; index <= tokens.length; index += 1) {
    const token = tokens[index];
    const text = token?.text;
    if (text === "(") {
      parenDepth += 1;
    } else if (text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (text === "[") {
      bracketDepth += 1;
    } else if (text === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (text === "{") {
      braceDepth += 1;
    } else if (text === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
    const topLevel =
      parenDepth === 0 && bracketDepth === 0 && braceDepth === 0;
    if (topLevel && text === ",") {
      declarationSegmentStart = index + 1;
      continue;
    }
    if (
      declarationSegmentStart !== undefined &&
      (token === undefined || (topLevel && text === "="))
    ) {
      const additional = tokens
        .slice(declarationSegmentStart, index)
        .find(
          (candidate, candidateIndex, values) =>
            isIdentifier(candidate) &&
            values[candidateIndex - 1]?.text !== "::" &&
            values[candidateIndex + 1]?.text !== "::"
        );
      if (additional !== undefined) {
        declarations.push({
          name: additional.text,
          offset: additional.start,
          typeName
        });
      }
      declarationSegmentStart = undefined;
    }
  }
  return declarations;
}

function directTypeTokens(
  tokens: readonly Token[],
  range: TypeRange
): Token[][] {
  const statements: Token[][] = [];
  let statement: Token[] = [];
  let braceDepth = 0;
  for (
    let index = range.openTokenIndex + 1;
    index < range.closeTokenIndex;
    index += 1
  ) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token.text === "{") {
      braceDepth += 1;
      continue;
    }
    if (token.text === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth > 0) {
      continue;
    }
    if (token.text === ";") {
      statements.push(statement);
      statement = [];
    } else {
      statement.push(token);
    }
  }
  return statements;
}

function scanGlobalInitializers(
  tokens: readonly Token[],
  bracePairs: ReadonlyMap<number, number>,
  definitions: readonly CppFunctionDefinition[],
  typeRanges: readonly TypeRange[]
): GlobalInitializerRange[] {
  const initializers: GlobalInitializerRange[] = [];
  for (let openTokenIndex = 0; openTokenIndex < tokens.length; openTokenIndex += 1) {
    const open = tokens[openTokenIndex];
    const equalsIndex = openTokenIndex - 1;
    if (open?.text !== "{" || tokens[equalsIndex]?.text !== "=") {
      continue;
    }
    const closeTokenIndex = bracePairs.get(openTokenIndex);
    const close = closeTokenIndex === undefined ? undefined : tokens[closeTokenIndex];
    if (closeTokenIndex === undefined || close === undefined) {
      continue;
    }
    if (
      definitions.some(
        (definition) =>
          definition.rangeStart <= open.start && open.start < definition.rangeEnd
      ) ||
      typeRanges.some(
        (range) => range.openBrace < open.start && open.start < range.closeBrace
      ) ||
      initializers.some(
        (initializer) =>
          initializer.openTokenIndex < openTokenIndex &&
          openTokenIndex < initializer.closeTokenIndex
      )
    ) {
      continue;
    }

    let declarationStart = equalsIndex - 1;
    while (
      declarationStart >= 0 &&
      ![";", "{", "}"].includes(tokens[declarationStart]?.text ?? "")
    ) {
      declarationStart -= 1;
    }
    const declarationTokens = tokens.slice(declarationStart + 1, equalsIndex);
    const declaration = parseDeclarationSegment(declarationTokens).at(-1);
    if (declaration === undefined) {
      continue;
    }
    const first = declarationTokens[0];
    const semicolon = tokens[closeTokenIndex + 1];
    initializers.push({
      name: declaration.name,
      typeName: declaration.typeName,
      rangeStart: first?.start ?? declaration.offset,
      rangeEnd: semicolon?.text === ";" ? semicolon.end : close.end,
      selectionStart: declaration.offset,
      selectionEnd: declaration.offset + declaration.name.length,
      openTokenIndex,
      closeTokenIndex
    });
  }
  return initializers;
}

function parameterTokens(
  tokens: readonly Token[],
  definition: CppFunctionDefinition,
  parenPairs: ReadonlyMap<number, number>
): Token[][] {
  let openIndex = tokenIndexAtOrAfter(tokens, definition.selectionEnd);
  while (
    openIndex < tokens.length &&
    (tokens[openIndex]?.start ?? definition.rangeEnd) < definition.rangeEnd &&
    tokens[openIndex]?.text !== "("
  ) {
    openIndex += 1;
  }
  const closeIndex = openIndex < 0 ? undefined : parenPairs.get(openIndex);
  if (openIndex >= tokens.length || closeIndex === undefined) {
    return [];
  }
  const segments: Token[][] = [];
  let segment: Token[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (
      token.text === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      segments.push(segment);
      segment = [];
      continue;
    }
    segment.push(token);
    if (token.text === "(") {
      parenDepth += 1;
    } else if (token.text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.text === "[") {
      bracketDepth += 1;
    } else if (token.text === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.text === "<") {
      angleDepth += 1;
    } else if (token.text === ">" && angleDepth > 0) {
      angleDepth -= 1;
    }
  }
  segments.push(segment);
  return segments;
}

function tokenIndexAtOrAfter(tokens: readonly Token[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((tokens[middle]?.start ?? Number.POSITIVE_INFINITY) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function declarationStarts(
  tokens: readonly Token[],
  bodyOpenIndex: number,
  bodyCloseIndex: number,
  parenClosesToOpens: ReadonlyMap<number, number>
): number[] {
  const starts = new Set<number>();
  if (bodyOpenIndex + 1 < bodyCloseIndex) {
    starts.add(bodyOpenIndex + 1);
  }
  for (let index = bodyOpenIndex + 1; index < bodyCloseIndex; index += 1) {
    const previous = tokens[index - 1];
    if (previous?.text === "{" || previous?.text === ";") {
      starts.add(index);
    }
    if (
      previous?.text === "(" &&
      controlNames.has(tokens[index - 2]?.text ?? "")
    ) {
      starts.add(index);
    }
    if (previous?.text === ")") {
      const open = parenClosesToOpens.get(index - 1);
      if (
        open !== undefined &&
        controlNames.has(tokens[open - 1]?.text ?? "")
      ) {
        starts.add(index);
      }
    }
    if (previous?.text === ":") {
      starts.add(index);
    }
  }
  return [...starts].sort((left, right) => left - right);
}

function declarationSlice(
  tokens: readonly Token[],
  start: number,
  bodyCloseIndex: number
): Token[] {
  const result: Token[] = [];
  for (let index = start; index < bodyCloseIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined || [";", "{", "}"].includes(token.text)) {
      break;
    }
    result.push(token);
  }
  return result;
}

function buildLexicalScopes(
  tokens: readonly Token[],
  bodyOpenIndex: number,
  bodyCloseIndex: number
): {
  readonly scopeAtOffset: ReadonlyMap<number, number>;
  readonly parents: ReadonlyMap<number, number | undefined>;
} {
  const root = tokens[bodyOpenIndex]?.start ?? 0;
  const stack = [root];
  const parents = new Map<number, number | undefined>([[root, undefined]]);
  const scopeAtOffset = new Map<number, number>();
  for (let index = bodyOpenIndex + 1; index < bodyCloseIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token.text === "}") {
      stack.pop();
    }
    scopeAtOffset.set(token.start, stack.at(-1) ?? root);
    if (token.text === "{") {
      parents.set(token.start, stack.at(-1));
      stack.push(token.start);
    }
  }
  return { scopeAtOffset, parents };
}

function isAncestorScope(
  ancestor: number,
  descendant: number,
  parents: ReadonlyMap<number, number | undefined>
): boolean {
  let current: number | undefined = descendant;
  while (current !== undefined) {
    if (current === ancestor) {
      return true;
    }
    current = parents.get(current);
  }
  return false;
}

function visibleLocal(
  name: string,
  offset: number,
  scopeStart: number,
  declarations: readonly LocalDeclaration[],
  parents: ReadonlyMap<number, number | undefined>
): LocalDeclaration | undefined {
  return declarations
    .filter(
      (declaration) =>
        declaration.name === name &&
        declaration.offset <= offset &&
        isAncestorScope(declaration.scopeStart, scopeStart, parents)
    )
    .sort((left, right) => right.offset - left.offset)[0];
}

function ownerPathForReceiver(
  tokens: readonly Token[],
  receiverIndex: number,
  scopeStart: number,
  declarations: readonly LocalDeclaration[],
  parents: ReadonlyMap<number, number | undefined>,
  methodOwner: string | undefined
): IndexedMemberOwnerPath | undefined {
  const receiver = tokens[receiverIndex];
  if (!isIdentifier(receiver)) {
    return undefined;
  }
  if (receiver.text === "this") {
    return methodOwner === undefined
      ? undefined
      : { rootOwner: methodOwner, members: [] };
  }
  const nestedOperator = tokens[receiverIndex - 1]?.text;
  if (nestedOperator === "." || nestedOperator === "->") {
    const parent = ownerPathForReceiver(
      tokens,
      receiverIndex - 2,
      scopeStart,
      declarations,
      parents,
      methodOwner
    );
    if (parent !== undefined) {
      return {
        rootOwner: parent.rootOwner,
        members: [...parent.members, receiver.text]
      };
    }
  }
  const local = visibleLocal(
    receiver.text,
    receiver.start,
    scopeStart,
    declarations,
    parents
  );
  const rootOwner = local?.typeName ?? normalizedOwner(receiver.text);
  return rootOwner === undefined ? undefined : { rootOwner, members: [] };
}

function ownerForExplicitMember(
  tokens: readonly Token[],
  tokenIndex: number,
  scopeStart: number,
  declarations: readonly LocalDeclaration[],
  parents: ReadonlyMap<number, number | undefined>,
  methodOwner: string | undefined
): {
  readonly owner: string;
  readonly path?: IndexedMemberOwnerPath;
} | undefined {
  const operator = tokens[tokenIndex - 1]?.text;
  if (operator === "::") {
    const owner = normalizedOwner(tokens[tokenIndex - 2]?.text);
    return owner === undefined ? undefined : { owner };
  }
  if (operator !== "." && operator !== "->") {
    return undefined;
  }
  const path = ownerPathForReceiver(
    tokens,
    tokenIndex - 2,
    scopeStart,
    declarations,
    parents,
    methodOwner
  );
  if (path === undefined) {
    return undefined;
  }
  return {
    owner: path.members.at(-1) ?? path.rootOwner,
    path: path.members.length === 0 ? undefined : path
  };
}

export function scanCppSymbolScopes(
  source: string,
  definitions: readonly CppFunctionDefinition[]
): CppSymbolScopeScan {
  const masked = maskPreprocessorDirectives(maskCppCommentsAndLiterals(source));
  const tokens = tokenize(masked);
  const braces = matchingTokenIndexes(tokens, "{", "}");
  const parens = matchingTokenIndexes(tokens, "(", ")");
  const typeRanges = scanTypeRanges(tokens, braces.opensToCloses);
  const initializerRanges = scanGlobalInitializers(
    tokens,
    braces.opensToCloses,
    definitions,
    typeRanges
  );
  const functionOwners = new Map<number, string>();
  for (const definition of definitions) {
    const owner = functionOwner(masked, definition, typeRanges);
    if (owner !== undefined) {
      functionOwners.set(definition.selectionStart, owner);
    }
  }

  const declarations: IndexedSymbolDeclaration[] = [];
  for (const range of typeRanges) {
    for (const statement of directTypeTokens(tokens, range)) {
      for (const declaration of parseDeclarationSegment(statement)) {
        declarations.push({
          name: declaration.name,
          offset: declaration.offset,
          scope: { kind: "member", owner: range.name },
          typeName: declaration.typeName
        });
      }
    }
  }

  const identifiers: ScopedIdentifier[] = [];
  for (const initializer of initializerRanges) {
    for (
      let tokenIndex = initializer.openTokenIndex + 1;
      tokenIndex < initializer.closeTokenIndex;
      tokenIndex += 1
    ) {
      const token = tokens[tokenIndex];
      if (!isIdentifier(token)) {
        continue;
      }
      const designatedMember =
        tokens[tokenIndex - 1]?.text === "." && initializer.typeName !== undefined;
      identifiers.push({
        name: token.text,
        offset: token.start,
        scope: designatedMember
          ? { kind: "member", owner: initializer.typeName! }
          : undefined
      });
    }
  }
  for (const definition of definitions) {
    let bodyOpenIndex = tokenIndexAtOrAfter(tokens, definition.selectionEnd);
    while (
      bodyOpenIndex < tokens.length &&
      (tokens[bodyOpenIndex]?.start ?? definition.rangeEnd) <
        definition.rangeEnd &&
      tokens[bodyOpenIndex]?.text !== "{"
    ) {
      bodyOpenIndex += 1;
    }
    const bodyCloseIndex =
      bodyOpenIndex >= tokens.length
        ? undefined
        : braces.opensToCloses.get(bodyOpenIndex);
    if (bodyOpenIndex >= tokens.length || bodyCloseIndex === undefined) {
      continue;
    }
    const rootScope = tokens[bodyOpenIndex]?.start ?? definition.selectionEnd;
    const lexical = buildLexicalScopes(tokens, bodyOpenIndex, bodyCloseIndex);
    const locals: LocalDeclaration[] = [];
    for (const segment of parameterTokens(
      tokens,
      definition,
      parens.opensToCloses
    )) {
      for (const declaration of parseDeclarationSegment(segment)) {
        locals.push({ ...declaration, scopeStart: rootScope });
      }
    }
    for (const start of declarationStarts(
      tokens,
      bodyOpenIndex,
      bodyCloseIndex,
      parens.closesToOpens
    )) {
      for (const declaration of parseDeclarationSegment(
        declarationSlice(tokens, start, bodyCloseIndex)
      )) {
        locals.push({
          ...declaration,
          scopeStart:
            lexical.scopeAtOffset.get(declaration.offset) ?? rootScope
        });
      }
    }

    const uniqueLocals = [
      ...new Map(locals.map((declaration) => [declaration.offset, declaration])).values()
    ];
    for (const declaration of uniqueLocals) {
      declarations.push({
        name: declaration.name,
        offset: declaration.offset,
        scope: {
          kind: "local",
          functionSelectionStart: definition.selectionStart,
          declarationOffset: declaration.offset
        }
      });
    }

    const methodOwner = functionOwners.get(definition.selectionStart);
    for (
      let tokenIndex = bodyOpenIndex + 1;
      tokenIndex < bodyCloseIndex;
      tokenIndex += 1
    ) {
      const token = tokens[tokenIndex];
      if (!isIdentifier(token)) {
        continue;
      }
      const scopeStart = lexical.scopeAtOffset.get(token.start) ?? rootScope;
      const explicitOwner = ownerForExplicitMember(
        tokens,
        tokenIndex,
        scopeStart,
        uniqueLocals,
        lexical.parents,
        methodOwner
      );
      if (explicitOwner !== undefined) {
        identifiers.push({
          name: token.text,
          offset: token.start,
          scope: { kind: "member", owner: explicitOwner.owner },
          memberOwnerPath: explicitOwner.path
        });
        continue;
      }
      const local = visibleLocal(
        token.text,
        token.start,
        scopeStart,
        uniqueLocals,
        lexical.parents
      );
      if (local !== undefined) {
        identifiers.push({
          name: token.text,
          offset: token.start,
          scope: {
            kind: "local",
            functionSelectionStart: definition.selectionStart,
            declarationOffset: local.offset
          }
        });
        continue;
      }
      identifiers.push({
        name: token.text,
        offset: token.start,
        implicitMemberOwner: methodOwner
      });
    }
  }

  return {
    declarations,
    identifiers,
    functionOwners,
    initializers: initializerRanges.map(
      ({ openTokenIndex: _open, closeTokenIndex: _close, ...initializer }) =>
        initializer
    ),
    types: typeRanges.map((range) => ({
      name: range.name,
      typeKind: range.typeKind,
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      selectionStart: range.selectionStart,
      selectionEnd: range.selectionEnd
    }))
  };
}
