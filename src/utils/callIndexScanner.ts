import {
  scanCppFunctionDefinitions,
  type CppFunctionDefinition
} from "./cppFunctionScanner";
import {
  scanCppSymbolScopes,
  type IndexedMemberOwnerPath,
  type ScopedIdentifier,
  type IndexedSymbolDeclaration,
  type IndexedSymbolScope
} from "./cppSymbolScopes";
import { maskCppCommentsAndLiterals } from "./textScanner";

export interface IndexedFunctionDefinition extends CppFunctionDefinition {
  readonly kind: "function" | "initializer" | "type";
  readonly isStatic: boolean;
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
          ))
      ) {
        continue;
      }
      const previous = neighboringCharacter(body, localOffset - 1, -1);
      const next = neighboringCharacter(body, localOffset + callee.length, 1);
      const directCall = next === "(";
      const addressTaken = previous === "&";
      const assignedFunction = previous === "=" && (next === "," || next === ";");
      const positionalInitializerFunction =
        caller.kind === "initializer" &&
        (previous === "{" || previous === ",") &&
        (next === "," || next === "}");
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
      const callable =
        directCall ||
        addressTaken ||
        assignedFunction ||
        positionalInitializerFunction ||
        bareFunctionArgument;
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

  return {
    definitions,
    calls,
    declarations: symbolScopes.declarations
  };
}
