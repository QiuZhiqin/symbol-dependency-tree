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
        text: "$(sync~spin) C/C++ 索引：加载中",
        label: "正在读取磁盘索引",
        busy: true
      };
    case "building":
      return {
        text:
          progress === undefined
            ? "$(sync~spin) C/C++ 索引：扫描中"
            : `$(sync~spin) C/C++ 索引：${progress.percent}%`,
        label: progress === undefined ? "正在扫描工作区" : "正在建立索引",
        busy: true,
        progress
      };
    case "ready":
      return {
        text: "$(database) C/C++ 索引就绪",
        label: "索引就绪",
        busy: false
      };
    case "cancelled":
      return {
        text: "$(warning) C/C++ 索引已取消",
        label: "索引已取消",
        busy: false,
        progress
      };
    case "error":
      return {
        text: "$(error) C/C++ 索引失败",
        label: "索引失败",
        busy: false,
        progress
      };
    case "idle":
      return {
        text: "$(database) C/C++ 索引：等待",
        label: "索引尚未加载",
        busy: false
      };
  }
}
