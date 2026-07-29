import * as vscode from "vscode";
import type { PersistentIndexStatus } from "../services/persistentCallIndex";
import { indexStatusPresentation } from "../utils/indexStatusPresentation";

const rebuildCommand = "symbolDependencyTree.rebuildIndex";

export class PersistentIndexStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "symbolDependencyTree.indexStatus",
    vscode.StatusBarAlignment.Right,
    100
  );

  public constructor(initialStatus: PersistentIndexStatus) {
    this.item.name = "C/C++ 调用索引";
    this.update(initialStatus);
    this.item.show();
  }

  public update(status: PersistentIndexStatus): void {
    const presentation = indexStatusPresentation(status);
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("### C/C++ 调用索引\n\n");
    tooltip.appendMarkdown(`状态：**${presentation.label}**\n\n`);
    if (presentation.progress !== undefined) {
      tooltip.appendMarkdown(
        `进度：**${presentation.progress.processed} / ${presentation.progress.total}** ` +
          `（${presentation.progress.percent}%）\n\n`
      );
    }
    tooltip.appendMarkdown(
      "| 索引内容 | 数量 |\n" +
        "| --- | ---: |\n" +
        `| 文件 | ${status.stats.files} |\n` +
        `| 函数 | ${status.stats.functions} |\n` +
        `| 引用 | ${status.stats.calls} |`
    );
    if (status.detail !== undefined && status.detail.length > 0) {
      tooltip.appendMarkdown("\n\n详情：");
      tooltip.appendText(status.detail);
    }
    tooltip.appendMarkdown(
      presentation.busy
        ? "\n\n---\n\n索引任务完成后可点击此状态栏项强制重建。"
        : "\n\n---\n\n点击此状态栏项可强制重建索引。"
    );

    this.item.text = presentation.text;
    this.item.tooltip = tooltip;
    this.item.command = presentation.busy ? undefined : rebuildCommand;
    this.item.accessibilityInformation = {
      label: `C/C++ 调用索引，${presentation.label}`
    };
  }

  public dispose(): void {
    this.item.dispose();
  }
}
