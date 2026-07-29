import * as vscode from "vscode";
import {
  symbolKey,
  type TargetSymbol
} from "../model/symbolTypes";
import { scanCallIndexFile } from "../utils/callIndexScanner";
import type { IndexedSymbolScope } from "../utils/cppSymbolScopes";
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

export class SymbolResolver {
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

    const name = shortSymbolName(document.getText(wordRange));
    if (name.length === 0) {
      return undefined;
    }

    const source = document.getText();
    const wordOffset = document.offsetAt(wordRange.start);
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
        scope === undefined ? vscode.SymbolKind.Function : vscode.SymbolKind.Method;
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
    const selectionRange =
      definitionOffset === undefined
        ? wordRange
        : new vscode.Range(
            document.positionAt(definitionOffset),
            document.positionAt(definitionOffset + name.length)
          );
    const range = selectionRange;
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
      definitionOffset === undefined
        ? undefined
        : new vscode.Location(uri, selectionRange);

    return {
      id: symbolKey(uri, selectionRange, name, kind),
      name,
      displayName: name,
      kind,
      uri,
      range,
      selectionRange,
      definition: location,
      scope
    };
  }
}
