import type { CppFunctionDefinition } from "./cppFunctionScanner";
import {
  dotCallPathMember,
  smartPointerFactories,
  smartPointerTemplates,
  smartPointerType
} from "./smartPointers";
import { blankPreservingLineBreaks, maskCppCommentsAndLiterals } from "./textScanner";

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
  readonly scope?: IndexedSymbolScope;
}

export interface IndexedObjectType {
  readonly name: string;
  readonly offset: number;
  readonly typeName: string;
}

export interface IndexedInheritance {
  readonly derived: string;
  readonly base: string;
}

export interface IndexedVirtualMember {
  readonly owner: string;
  readonly name: string;
}

export interface IndexedTypeDefinition extends CppFunctionDefinition {
  readonly typeKind: "class" | "enum" | "struct" | "union";
}

export interface CppSymbolScopeScan {
  readonly declarations: readonly IndexedSymbolDeclaration[];
  readonly identifiers: readonly ScopedIdentifier[];
  readonly functionOwners: ReadonlyMap<number, string>;
  readonly initializers: readonly IndexedGlobalInitializer[];
  readonly inheritances: readonly IndexedInheritance[];
  readonly objectTypes: readonly IndexedObjectType[];
  readonly types: readonly IndexedTypeDefinition[];
  readonly virtualMembers: readonly IndexedVirtualMember[];
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface TypeRange {
  readonly name: string;
  readonly baseTypes: readonly string[];
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

interface NamespaceRange {
  readonly name: string;
  readonly openBrace: number;
  readonly closeBrace: number;
}

interface LocalDeclaration {
  readonly name: string;
  readonly offset: number;
  readonly scopeStart: number;
  readonly typeName?: string;
  readonly ownerPath?: IndexedMemberOwnerPath;
}

interface ParsedDeclaration {
  readonly name: string;
  readonly offset: number;
  readonly typeName?: string;
  readonly ownerPath?: IndexedMemberOwnerPath;
}

interface InitializerRange extends IndexedGlobalInitializer {
  readonly openTokenIndex: number;
  readonly closeTokenIndex: number;
  readonly containingFunctionSelectionStart?: number;
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
  const parts: string[] = [];
  let copied = 0;
  let lineStart = 0;
  let inDirective = false;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const line = source.slice(lineStart, lineEnd);
    if (inDirective || /^[ \t]*#/u.test(line)) {
      parts.push(source.slice(copied, lineStart), blankPreservingLineBreaks(line));
      copied = lineEnd;
      inDirective = /\\[ \t]*(?:\r?\n)?$/u.test(line);
    } else {
      inDirective = false;
    }
    lineStart = lineEnd;
  }
  parts.push(source.slice(copied));
  return parts.join("");
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

function baseTypeNames(tokens: readonly Token[]): string[] {
  const colon = tokens.findIndex((token) => token.text === ":");
  if (colon < 0) {
    return [];
  }
  const names: string[] = [];
  let candidate: string | undefined;
  let angleDepth = 0;
  for (let index = colon + 1; index <= tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.text === "<") {
      angleDepth += 1;
    } else if (token?.text === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if ((token === undefined || token.text === ",") && angleDepth === 0) {
      if (candidate !== undefined) {
        names.push(candidate);
      }
      candidate = undefined;
    } else if (
      angleDepth === 0 &&
      isIdentifier(token) &&
      !["final", "private", "protected", "public", "virtual"].includes(token.text)
    ) {
      candidate = token.text;
    }
  }
  return names;
}

function trailingTypeName(
  tokens: readonly Token[],
  closeTokenIndex: number
): Token | undefined {
  // `typedef struct { ... } Name;` places the type name after the closing
  // brace, so the header is anonymous and typeTagName finds nothing.
  const candidate = tokens[closeTokenIndex + 1];
  return candidate !== undefined && isIdentifier(candidate) &&
    !typeIntroducers.has(candidate.text)
    ? candidate
    : undefined;
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
    if (
      (keyword.text === "class" || keyword.text === "struct") &&
      tokens[index - 1]?.text === "enum"
    ) {
      continue;
    }
    const headerTokens: Token[] = [];
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token === undefined || token.text === ";") {
        break;
      }
      if (token.text !== "{") {
        headerTokens.push(token);
        continue;
      }
      // `typedef struct { ... } Name;` has an empty header: the brace is the
      // first token after the introducer, and the type name trails the body.
      if (headerTokens.some((headerToken) => headerToken.text === "=")) {
        break;
      }
      const closeTokenIndex = bracePairs.get(cursor);
      const close = closeTokenIndex === undefined ? undefined : tokens[closeTokenIndex];
      const name =
        typeTagName(headerTokens) ??
        trailingTypeName(tokens, closeTokenIndex === undefined ? -1 : closeTokenIndex);
      if (
        name !== undefined &&
        closeTokenIndex !== undefined &&
        close !== undefined
      ) {
        ranges.push({
          name: name.text,
          baseTypes: keyword.text === "enum" ? [] : baseTypeNames(headerTokens),
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

function scanNamespaceRanges(
  tokens: readonly Token[],
  bracePairs: ReadonlyMap<number, number>
): NamespaceRange[] {
  const ranges: NamespaceRange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== "namespace") {
      continue;
    }
    let name: Token | undefined;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token?.text === "=" || token?.text === ";") {
        break;
      }
      if (isIdentifier(token)) {
        name = token;
      }
      if (token?.text !== "{") {
        continue;
      }
      const closeTokenIndex = bracePairs.get(cursor);
      const close = closeTokenIndex === undefined ? undefined : tokens[closeTokenIndex];
      if (name !== undefined && close !== undefined) {
        ranges.push({
          name: name.text,
          openBrace: token.start,
          closeBrace: close.start
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
  typeRanges: readonly TypeRange[],
  namespaceRanges: readonly NamespaceRange[]
): string | undefined {
  const qualified = /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)::\s*$/u.exec(
    source.slice(definition.rangeStart, definition.selectionStart)
  )?.[1];
  const explicitOwner = normalizedOwner(qualified);
  if (explicitOwner !== undefined) {
    return explicitOwner;
  }
  const containingType = typeRanges
    .filter(
      (range) =>
        range.openBrace < definition.selectionStart &&
        definition.selectionStart < range.closeBrace
    )
    .sort(
      (left, right) =>
        left.closeBrace - left.openBrace - (right.closeBrace - right.openBrace)
    )[0]?.name;
  if (containingType !== undefined) {
    return containingType;
  }
  return namespaceRanges
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
    return smartPointerTemplateAt(tokens, index, smartPointerTemplates)?.type ??
      normalizedOwner(token.text);
  }
  return undefined;
}

/**
 * `smart_ptr<T>` for `shared_ptr<T>`, `make_shared<T>` and the like at
 * `index`, with the index of the `>` closing the template. `T` is the last
 * name of the first template argument, so `const ns::T` is `T`.
 */
function smartPointerTemplateAt(
  tokens: readonly Token[],
  index: number,
  names: ReadonlySet<string>
): { readonly type: string; readonly close: number } | undefined {
  if (!names.has(tokens[index]?.text ?? "") || tokens[index + 1]?.text !== "<") {
    return undefined;
  }
  let depth = 0;
  let firstArgument = true;
  let pointee: string | undefined;
  for (let current = index + 2; current < tokens.length; current += 1) {
    const text = tokens[current]!.text;
    if (text === "<") {
      depth += 1;
    } else if (text === ">" || text === ">>") {
      depth -= text.length;
      if (depth < 0) {
        return pointee === undefined
          ? undefined
          : { type: smartPointerType(pointee), close: current };
      }
    } else if (depth === 0 && text === ",") {
      firstArgument = false;
    } else if (
      depth === 0 &&
      firstArgument &&
      isIdentifier(tokens[current]) &&
      !declarationQualifiers.has(text) &&
      !typeIntroducers.has(text)
    ) {
      pointee = text;
    }
  }
  return undefined;
}

/**
 * `auto p = std::make_shared<T>(...)` and similar initializers. The factory
 * call must be the whole initializer: `make_shared<T>()->child()` is not a `T`.
 */
function smartPointerInitializerType(
  tokens: readonly Token[],
  declaratorIndex: number
): string | undefined {
  if (tokens[declaratorIndex + 1]?.text !== "=") {
    return undefined;
  }
  const first = declaratorIndex + 2;
  const callee =
    tokens[first]?.text === "std" && tokens[first + 1]?.text === "::" ? first + 2 : first;
  const template = smartPointerTemplateAt(tokens, callee, smartPointerFactories);
  if (template === undefined || tokens[template.close + 1]?.text !== "(") {
    return undefined;
  }
  let depth = 0;
  for (let current = template.close + 1; current < tokens.length; current += 1) {
    const text = tokens[current]!.text;
    if (text === "(") {
      depth += 1;
    } else if (text === ")") {
      depth -= 1;
      if (depth === 0) {
        return current === tokens.length - 1 ? template.type : undefined;
      }
    }
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

function inferredAutoOwnerPath(
  tokens: readonly Token[],
  declaratorIndex: number
): IndexedMemberOwnerPath | undefined {
  const equals = tokens.findIndex(
    (token, index) => index > declaratorIndex && token.text === "="
  );
  const root = equals < 0 ? undefined : tokens[equals + 1];
  if (!isIdentifier(root)) {
    return undefined;
  }
  const members: string[] = [];
  let calledMember = false;
  let index = equals + 2;
  while (index < tokens.length) {
    const operator = tokens[index]?.text;
    const member = tokens[index + 1];
    if ((operator !== "." && operator !== "->") || !isIdentifier(member)) {
      break;
    }
    index += 2;
    members.push(
      operator === "." && tokens[index]?.text === "("
        ? dotCallPathMember(member.text)
        : member.text
    );
    if (tokens[index]?.text !== "(") {
      continue;
    }
    calledMember = true;
    let depth = 0;
    for (; index < tokens.length; index += 1) {
      if (tokens[index]?.text === "(") {
        depth += 1;
      } else if (tokens[index]?.text === ")") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
  }
  return members.length === 0 || !calledMember || index !== tokens.length
    ? undefined
    : { rootOwner: root.text, members };
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
    ["auto", "&", "&&"].includes(tokens[structuredOpen - 1]?.text ?? "") &&
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
      isIdentifier(tokens[index + 1]) &&
      tokens[index + 2]?.text === ")" &&
      ["(", "[", "=", "{"].includes(tokens[index + 3]?.text ?? "")
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
  const isAuto = tokens
    .slice(0, declaratorIndex)
    .some((token) => token.text === "auto");
  const ownerPath = isAuto
    ? inferredAutoOwnerPath(tokens, declaratorIndex)
    : undefined;
  if (typeName === "auto") {
    typeName = inferredAutoType(tokens, declaratorIndex) ?? typeName;
  }
  if (isAuto && typeName === undefined && ownerPath === undefined) {
    typeName = smartPointerInitializerType(tokens, declaratorIndex);
  }
  const declarations: ParsedDeclaration[] = [
    {
      name: declarator.text,
      offset: declarator.start,
      typeName,
      ...(ownerPath === undefined ? {} : { ownerPath })
    }
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
      if (
        braceDepth === 0 &&
        statement.some((candidate) => candidate.text === ")")
      ) {
        statements.push(statement);
        statement = [];
      }
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

function directEnumDeclarations(
  tokens: readonly Token[],
  range: TypeRange
): ParsedDeclaration[] {
  const declarations: ParsedDeclaration[] = [];
  let segmentStart = range.openTokenIndex + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (
    let index = segmentStart;
    index <= range.closeTokenIndex;
    index += 1
  ) {
    const token = tokens[index];
    const atEnd = index === range.closeTokenIndex;
    const atSeparator =
      token?.text === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0;
    if (atEnd || atSeparator) {
      const name = tokens
        .slice(segmentStart, index)
        .find(isIdentifier);
      if (name !== undefined) {
        declarations.push({
          name: name.text,
          offset: name.start,
          typeName: range.name
        });
      }
      segmentStart = index + 1;
    }
    if (token?.text === "(") {
      parenDepth += 1;
    } else if (token?.text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token?.text === "[") {
      bracketDepth += 1;
    } else if (token?.text === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token?.text === "{") {
      braceDepth += 1;
    } else if (token?.text === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }
  return declarations;
}

function scanInitializers(
  tokens: readonly Token[],
  bracePairs: ReadonlyMap<number, number>,
  definitions: readonly CppFunctionDefinition[],
  typeRanges: readonly TypeRange[]
): InitializerRange[] {
  const initializers: InitializerRange[] = [];
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
    const containingFunction = definitions.find(
      (definition) =>
        definition.rangeStart <= open.start && open.start < definition.rangeEnd
    );

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
      closeTokenIndex,
      ...(containingFunction === undefined
        ? {}
        : {
            containingFunctionSelectionStart: containingFunction.selectionStart,
            scope: {
              kind: "local" as const,
              functionSelectionStart: containingFunction.selectionStart,
              declarationOffset: declaration.offset
            }
          })
    });
  }
  return initializers;
}

function scanFileScopeObjectTypes(
  tokens: readonly Token[],
  bracePairs: ReadonlyMap<number, number>,
  initializers: readonly InitializerRange[],
  namespaceRanges: readonly NamespaceRange[]
): IndexedObjectType[] {
  const declarations: ParsedDeclaration[] = initializers.flatMap((initializer) =>
    initializer.containingFunctionSelectionStart === undefined
      ? [{
          name: initializer.name,
          offset: initializer.selectionStart,
          typeName: initializer.typeName
        }]
      : []
  );
  const namespaceOpens = new Set(namespaceRanges.map((range) => range.openBrace));
  const namespaceCloses = new Set(namespaceRanges.map((range) => range.closeBrace));
  let statementStart = 0;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token?.text === "{") {
      if (namespaceOpens.has(token.start)) {
        statementStart = tokenIndex + 1;
        continue;
      }
      const closeTokenIndex = bracePairs.get(tokenIndex);
      if (closeTokenIndex !== undefined) {
        tokenIndex = closeTokenIndex;
        statementStart = closeTokenIndex + 1;
      }
      continue;
    }
    if (token?.text === "}" && namespaceCloses.has(token.start)) {
      statementStart = tokenIndex + 1;
      continue;
    }
    if (token?.text !== ";") {
      continue;
    }
    declarations.push(...parseDeclarationSegment(tokens.slice(statementStart, tokenIndex)));
    statementStart = tokenIndex + 1;
  }
  return [
    ...new Map(
      declarations.flatMap((declaration) =>
        declaration.typeName === undefined
          ? []
          : [[
              declaration.offset,
              {
                name: declaration.name,
                offset: declaration.offset,
                typeName: declaration.typeName
              } satisfies IndexedObjectType
            ] as const]
      )
    ).values()
  ];
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
): { readonly index: number; readonly isCondition: boolean }[] {
  const starts = new Set<number>();
  const conditions = new Set<number>();
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
      const control = tokens[index - 2]!.text;
      if (control !== "catch") {
        // Only the condition requires a brace-or-equal initializer. Keep
        // for/if/switch init-statements and range-for declarations unchanged.
        let conditionStart = control === "for" ? undefined : index;
        let depth = 0;
        for (let cursor = index; cursor < bodyCloseIndex; cursor += 1) {
          const text = tokens[cursor]!.text;
          if (text === ")" && depth === 0) {
            break;
          }
          if (text === ";" && depth === 0 && (control !== "for" || conditionStart === undefined)) {
            conditionStart = cursor + 1;
          }
          if (["(", "[", "{"].includes(text)) {
            depth += 1;
          } else if ([")", "]", "}"].includes(text)) {
            depth -= 1;
          }
        }
        if (conditionStart !== undefined) {
          conditions.add(conditionStart);
        }
      }
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
  return [...starts]
    .sort((left, right) => left - right)
    .map((index) => ({ index, isCondition: conditions.has(index) }));
}

function declarationSlice(
  tokens: readonly Token[],
  start: number,
  bodyCloseIndex: number
): Token[] {
  const result: Token[] = [];
  let depth = 0;
  for (let index = start; index < bodyCloseIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined || [";", "{", "}"].includes(token.text)) {
      break;
    }
    if (token.text === "(") {
      depth += 1;
    } else if (token.text === ")") {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    }
    result.push(token);
  }
  return result;
}

function hasConditionInitializer(tokens: readonly Token[], declarationOffset: number): boolean {
  let index = tokenIndexAtOrAfter(tokens, declarationOffset) + 1;
  // A function-pointer declarator ends after its closing paren and signature,
  // not immediately after the name: if (int (*fn)(int) = pick()).
  if (
    tokens[index]?.text === ")" &&
    ["*", "&"].includes(tokens[index - 2]?.text ?? "") &&
    tokens[index - 3]?.text === "("
  ) {
    index += 1;
    while (["(", "["].includes(tokens[index]?.text ?? "")) {
      let depth = 1;
      for (index += 1; index < tokens.length && depth > 0; index += 1) {
        const text = tokens[index]!.text;
        if (text === "(" || text === "[") {
          depth += 1;
        } else if (text === ")" || text === "]") {
          depth -= 1;
        }
      }
    }
  }
  // Inspect the original tokens: declarationSlice stops before a braced init.
  return tokens[index]?.text === "=" || tokens[index]?.text === "{";
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

/**
 * Resolves the head of an `auto x = head.member()` path as a receiver at the
 * declaration: `this`, a typed local or another such `auto` local, or else a
 * member of the enclosing class or namespace (`auto p = m_task.lock()` in
 * `C::f` becomes `C.m_task.lock`). A file-scope object stays a name for the
 * query to look up across files.
 */
function rootedOwnerPath(
  local: LocalDeclaration,
  declarations: readonly LocalDeclaration[],
  parents: ReadonlyMap<number, number | undefined>,
  globalTypes: ReadonlyMap<string, string | undefined>,
  methodOwner: string | undefined,
  depth: number
): IndexedMemberOwnerPath {
  const path = local.ownerPath!;
  const head = path.rootOwner;
  if (head === "this") {
    return methodOwner === undefined
      ? path
      : { rootOwner: methodOwner, members: path.members };
  }
  const headLocal = visibleLocal(
    head,
    local.offset - 1,
    local.scopeStart,
    declarations,
    parents
  );
  if (headLocal?.ownerPath !== undefined && depth < 8) {
    const parent = rootedOwnerPath(
      headLocal,
      declarations,
      parents,
      globalTypes,
      methodOwner,
      depth + 1
    );
    return {
      rootOwner: parent.rootOwner,
      members: [...parent.members, ...path.members]
    };
  }
  if (headLocal !== undefined) {
    return headLocal.typeName === undefined
      ? path
      : { rootOwner: headLocal.typeName, members: path.members };
  }
  return globalTypes.has(head) || methodOwner === undefined
    ? path
    : { rootOwner: methodOwner, members: [head, ...path.members] };
}

function ownerPathForReceiver(
  tokens: readonly Token[],
  receiverIndex: number,
  scopeStart: number,
  declarations: readonly LocalDeclaration[],
  parents: ReadonlyMap<number, number | undefined>,
  globalTypes: ReadonlyMap<string, string | undefined>,
  memberTypes: ReadonlyMap<string, string | undefined>,
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
      globalTypes,
      memberTypes,
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
  if (local?.ownerPath !== undefined) {
    return rootedOwnerPath(
      local,
      declarations,
      parents,
      globalTypes,
      methodOwner,
      0
    );
  }
  const declaredOwner =
    local?.typeName ??
    globalTypes.get(receiver.text) ??
    (methodOwner === undefined
      ? undefined
      : memberTypes.get(`${methodOwner}\u0000${receiver.text}`));
  if (declaredOwner !== undefined) {
    return { rootOwner: declaredOwner, members: [] };
  }
  if (local === undefined && methodOwner !== undefined) {
    return { rootOwner: methodOwner, members: [receiver.text] };
  }
  const rootOwner = normalizedOwner(receiver.text);
  return rootOwner === undefined ? undefined : { rootOwner, members: [] };
}

function ownerForExplicitMember(
  tokens: readonly Token[],
  tokenIndex: number,
  scopeStart: number,
  declarations: readonly LocalDeclaration[],
  parents: ReadonlyMap<number, number | undefined>,
  globalTypes: ReadonlyMap<string, string | undefined>,
  memberTypes: ReadonlyMap<string, string | undefined>,
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
    globalTypes,
    memberTypes,
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
  definitions: readonly CppFunctionDefinition[],
  maskedSource = maskCppCommentsAndLiterals(source)
): CppSymbolScopeScan {
  const masked = maskPreprocessorDirectives(maskedSource);
  const tokens = tokenize(masked);
  const braces = matchingTokenIndexes(tokens, "{", "}");
  const parens = matchingTokenIndexes(tokens, "(", ")");
  const typeRanges = scanTypeRanges(tokens, braces.opensToCloses);
  const namespaceRanges = scanNamespaceRanges(tokens, braces.opensToCloses);
  const initializerRanges = scanInitializers(
    tokens,
    braces.opensToCloses,
    definitions,
    typeRanges
  );
  const objectTypes = scanFileScopeObjectTypes(
    tokens,
    braces.opensToCloses,
    initializerRanges,
    namespaceRanges
  );
  const globalTypes = new Map<string, string | undefined>();
  for (const objectType of objectTypes) {
    if (!globalTypes.has(objectType.name)) {
      globalTypes.set(objectType.name, objectType.typeName);
    } else if (globalTypes.get(objectType.name) !== objectType.typeName) {
      globalTypes.set(objectType.name, undefined);
    }
  }
  const functionOwners = new Map<number, string>();
  for (const definition of definitions) {
    const owner = functionOwner(masked, definition, typeRanges, namespaceRanges);
    if (owner !== undefined) {
      functionOwners.set(definition.selectionStart, owner);
    }
  }

  const declarations: IndexedSymbolDeclaration[] = [];
  const virtualMembers: IndexedVirtualMember[] = [];
  for (const range of typeRanges) {
    if (range.typeKind === "enum") {
      for (const declaration of directEnumDeclarations(tokens, range)) {
        declarations.push({
          name: declaration.name,
          offset: declaration.offset,
          scope: { kind: "member", owner: range.name },
          typeName: declaration.typeName
        });
      }
      continue;
    }
    for (const statement of directTypeTokens(tokens, range)) {
      const parsedDeclarations = parseDeclarationSegment(statement);
      for (const declaration of parsedDeclarations) {
        declarations.push({
          name: declaration.name,
          offset: declaration.offset,
          scope: { kind: "member", owner: range.name },
          typeName: declaration.typeName
        });
        if (
          statement.some((token) => token.text === "virtual" || token.text === "override") &&
          statement.some(
            (token, index) =>
              token.start === declaration.offset && statement[index + 1]?.text === "("
          )
        ) {
          virtualMembers.push({ owner: range.name, name: declaration.name });
        }
      }
    }
  }
  const memberTypes = new Map<string, string | undefined>();
  for (const declaration of declarations) {
    if (declaration.scope.kind !== "member") {
      continue;
    }
    const key = `${declaration.scope.owner}\u0000${declaration.name}`;
    if (!memberTypes.has(key)) {
      memberTypes.set(key, declaration.typeName);
    } else if (memberTypes.get(key) !== declaration.typeName) {
      memberTypes.set(key, undefined);
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
    for (const { index: start, isCondition } of declarationStarts(
      tokens,
      bodyOpenIndex,
      bodyCloseIndex,
      parens.closesToOpens
    )) {
      if (
        initializerRanges.some(
          (initializer) =>
            initializer.containingFunctionSelectionStart === definition.selectionStart &&
            initializer.openTokenIndex < start &&
            start < initializer.closeTokenIndex
        )
      ) {
        continue;
      }
      for (const declaration of parseDeclarationSegment(
        declarationSlice(tokens, start, bodyCloseIndex)
      )) {
        if (isCondition && !hasConditionInitializer(tokens, declaration.offset)) {
          continue;
        }
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
        globalTypes,
        memberTypes,
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
    initializers: initializerRanges.map(({
      openTokenIndex: _open,
      closeTokenIndex: _close,
      containingFunctionSelectionStart: _function,
      ...initializer
    }) => initializer),
    inheritances: typeRanges.flatMap((range) =>
      range.baseTypes.map((base) => ({ derived: range.name, base }))
    ),
    objectTypes,
    types: typeRanges.map((range) => ({
      name: range.name,
      typeKind: range.typeKind,
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      selectionStart: range.selectionStart,
      selectionEnd: range.selectionEnd
    })),
    virtualMembers
  };
}
