import {
  scanCppFunctionDefinitions,
  type CppFunctionDefinition
} from "./cppFunctionScanner";
import {
  scanCppSymbolScopes,
  type IndexedInheritance,
  type IndexedMemberOwnerPath,
  type IndexedObjectType,
  type ScopedIdentifier,
  type IndexedSymbolDeclaration,
  type IndexedSymbolScope,
  type IndexedVirtualMember
} from "./cppSymbolScopes";
import { maskCppCommentsAndLiterals } from "./textScanner";

export interface IndexedFunctionDefinition extends CppFunctionDefinition {
  readonly kind: "function" | "initializer" | "type" | "macro";
  readonly isStatic: boolean;
  readonly scope?: IndexedSymbolScope;
  readonly memberOwner?: string;
  readonly typeKind?: "class" | "enum" | "struct" | "union";
}

export interface IndexedCallSite {
  readonly callee: string;
  readonly offset: number;
  readonly kind: "callable" | "symbol";
  readonly scope?: IndexedSymbolScope;
  readonly memberOwnerPath?: IndexedMemberOwnerPath;
  readonly implicitMemberOwner?: string;
  readonly callerName: string;
  readonly callerRangeStart: number;
  readonly callerRangeEnd: number;
  readonly callerSelectionStart: number;
  readonly callerSelectionEnd: number;
}

export interface ScannedCallIndexFile {
  readonly definitions: readonly IndexedFunctionDefinition[];
  readonly calls: readonly IndexedCallSite[];
  readonly declarations: readonly IndexedSymbolDeclaration[];
  readonly inheritances: readonly IndexedInheritance[];
  readonly objectTypes: readonly IndexedObjectType[];
  readonly virtualMembers: readonly IndexedVirtualMember[];
}

const nonCallNames = new Set([
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Imaginary",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
  "alignof",
  "alignas",
  "and",
  "and_eq",
  "asm",
  "auto",
  "bitand",
  "bitor",
  "bool",
  "break",
  "case",
  "catch",
  "char",
  "char8_t",
  "char16_t",
  "char32_t",
  "class",
  "compl",
  "concept",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "const_cast",
  "continue",
  "co_await",
  "co_return",
  "co_yield",
  "decltype",
  "default",
  "delete",
  "do",
  "double",
  "dynamic_cast",
  "else",
  "enum",
  "explicit",
  "export",
  "extern",
  "false",
  "float",
  "for",
  "friend",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "not",
  "not_eq",
  "nullptr",
  "operator",
  "or",
  "or_eq",
  "private",
  "protected",
  "public",
  "register",
  "reinterpret_cast",
  "requires",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "static_cast",
  "struct",
  "switch",
  "template",
  "this",
  "thread_local",
  "throw",
  "true",
  "try",
  "typedef",
  "typeid",
  "typeof",
  "typename",
  "union",
  "unsigned",
  "using",
  "virtual",
  "void",
  "volatile",
  "wchar_t",
  "while",
  "xor",
  "xor_eq"
]);

function neighboringCharacter(
  source: string,
  offset: number,
  direction: -1 | 1
): string | undefined {
  for (
    let index = offset;
    index >= 0 && index < source.length;
    index += direction
  ) {
    const character = source[index];
    if (character !== undefined && !/\s/u.test(character)) {
      return character;
    }
  }
  return undefined;
}

function hasCallParenthesisAfter(
  source: string,
  offset: number
): boolean {
  let cursor = offset;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  if (source[cursor] === "(") {
    return true;
  }
  if (source[cursor] !== "<") {
    return false;
  }
  let depth = 0;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "<") {
      depth += 1;
    } else if (character === ">") {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        while (/\s/u.test(source[cursor] ?? "")) {
          cursor += 1;
        }
        return source[cursor] === "(";
      }
    } else if (depth > 0 && [";", "{", "}"].includes(character ?? "")) {
      return false;
    }
  }
  return false;
}

function qualifiedPrefixStart(source: string, offset: number): number {
  // A non-empty qualifier always ends with "::"; skip the regex otherwise.
  const windowStart = Math.max(0, offset - 192);
  let cursor = offset - 1;
  while (cursor >= windowStart && /\s/u.test(source[cursor]!)) {
    cursor -= 1;
  }
  if (cursor < windowStart || source[cursor] !== ":") {
    return offset;
  }
  const prefix = source.slice(windowStart, offset);
  const qualified = /(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*$/u.exec(prefix)?.[0] ?? "";
  return offset - qualified.length;
}

/**
 * Whether the identifier at `localOffset` of `body` is used as a callable:
 * called, address taken, or registered as a callback.
 */
function isCallableReference(
  body: string,
  localOffset: number,
  callee: string,
  callerKind: IndexedFunctionDefinition["kind"]
): boolean {
  const qualifiedStart = qualifiedPrefixStart(body, localOffset);
  const previous = neighboringCharacter(body, qualifiedStart - 1, -1);
  const next = neighboringCharacter(body, localOffset + callee.length, 1);
  const directCall = hasCallParenthesisAfter(body, localOffset + callee.length);
  const addressTaken = previous === "&";
  const assignedFunction = previous === "=" &&
    (next === "," || next === ";" || (callerKind === "initializer" && next === "}"));
  const positionalInitializerFunction =
    callerKind === "initializer" &&
    (previous === "{" || previous === ",") &&
    (next === "," || next === "}");
  const immediateArgumentOwner =
    previous === "("
      ? /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/u.exec(
          body.slice(Math.max(0, qualifiedStart - 96), qualifiedStart)
        )?.[1]
      : undefined;
  const bareFunctionArgument =
    (next === "," || next === ")") &&
    (previous === "," ||
      (previous === "(" &&
        immediateArgumentOwner !== undefined &&
        !nonCallNames.has(immediateArgumentOwner)));
  return (
    directCall ||
    addressTaken ||
    assignedFunction ||
    positionalInitializerFunction ||
    bareFunctionArgument
  );
}

interface MacroDirective {
  readonly name: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly selectionStart: number;
  /** Where the replacement text starts, after the name and any parameter list. */
  readonly bodyStart: number;
  readonly parameters: ReadonlySet<string>;
}

const macroDirectivePattern =
  /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?/gmu;
const macroBuiltinNames = new Set(["__VA_ARGS__", "__VA_OPT__", "defined"]);

/** `#define` directives of comment-masked source, continuation lines included. */
function scanMacroDirectives(masked: string): MacroDirective[] {
  const lineEnd = (from: number): number => {
    const newline = masked.indexOf("\n", from);
    return newline < 0 ? masked.length : newline;
  };
  const directives: MacroDirective[] = [];
  for (const match of masked.matchAll(macroDirectivePattern)) {
    const name = match[1]!;
    const parameterList = match[2] ?? "";
    const rangeStart = match.index ?? 0;
    const bodyStart = rangeStart + match[0].length;
    let lineStart = rangeStart;
    let end = lineEnd(lineStart);
    while (end < masked.length && /\\[ \t]*\r?$/u.test(masked.slice(lineStart, end))) {
      lineStart = end + 1;
      end = lineEnd(lineStart);
    }
    directives.push({
      name,
      rangeStart,
      rangeEnd: end,
      selectionStart: bodyStart - parameterList.length - name.length,
      bodyStart,
      parameters: new Set(
        parameterList
          .slice(1, -1)
          .split(",")
          .map((parameter) => parameter.replace(/[\s\\]|\.\.\./gu, ""))
      )
    });
  }
  return directives;
}

export function scanCallIndexFile(source: string): ScannedCallIndexFile {
  const masked = maskCppCommentsAndLiterals(source);
  const rawDefinitions = scanCppFunctionDefinitions(source, masked);
  const symbolScopes = scanCppSymbolScopes(source, rawDefinitions, masked);
  const scopedIdentifiers = new Map<number, ScopedIdentifier>();
  for (const declaration of symbolScopes.declarations) {
    scopedIdentifiers.set(declaration.offset, {
      name: declaration.name,
      offset: declaration.offset,
      scope: declaration.scope
    });
  }
  for (const identifier of symbolScopes.identifiers) {
    scopedIdentifiers.set(identifier.offset, identifier);
  }
  const declarationOffsets = new Set(
    symbolScopes.declarations.map((declaration) => declaration.offset)
  );
  const definitions = rawDefinitions.map<IndexedFunctionDefinition>(
    (definition) => ({
      ...definition,
      kind: "function",
      memberOwner: symbolScopes.functionOwners.get(definition.selectionStart),
      isStatic: /\bstatic\b/u.test(
        masked.slice(definition.rangeStart, definition.selectionStart)
      )
    })
  );
  definitions.push(
    ...symbolScopes.initializers.map((initializer) => ({
      ...initializer,
      kind: "initializer" as const,
      isStatic: /\bstatic\b/u.test(
        masked.slice(initializer.rangeStart, initializer.selectionStart)
      )
    }))
  );
  definitions.push(
    ...symbolScopes.types.map((type) => ({
      ...type,
      kind: "type" as const,
      isStatic: false
    }))
  );
  const initializerDefinitions = definitions.filter(
    (definition) => definition.kind === "initializer"
  );
  const calls: IndexedCallSite[] = [];

  for (const caller of definitions) {
    const bodyStart = masked.indexOf("{", caller.selectionEnd);
    if (bodyStart < 0 || bodyStart >= caller.rangeEnd) {
      continue;
    }
    const scanStart = caller.kind === "type" ? bodyStart + 1 : caller.rangeStart;
    const body = masked.slice(scanStart, caller.rangeEnd);
    const referencePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\b/gu;
    for (const match of body.matchAll(referencePattern)) {
      const callee = match[1];
      if (callee === undefined || nonCallNames.has(callee)) {
        continue;
      }
      const localOffset = match.index ?? 0;
      const absoluteOffset = scanStart + localOffset;
      if (
        (caller.selectionStart <= absoluteOffset &&
          absoluteOffset < caller.selectionEnd) ||
        (caller.kind === "type" && declarationOffsets.has(absoluteOffset)) ||
        (caller.kind === "type" &&
          rawDefinitions.some(
            (definition) =>
              definition.rangeStart <= absoluteOffset &&
              absoluteOffset < definition.rangeEnd
          )) ||
        (caller.kind === "function" &&
          initializerDefinitions.some(
            (definition) =>
              caller.rangeStart <= definition.rangeStart &&
              definition.rangeEnd <= caller.rangeEnd &&
              definition.rangeStart <= absoluteOffset &&
              absoluteOffset < definition.rangeEnd
          ))
      ) {
        continue;
      }
      const callable = isCallableReference(body, localOffset, callee, caller.kind);
      const scopedIdentifier = scopedIdentifiers.get(absoluteOffset);
      calls.push({
        callee,
        offset: absoluteOffset,
        kind: callable ? "callable" : "symbol",
        scope: scopedIdentifier?.scope,
        memberOwnerPath: scopedIdentifier?.memberOwnerPath,
        implicitMemberOwner: scopedIdentifier?.implicitMemberOwner,
        callerName: caller.name,
        callerRangeStart: caller.rangeStart,
        callerRangeEnd: caller.rangeEnd,
        callerSelectionStart: caller.selectionStart,
        callerSelectionEnd: caller.selectionEnd
      });
    }
  }

  // A file-scope macro is the caller of what its replacement text references.
  // Directives inside or around code definitions keep their earlier
  // attribution, and macros that reference nothing are not indexed.
  const codeDefinitions = [...definitions];
  for (const macro of scanMacroDirectives(masked)) {
    if (
      codeDefinitions.some(
        (definition) =>
          definition.rangeStart < macro.rangeEnd && macro.rangeStart < definition.rangeEnd
      )
    ) {
      continue;
    }
    const body = masked.slice(macro.bodyStart, macro.rangeEnd);
    const definition: IndexedFunctionDefinition = {
      name: macro.name,
      rangeStart: macro.rangeStart,
      rangeEnd: macro.rangeEnd,
      selectionStart: macro.selectionStart,
      selectionEnd: macro.selectionStart + macro.name.length,
      kind: "macro",
      isStatic: false
    };
    const macroCalls: IndexedCallSite[] = [];
    for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu)) {
      const callee = match[1]!;
      if (nonCallNames.has(callee) || macroBuiltinNames.has(callee) || macro.parameters.has(callee)) {
        continue;
      }
      const localOffset = match.index ?? 0;
      macroCalls.push({
        callee,
        offset: macro.bodyStart + localOffset,
        kind: isCallableReference(body, localOffset, callee, "macro") ? "callable" : "symbol",
        callerName: definition.name,
        callerRangeStart: definition.rangeStart,
        callerRangeEnd: definition.rangeEnd,
        callerSelectionStart: definition.selectionStart,
        callerSelectionEnd: definition.selectionEnd
      });
    }
    if (macroCalls.length > 0) {
      definitions.push(definition);
      calls.push(...macroCalls);
    }
  }

  return {
    definitions,
    calls,
    declarations: symbolScopes.declarations,
    inheritances: symbolScopes.inheritances,
    objectTypes: symbolScopes.objectTypes,
    virtualMembers: symbolScopes.virtualMembers
  };
}
