import { shortSymbolName } from "./symbolNames";

export interface NamedGraphSymbol {
  readonly name: string;
  readonly displayName?: string;
}

export function graphNodeLabel(symbol: NamedGraphSymbol): string {
  return shortSymbolName(symbol.name);
}
