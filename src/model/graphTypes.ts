import type { RootOrigin, ScopeReference, TargetSymbol } from "./symbolTypes";

export interface GraphPosition {
  readonly line: number;
  readonly character: number;
}

export interface GraphRange {
  readonly start: GraphPosition;
  readonly end: GraphPosition;
}

export interface GraphReference {
  readonly uri: string;
  readonly path: string;
  readonly line: number;
  readonly range: GraphRange;
  readonly preview: string;
}

export interface GraphNodePayload {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
  readonly root: boolean;
  readonly cycle: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly loading: boolean;
  readonly references: readonly GraphReference[];
  readonly childIds: readonly string[];
  readonly message?: string;
}

export interface GraphNodeMeasurement {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export interface GraphStatePayload {
  readonly rootId?: string;
  readonly nodes: readonly GraphNodePayload[];
  readonly status?: {
    readonly kind: "loading" | "empty" | "error" | "cancelled";
    readonly label: string;
    readonly detail?: string;
  };
}

export interface InternalGraphNode {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
  readonly root: boolean;
  readonly cycle: boolean;
  readonly ancestorIds: ReadonlySet<string>;
  readonly scope?: ScopeReference;
  target?: TargetSymbol;
  references: GraphReference[];
  childIds: string[];
  expandable: boolean;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  message?: string;
}

export interface GraphRoot {
  readonly origin: RootOrigin;
  readonly nodeId: string;
}
