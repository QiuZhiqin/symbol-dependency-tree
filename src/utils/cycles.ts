export interface AncestorExtension {
  readonly cycle: boolean;
  readonly ancestorIds: ReadonlySet<string>;
}

export function extendAncestorPath(
  ancestorIds: ReadonlySet<string>,
  symbolId: string
): AncestorExtension {
  const next = new Set(ancestorIds);
  const cycle = next.has(symbolId);
  next.add(symbolId);
  return { cycle, ancestorIds: next };
}
