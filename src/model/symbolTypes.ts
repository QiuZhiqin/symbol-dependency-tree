import * as vscode from "vscode";

export type QuerySource = "index";

export interface TargetSymbol {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly kind: vscode.SymbolKind;
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly selectionRange: vscode.Range;
  readonly definition?: vscode.Location;
}

export interface ReferenceHit {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
}

export interface ScopeReference {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly kind: vscode.SymbolKind | "file";
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly selectionRange: vscode.Range;
  readonly references: readonly ReferenceHit[];
  readonly source: QuerySource;
  readonly target?: TargetSymbol;
}

export interface ReferenceQueryResult {
  readonly scopes: readonly ScopeReference[];
}

export interface RootOrigin {
  readonly uri: vscode.Uri;
  readonly position: vscode.Position;
}

export function locationKey(uri: vscode.Uri, range: vscode.Range): string {
  return `${uri.toString()}#${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

export function symbolKey(
  uri: vscode.Uri,
  range: vscode.Range,
  name: string,
  kind: vscode.SymbolKind | "file"
): string {
  return `${locationKey(uri, range)}#${name}#${String(kind)}`;
}
