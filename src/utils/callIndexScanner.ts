import {
  scanCppFunctionDefinitions,
  type CppFunctionDefinition
} from "./cppFunctionScanner";
import {
  scanCppSymbolScopes,
  type IndexedSymbolDeclaration,
  type IndexedSymbolScope
} from "./cppSymbolScopes";
import { maskCppCommentsAndLiterals } from "./textScanner";

export interface IndexedFunctionDefinition extends CppFunctionDefinition {
  readonly isStatic: boolean;
  readonly memberOwner?: string;
}

export interface IndexedCallSite {
  readonly callee: string;
  readonly offset: number;
  readonly kind: "callable" | "symbol";
  readonly scope?: IndexedSymbolScope;
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

export function scanCallIndexFile(source: string): ScannedCallIndexFile {
  const masked = maskCppCommentsAndLiterals(source);
  const rawDefinitions = scanCppFunctionDefinitions(source);
  const symbolScopes = scanCppSymbolScopes(source, rawDefinitions);
  const scopedIdentifiers = new Map(
    symbolScopes.identifiers.map((identifier) => [identifier.offset, identifier])
  );
  const definitions = rawDefinitions.map<IndexedFunctionDefinition>(
    (definition) => ({
      ...definition,
      memberOwner: symbolScopes.functionOwners.get(definition.selectionStart),
      isStatic: /\bstatic\b/u.test(
        masked.slice(definition.rangeStart, definition.selectionStart)
      )
    })
  );
  const calls: IndexedCallSite[] = [];

  for (const caller of definitions) {
    const bodyStart = masked.indexOf("{", caller.selectionEnd);
    if (bodyStart < 0 || bodyStart >= caller.rangeEnd) {
      continue;
    }
    const body = masked.slice(bodyStart + 1, caller.rangeEnd - 1);
    const referencePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\b/gu;
    for (const match of body.matchAll(referencePattern)) {
      const callee = match[1];
      if (callee === undefined || nonCallNames.has(callee)) {
        continue;
      }
      const localOffset = match.index ?? 0;
      const previous = neighboringCharacter(body, localOffset - 1, -1);
      const next = neighboringCharacter(body, localOffset + callee.length, 1);
      const directCall = next === "(";
      const addressTaken = previous === "&";
      const assignedFunction = previous === "=" && (next === "," || next === ";");
      const immediateArgumentOwner =
        previous === "("
          ? /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/u.exec(
              body.slice(Math.max(0, localOffset - 96), localOffset)
            )?.[1]
          : undefined;
      const bareFunctionArgument =
        (next === "," || next === ")") &&
        (previous === "," ||
          (previous === "(" &&
            immediateArgumentOwner !== undefined &&
            !nonCallNames.has(immediateArgumentOwner)));
      const callable = directCall || addressTaken || assignedFunction || bareFunctionArgument;
      const scopedIdentifier = scopedIdentifiers.get(
        bodyStart + 1 + localOffset
      );
      calls.push({
        callee,
        offset: bodyStart + 1 + localOffset,
        kind: callable ? "callable" : "symbol",
        scope: scopedIdentifier?.scope,
        implicitMemberOwner: scopedIdentifier?.implicitMemberOwner,
        callerName: caller.name,
        callerRangeStart: caller.rangeStart,
        callerRangeEnd: caller.rangeEnd,
        callerSelectionStart: caller.selectionStart,
        callerSelectionEnd: caller.selectionEnd
      });
    }
  }

  return {
    definitions,
    calls,
    declarations: symbolScopes.declarations
  };
}
