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
    this.item.name = "C/C++ Call Index";
    this.update(initialStatus);
    this.item.show();
  }

  public update(status: PersistentIndexStatus): void {
    const presentation = indexStatusPresentation(status);
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("### C/C++ Call Index\n\n");
    tooltip.appendMarkdown(`Status: **${presentation.label}**\n\n`);
    if (presentation.progress !== undefined) {
      tooltip.appendMarkdown(
        `Progress: **${presentation.progress.processed} / ${presentation.progress.total}** ` +
          `(${presentation.progress.percent}%)\n\n`
      );
    }
    tooltip.appendMarkdown(
      "| Indexed content | Count |\n" +
        "| --- | ---: |\n" +
        `| Files | ${status.stats.files} |\n` +
        `| Functions | ${status.stats.functions} |\n` +
        `| References | ${status.stats.calls} |`
    );
    if (status.detail !== undefined && status.detail.length > 0) {
      tooltip.appendMarkdown("\n\nDetails: ");
      tooltip.appendText(status.detail);
    }
    tooltip.appendMarkdown(
      presentation.busy
        ? "\n\n---\n\nClick this status bar item to force a rebuild after the current indexing task finishes."
        : "\n\n---\n\nClick this status bar item to force an index rebuild."
    );

    this.item.text = presentation.text;
    this.item.tooltip = tooltip;
    this.item.command = presentation.busy ? undefined : rebuildCommand;
    this.item.accessibilityInformation = {
      label: `C/C++ call index, ${presentation.label}`
    };
  }

  public dispose(): void {
    this.item.dispose();
  }
}
