import * as vscode from "vscode";

export class AnalysisSession implements vscode.Disposable {
  private source = new vscode.CancellationTokenSource();
  private generation = 0;

  public get token(): vscode.CancellationToken {
    return this.source.token;
  }

  public get currentGeneration(): number {
    return this.generation;
  }

  public renew(): vscode.CancellationToken {
    this.source.cancel();
    this.source.dispose();
    this.source = new vscode.CancellationTokenSource();
    this.generation += 1;
    return this.source.token;
  }

  public cancel(): void {
    this.source.cancel();
    this.generation += 1;
  }

  public isCurrent(generation: number): boolean {
    return generation === this.generation && !this.source.token.isCancellationRequested;
  }

  public dispose(): void {
    this.source.cancel();
    this.source.dispose();
  }
}
