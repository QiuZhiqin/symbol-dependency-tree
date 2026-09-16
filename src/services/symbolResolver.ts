import * as vscode from "vscode";
import {
  symbolKey,
  type TargetSymbol
} from "../model/symbolTypes";
import { scanCallIndexFile } from "../utils/callIndexScanner";
import type { IndexedSymbolScope } from "../utils/cppSymbolScopes";
import { findMacroDefinitionOffset } from "../utils/macroDefinition";
import { shortSymbolName } from "../utils/symbolNames";

function sameScope(
  left: IndexedSymbolScope,
  right: IndexedSymbolScope
): boolean {
  return left.kind === "local" && right.kind === "local"
    ? left.functionSelectionStart === right.functionSelectionStart &&
        left.declarationOffset === right.declarationOffset
    : left.kind === "member" &&
        right.kind === "member" &&
        left.owner === right.owner;
}

export interface MemberDefinitionLookup {
  (
    target: TargetSymbol,
    token: vscode.CancellationToken
  ): Promise<vscode.Location | undefined>;
}

export class SymbolResolver {
  private readonly memberDefinitionLookup: MemberDefinitionLookup | undefined;

  public constructor(memberDefinitionLookup?: MemberDefinitionLookup) {
    this.memberDefinitionLookup = memberDefinitionLookup;
  }

  public async resolveAt(
    uri: vscode.Uri,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<TargetSymbol | undefined> {
    const document = await vscode.workspace.openTextDocument(uri);
    const wordRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_][A-Za-z0-9_]*/u
    );
    if (wordRange === undefined || token.isCancellationRequested) {
      return undefined;
    }

    const source = document.getText();
    const wordOffset = document.offsetAt(wordRange.start);
    const word = document.getText(wordRange);
    const name = shortSymbolName(source[wordOffset - 1] === "~" ? `~${word}` : word);
    if (name.length === 0) {
      return undefined;
    }

    const scanned = scanCallIndexFile(source);
    const exactFunction = scanned.definitions.find(
      (definition) =>
        definition.name === name &&
        definition.selectionStart <= wordOffset &&
        wordOffset < definition.selectionEnd
    );
    if (exactFunction !== undefined) {
      const selectionRange = new vscode.Range(
        document.positionAt(exactFunction.selectionStart),
        document.positionAt(exactFunction.selectionEnd)
      );
      const range = new vscode.Range(
        document.positionAt(exactFunction.rangeStart),
        document.positionAt(exactFunction.rangeEnd)
      );
      const scope =
        exactFunction.memberOwner === undefined
          ? undefined
          : ({
              kind: "member",
              owner: exactFunction.memberOwner
            } satisfies IndexedSymbolScope);
      const kind =
        exactFunction.kind === "initializer"
          ? vscode.SymbolKind.Variable
          : exactFunction.kind === "type"
            ? exactFunction.typeKind === "class"
              ? vscode.SymbolKind.Class
              : exactFunction.typeKind === "enum"
                ? vscode.SymbolKind.Enum
                : vscode.SymbolKind.Struct
            : scope === undefined
              ? vscode.SymbolKind.Function
              : vscode.SymbolKind.Method;
      return {
        id: symbolKey(uri, selectionRange, name, kind),
        name,
        displayName: name,
        kind,
        uri,
        range,
        selectionRange,
        definition: new vscode.Location(uri, selectionRange),
        scope
      };
    }

    const occurrence = scanned.calls.find(
      (call) => call.callee === name && call.offset === wordOffset
    );
    const declared = scanned.declarations.find(
      (declaration) =>
        declaration.name === name && declaration.offset === wordOffset
    );
    const scope =
      occurrence?.scope ??
      declared?.scope ??
      (occurrence?.implicitMemberOwner === undefined
        ? undefined
        : ({
            kind: "member",
            owner: occurrence.implicitMemberOwner
          } satisfies IndexedSymbolScope));
    const declaration =
      scope === undefined
        ? undefined
        : scanned.declarations.find(
            (candidate) =>
              candidate.name === name && sameScope(candidate.scope, scope)
          );
    const definitionOffset =
      scope?.kind === "local"
        ? scope.declarationOffset
        : declaration?.offset;
    const sameFileDefinitions =
      definitionOffset === undefined && scope === undefined
        ? scanned.definitions.filter((definition) => definition.name === name)
        : [];
    const fallbackDefinition =
      sameFileDefinitions.length === 1 ? sameFileDefinitions[0] : undefined;
    const macroOffset =
      definitionOffset === undefined && fallbackDefinition === undefined
        ? findMacroDefinitionOffset(source, name)
        : undefined;
    const selectionRange =
      fallbackDefinition !== undefined
        ? new vscode.Range(
            document.positionAt(fallbackDefinition.selectionStart),
            document.positionAt(fallbackDefinition.selectionEnd)
          )
        : macroOffset !== undefined
          ? new vscode.Range(
              document.positionAt(macroOffset),
              document.positionAt(macroOffset + name.length)
            )
          : definitionOffset === undefined
            ? wordRange
            : new vscode.Range(
                document.positionAt(definitionOffset),
                document.positionAt(definitionOffset + name.length)
              );
    const range =
      fallbackDefinition !== undefined
        ? new vscode.Range(
            document.positionAt(fallbackDefinition.rangeStart),
            document.positionAt(fallbackDefinition.rangeEnd)
          )
        : selectionRange;
    const callable = occurrence?.kind === "callable";
    const kind =
      scope?.kind === "local"
        ? vscode.SymbolKind.Variable
        : scope?.kind === "member"
          ? callable
            ? vscode.SymbolKind.Method
            : vscode.SymbolKind.Field
          : callable
            ? vscode.SymbolKind.Function
            : vscode.SymbolKind.Variable;
    const location =
      fallbackDefinition !== undefined ||
      macroOffset !== undefined ||
      definitionOffset !== undefined
        ? new vscode.Location(uri, selectionRange)
        : undefined;

    const preliminary: TargetSymbol = {
      id: symbolKey(uri, selectionRange, name, kind),
      name,
      displayName: name,
      kind,
      uri,
      range,
      selectionRange,
      definition: location,
      scope,
      memberOwnerPath: occurrence?.memberOwnerPath
    };

    const resolved = { ...preliminary, definition: location };
    if (
      resolved.definition === undefined &&
      resolved.memberOwnerPath !== undefined &&
      this.memberDefinitionLookup !== undefined
    ) {
      const memberDefinition = await this.memberDefinitionLookup(resolved, token);
      if (memberDefinition !== undefined) {
        return {
          ...resolved,
          uri: memberDefinition.uri,
          selectionRange: memberDefinition.range,
          definition: memberDefinition
        };
      }
    }
    return resolved;
  }
}
