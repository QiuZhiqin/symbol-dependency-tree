import type { GraphReference } from "../model/graphTypes";

export function primaryGraphReference(
  references: readonly GraphReference[]
): GraphReference | undefined {
  return references[0];
}
