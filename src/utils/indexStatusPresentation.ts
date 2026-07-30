import type { PersistentIndexStatus } from "../services/persistentCallIndex";

export interface IndexStatusPresentation {
  readonly text: string;
  readonly label: string;
  readonly busy: boolean;
  readonly progress?: {
    readonly processed: number;
    readonly total: number;
    readonly percent: number;
  };
}

export function indexStatusPresentation(
  status: PersistentIndexStatus
): IndexStatusPresentation {
  const processed = status.processedFiles ?? 0;
  const total = status.totalFiles ?? 0;
  const progress =
    total > 0
      ? {
          processed,
          total,
          percent: Math.min(100, Math.round((processed * 100) / total))
        }
      : undefined;

  switch (status.phase) {
    case "loading":
      return {
        text: "$(sync~spin) C/C++ index: loading",
        label: "Reading index from disk",
        busy: true
      };
    case "building":
      return {
        text:
          progress === undefined
            ? "$(sync~spin) C/C++ index: scanning"
            : `$(sync~spin) C/C++ index: ${progress.percent}%`,
        label: progress === undefined ? "Scanning workspace" : "Building index",
        busy: true,
        progress
      };
    case "ready":
      return {
        text: "$(database) C/C++ index ready",
        label: "Index ready",
        busy: false
      };
    case "cancelled":
      return {
        text: "$(warning) C/C++ index cancelled",
        label: "Index cancelled",
        busy: false,
        progress
      };
    case "error":
      return {
        text: "$(error) C/C++ index failed",
        label: "Index failed",
        busy: false,
        progress
      };
    case "idle":
      return {
        text: "$(database) C/C++ index: waiting",
        label: "Index not loaded",
        busy: false
      };
  }
}
