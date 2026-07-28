import * as vscode from "vscode";
import {
  symbolKey,
  type TargetSymbol
} from "../model/symbolTypes";
import { scanCppFunctionDefinitions } from "../utils/cppFunctionScanner";
import { shortSymbolName } from "../utils/symbolNames";

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

    const definitions = scanCppFunctionDefinitions(document.getText()).filter(
      (definition) => definition.name === name
    );
    const definition = definitions.length === 1 ? definitions[0] : undefined;
    const selectionRange =
      definition === undefined
        ? wordRange
        : new vscode.Range(
            document.positionAt(definition.selectionStart),
            document.positionAt(definition.selectionEnd)
          );
    const range =
      definition === undefined
        ? wordRange
        : new vscode.Range(
            document.positionAt(definition.rangeStart),
            document.positionAt(definition.rangeEnd)
          );
    const location =
      definition === undefined
        ? undefined
        : new vscode.Location(uri, selectionRange);

    return {
      id: symbolKey(uri, selectionRange, name, vscode.SymbolKind.Function),
      name,
      displayName: name,
      kind: vscode.SymbolKind.Function,
      uri,
      range,
      selectionRange,
      definition: location
    };
  }
}
