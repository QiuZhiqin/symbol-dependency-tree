export interface VariableWidthLayoutNode {
  readonly id: string;
  readonly childIds: readonly string[];
  readonly expanded: boolean;
}

export interface VariableWidthNodeSize {
  readonly width: number;
  readonly height: number;
}

export interface VariableWidthNodePosition extends VariableWidthNodeSize {
  readonly x: number;
  readonly y: number;
}

export interface VariableWidthLayoutOptions {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly columnGap: number;
  readonly rowGap: number;
}

export interface VariableWidthLayoutResult {
  readonly positions: ReadonlyMap<string, VariableWidthNodePosition>;
  readonly width: number;
  readonly height: number;
}

export function layoutVariableWidthGraph(
  rootId: string | undefined,
  nodes: readonly VariableWidthLayoutNode[],
  sizes: ReadonlyMap<string, VariableWidthNodeSize>,
  options: VariableWidthLayoutOptions
): VariableWidthLayoutResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visibleChildren = (node: VariableWidthLayoutNode): VariableWidthLayoutNode[] =>
    node.expanded
      ? node.childIds
          .map((id) => byId.get(id))
          .filter((child): child is VariableWidthLayoutNode => child !== undefined)
      : [];
  const subtreeHeights = new Map<string, number>();
  const subtreeHeight = (id: string): number => {
    const cached = subtreeHeights.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const node = byId.get(id);
    const size = sizes.get(id);
    if (node === undefined || size === undefined) {
      return 0;
    }
    const children = visibleChildren(node);
    const childrenHeight =
      children.reduce((sum, child) => sum + subtreeHeight(child.id), 0) +
      Math.max(0, children.length - 1) * options.rowGap;
    const height = Math.max(size.height, childrenHeight);
    subtreeHeights.set(id, height);
    return height;
  };

  const columnWidths: number[] = [];
  const collectColumns = (id: string, depth: number): void => {
    const node = byId.get(id);
    const size = sizes.get(id);
    if (node === undefined || size === undefined) {
      return;
    }
    columnWidths[depth] = Math.max(columnWidths[depth] ?? 0, size.width);
    for (const child of visibleChildren(node)) {
      collectColumns(child.id, depth + 1);
    }
  };
  if (rootId !== undefined) {
    collectColumns(rootId, 0);
  }

  const columnLefts: number[] = [];
  for (let depth = 0; depth < columnWidths.length; depth += 1) {
    columnLefts[depth] =
      depth === 0
        ? options.left
        : columnLefts[depth - 1]! + columnWidths[depth - 1]! + options.columnGap;
  }

  const positions = new Map<string, VariableWidthNodePosition>();
  const place = (id: string, depth: number, top: number): void => {
    const node = byId.get(id);
    const size = sizes.get(id);
    if (node === undefined || size === undefined) {
      return;
    }
    const branchHeight = subtreeHeight(id);
    positions.set(id, {
      x: columnLefts[depth]!,
      y: options.top + top + (branchHeight - size.height) / 2,
      width: size.width,
      height: size.height
    });
    const children = visibleChildren(node);
    const childrenHeight =
      children.reduce((sum, child) => sum + subtreeHeight(child.id), 0) +
      Math.max(0, children.length - 1) * options.rowGap;
    let childTop = top + (branchHeight - childrenHeight) / 2;
    for (const child of children) {
      place(child.id, depth + 1, childTop);
      childTop += subtreeHeight(child.id) + options.rowGap;
    }
  };
  if (rootId !== undefined) {
    place(rootId, 0, 0);
  }

  const rootHeight = rootId === undefined ? 86 : subtreeHeight(rootId);
  const width = Math.max(
    options.left + options.right,
    ...[...positions.values()].map(
      (position) => position.x + position.width + options.right
    )
  );
  return {
    positions,
    width,
    height: options.top + rootHeight + options.bottom
  };
}
