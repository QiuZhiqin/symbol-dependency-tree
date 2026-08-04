import * as vscode from "vscode";
import type {
  GraphNodePayload,
  GraphNodeMeasurement,
  GraphRange,
  GraphReference,
  GraphRoot,
  GraphStatePayload,
  InternalGraphNode
} from "../model/graphTypes";
import type { ReferenceHit, RootOrigin, ScopeReference, TargetSymbol } from "../model/symbolTypes";
import { ReferenceResolver } from "../services/referenceResolver";
import { QueryCache } from "../services/queryCache";
import { AnalysisSession } from "../utils/cancellation";
import { extendAncestorPath } from "../utils/cycles";
import { graphNodeLabel } from "../utils/graphLabels";
import { layoutVariableWidthGraph } from "../utils/graphLayout";
import { primaryGraphReference } from "../utils/graphNavigation";
import { expandReferenceSelection } from "../utils/sourceSelection";

type GraphStatus = GraphStatePayload["status"];

interface WebviewMessage {
  readonly type:
    | "expand"
    | "collapse"
    | "openReference"
    | "openCallSite"
    | "openNode"
    | "layoutMeasured"
    | "selectTab"
    | "closeTab";
  readonly tabId?: string;
  readonly nodeId?: string;
  readonly uri?: string;
  readonly range?: GraphRange;
  readonly measurements?: readonly GraphNodeMeasurement[];
}

interface GraphDocument {
  readonly id: string;
  readonly title: string;
  readonly session: AnalysisSession;
  readonly nodes: Map<string, InternalGraphNode>;
  root?: GraphRoot;
  status?: GraphStatus;
  nodeSequence: number;
  measurements: readonly GraphNodeMeasurement[];
}

export interface GraphTabSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: GraphStatePayload;
  readonly measurements: readonly GraphNodeMeasurement[];
}

function nonce(): string {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}

function graphRange(range: vscode.Range): GraphRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function vscodeRange(range: GraphRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

export class SymbolDependencyGraphViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private readonly documents = new Map<string, GraphDocument>();
  private readonly documentOrder: string[] = [];
  private view: vscode.WebviewView | undefined;
  private activeDocumentId: string | undefined;
  private documentSequence = 0;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly references: ReferenceResolver,
    private readonly cache: QueryCache,
    private readonly output: vscode.OutputChannel
  ) {}

  public get origin(): RootOrigin | undefined {
    return this.activeDocument()?.root?.origin;
  }

  public snapshot(): GraphStatePayload {
    return this.snapshotFor(this.activeDocument());
  }

  public graphTabs(): readonly GraphTabSnapshot[] {
    return this.documentOrder.flatMap((id) => {
      const document = this.documents.get(id);
      return document === undefined
        ? []
        : [{
            id: document.id,
            title: document.title,
            state: this.snapshotFor(document),
            measurements: document.measurements
          }];
    });
  }

  private snapshotFor(document: GraphDocument | undefined): GraphStatePayload {
    if (document === undefined) {
      return { nodes: [] };
    }
    return {
      rootId: document.root?.nodeId,
      nodes: [...document.nodes.values()].map((node) => this.payload(node)),
      status: document.status
    };
  }

  public layoutMeasurements(): readonly GraphNodeMeasurement[] {
    return this.activeDocument()?.measurements ?? [];
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void this.handleMessage(message);
      },
      undefined
    );
    this.postState();
  }

  public async addRoot(target: TargetSymbol, origin: RootOrigin): Promise<void> {
    this.documentSequence += 1;
    const id = `tab:${this.documentSequence}`;
    const document: GraphDocument = {
      id,
      title: target.name,
      session: new AnalysisSession(),
      nodes: new Map(),
      status: { kind: "loading", label: `Indexing references to ${target.name}…` },
      nodeSequence: 0,
      measurements: []
    };
    this.documents.set(id, document);
    this.documentOrder.push(id);
    this.activeDocumentId = id;
    this.postState();

    const rootId = this.nextNodeId(document, "root");
    const node: InternalGraphNode = {
      id: rootId,
      label: graphNodeLabel(target),
      root: true,
      cycle: false,
      ancestorIds: new Set([target.id]),
      target,
      references: [],
      childIds: [],
      expandable: true,
      expanded: true,
      loading: false,
      loaded: false
    };
    document.nodes.set(rootId, node);
    document.root = { origin, nodeId: rootId };
    document.status = undefined;
    this.postState();
    await this.expandNode(document, rootId);
  }

  public setStatus(
    kind: NonNullable<GraphStatus>["kind"],
    label: string,
    detail?: string
  ): void {
    const document = this.activeDocument();
    if (document === undefined) {
      return;
    }
    document.session.cancel();
    document.nodes.clear();
    document.root = undefined;
    document.status = { kind, label, detail };
    this.postState();
  }

  public clear(): void {
    if (this.activeDocumentId !== undefined) {
      this.closeDocument(this.activeDocumentId);
    }
  }

  private closeDocument(id: string): void {
    const document = this.documents.get(id);
    if (document === undefined) {
      return;
    }
    document.session.dispose();
    this.documents.delete(id);
    const index = this.documentOrder.indexOf(id);
    if (index >= 0) {
      this.documentOrder.splice(index, 1);
    }
    if (this.activeDocumentId === id) {
      this.activeDocumentId =
        this.documentOrder[Math.min(index, this.documentOrder.length - 1)] ??
        this.documentOrder.at(-1);
    }
    this.postState();
  }

  public async invalidate(): Promise<void> {
    this.cache.clear();
    const document = this.activeDocument();
    if (document !== undefined) {
      await this.invalidateDocument(document);
    }
  }

  public async invalidateAll(): Promise<void> {
    this.cache.clear();
    await Promise.all(
      this.documentOrder.flatMap((id) => {
        const document = this.documents.get(id);
        return document === undefined ? [] : [this.invalidateDocument(document)];
      })
    );
  }

  public async invalidateUri(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    await Promise.all(
      this.documentOrder.flatMap((id) => {
        const document = this.documents.get(id);
        return document?.root?.origin.uri.toString() === key
          ? [this.invalidateDocument(document)]
          : [];
      })
    );
  }

  public markDeletedUri(uri: vscode.Uri): void {
    const key = uri.toString();
    for (const document of this.documents.values()) {
      if (document.root?.origin.uri.toString() !== key) {
        continue;
      }
      document.session.cancel();
      document.nodes.clear();
      document.root = undefined;
      document.status = { kind: "error", label: "The root source file was deleted" };
    }
    this.postState();
  }

  private async invalidateDocument(document: GraphDocument): Promise<void> {
    document.session.renew();
    const rootId = document.root?.nodeId;
    if (rootId === undefined) {
      return;
    }
    const rootNode = document.nodes.get(rootId);
    if (rootNode === undefined) {
      return;
    }
    document.nodes.clear();
    rootNode.childIds = [];
    rootNode.loaded = false;
    rootNode.loading = false;
    rootNode.message = undefined;
    document.nodes.set(rootId, rootNode);
    this.postState();
    await this.expandNode(document, rootId);
  }

  public collapseAll(): void {
    const document = this.activeDocument();
    if (document === undefined) {
      return;
    }
    for (const node of document.nodes.values()) {
      node.expanded = false;
    }
    this.postState();
  }

  private activeDocument(): GraphDocument | undefined {
    return this.activeDocumentId === undefined
      ? undefined
      : this.documents.get(this.activeDocumentId);
  }

  private nextNodeId(document: GraphDocument, prefix: string): string {
    document.nodeSequence += 1;
    return `${document.id}:${prefix}:${document.nodeSequence}`;
  }

  private removeDescendants(document: GraphDocument, node: InternalGraphNode): void {
    for (const childId of node.childIds) {
      const child = document.nodes.get(childId);
      if (child !== undefined) {
        this.removeDescendants(document, child);
      }
      document.nodes.delete(childId);
    }
    node.childIds = [];
  }

  private async expandNode(document: GraphDocument, nodeId: string): Promise<void> {
    const node = document.nodes.get(nodeId);
    if (node === undefined || node.cycle || node.target === undefined) {
      return;
    }
    node.expanded = true;
    if (node.loaded) {
      this.postState();
      return;
    }
    if (node.loading) {
      return;
    }

    node.loading = true;
    node.message = undefined;
    this.postState();
    const generation = document.session.currentGeneration;
    try {
      const result = await this.references.resolve(node.target, document.session.token);
      if (!document.session.isCurrent(generation)) {
        return;
      }

      this.removeDescendants(document, node);
      for (const scope of result.scopes) {
        const path = extendAncestorPath(node.ancestorIds, scope.id);
        const childId = this.nextNodeId(document, "node");
        const child: InternalGraphNode = {
          id: childId,
          parentId: node.id,
          label: graphNodeLabel(scope),
          root: false,
          cycle: path.cycle,
          ancestorIds: path.ancestorIds,
          scope,
          target: scope.target,
          references: await this.referencePayloads(scope),
          childIds: [],
          expandable: scope.target !== undefined && !path.cycle,
          expanded: false,
          loading: false,
          loaded: false
        };
        document.nodes.set(childId, child);
        node.childIds.push(childId);
      }

      node.loaded = true;
      if (result.scopes.length === 0) {
        node.message = "No indexed references found in the symbol database";
      }
    } catch (error) {
      node.loaded = true;
      node.message = `Unable to load branch: ${String(error)}`;
      this.output.appendLine(`Graph expansion failed for ${node.label}: ${String(error)}`);
    } finally {
      node.loading = false;
      this.postState();
    }
  }

  private async referencePayloads(scope: ScopeReference): Promise<GraphReference[]> {
    return Promise.all(scope.references.map((hit) => this.referencePayload(hit)));
  }

  private async referencePayload(hit: ReferenceHit): Promise<GraphReference> {
    let preview = "File is unavailable";
    let range = hit.range;
    try {
      const document = await vscode.workspace.openTextDocument(hit.uri);
      preview = document.lineAt(hit.range.start.line).text.trim();
      const expanded = expandReferenceSelection(
        document.getText(),
        document.offsetAt(hit.range.start),
        document.offsetAt(hit.range.end)
      );
      range = new vscode.Range(
        document.positionAt(expanded.start),
        document.positionAt(expanded.end)
      );
    } catch (error) {
      this.output.appendLine(`Unable to read ${hit.uri.toString()}: ${String(error)}`);
    }
    return {
      uri: hit.uri.toString(),
      path: vscode.workspace.asRelativePath(hit.uri, false),
      line: hit.range.start.line + 1,
      range: graphRange(range),
      preview
    };
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "selectTab") {
      if (message.tabId !== undefined && this.documents.has(message.tabId)) {
        this.activeDocumentId = message.tabId;
        this.postState();
      }
      return;
    }
    if (message.type === "closeTab") {
      if (message.tabId !== undefined) {
        this.closeDocument(message.tabId);
      }
      return;
    }
    const document =
      (message.tabId === undefined ? undefined : this.documents.get(message.tabId)) ??
      this.activeDocument();
    if (document === undefined) {
      return;
    }
    switch (message.type) {
      case "expand":
        if (message.nodeId !== undefined) {
          await this.expandNode(document, message.nodeId);
        }
        break;
      case "collapse": {
        const node =
          message.nodeId === undefined ? undefined : document.nodes.get(message.nodeId);
        if (node !== undefined) {
          node.expanded = false;
          this.postState();
        }
        break;
      }
      case "openReference":
        if (message.uri !== undefined && message.range !== undefined) {
          await this.openLocation(vscode.Uri.parse(message.uri), vscodeRange(message.range));
        }
        break;
      case "openCallSite": {
        const node =
          message.nodeId === undefined ? undefined : document.nodes.get(message.nodeId);
        const reference = primaryGraphReference(node?.references ?? []);
        if (reference !== undefined) {
          await this.openLocation(vscode.Uri.parse(reference.uri), vscodeRange(reference.range));
        } else if (node?.target !== undefined) {
          await this.openLocation(node.target.uri, node.target.selectionRange);
        }
        break;
      }
      case "openNode": {
        const node =
          message.nodeId === undefined ? undefined : document.nodes.get(message.nodeId);
        const target = node?.target;
        if (target !== undefined) {
          await this.openLocation(target.uri, target.selectionRange);
        }
        break;
      }
      case "layoutMeasured":
        document.measurements = message.measurements ?? [];
        break;
    }
  }

  private async openLocation(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: true,
        preserveFocus: false,
        selection: range
      });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to open reference: ${String(error)}`);
    }
  }

  private payload(node: InternalGraphNode): GraphNodePayload {
    return {
      id: node.id,
      parentId: node.parentId,
      label: node.label,
      root: node.root,
      cycle: node.cycle,
      expandable: node.expandable,
      expanded: node.expanded,
      loading: node.loading,
      references: node.references,
      childIds: node.childIds,
      message: node.message
    };
  }

  private postState(): void {
    void this.view?.webview.postMessage({
      type: "workspaceState",
      tabs: this.documentOrder.flatMap((id) => {
        const document = this.documents.get(id);
        return document === undefined ? [] : [{ id, title: document.title }];
      }),
      activeTabId: this.activeDocumentId,
      state: this.snapshot()
    });
  }

  private html(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}';">
  <style nonce="${scriptNonce}">
    :root { color-scheme: light dark; }
    html { margin: 0; padding: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 12px var(--vscode-font-family); }
    button { font: inherit; }
    #tabs { flex: 0 0 auto; min-height: 34px; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-content: flex-start; justify-content: flex-start; overflow: hidden; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); }
    .tab { flex: 0 0 auto; height: 34px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; border: 0; border-right: 1px solid var(--vscode-panel-border); color: var(--vscode-tab-inactiveForeground); background: var(--vscode-tab-inactiveBackground); cursor: pointer; }
    .tab:first-child { margin-left: 0; padding-left: 6px; }
    .tab:hover { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-hoverBackground); }
    .tab.active { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); box-shadow: inset 0 2px var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder)); }
    .tab-label { white-space: nowrap; }
    .tab-close { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 3px; color: inherit; background: transparent; cursor: pointer; }
    .tab-close:hover { background: var(--vscode-toolbar-hoverBackground); }
    #viewport { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; cursor: default; user-select: none; }
    #viewport.dragging { cursor: default; }
    #world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    #edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    .edge { fill: none; stroke: var(--vscode-editorWidget-border); stroke-width: 1.5; }
    .edge.cycle { stroke: var(--vscode-charts-orange); stroke-dasharray: 3 3; }
    #nodes { position: absolute; left: 0; top: 0; }
    .node { position: absolute; width: max-content; min-width: 44px; min-height: 30px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 5px; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); box-shadow: 0 2px 6px rgba(0,0,0,.16); cursor: default; text-align: left; }
    .node:hover { border-color: var(--vscode-focusBorder); }
    .node.root { border-left: 4px solid var(--vscode-focusBorder); }
    .node.cycle { border-color: var(--vscode-charts-orange); }
    .node-main { padding: 5px 8px; min-height: 28px; }
    .node.expandable .node-main { padding-right: 8px; }
    .node-title { font-weight: 600; font-size: 12px; line-height: 16px; white-space: nowrap; cursor: pointer; }
    .node-title:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .line-links { display: flex; flex-wrap: nowrap; gap: 3px; margin-top: 4px; }
    .line-link { height: 18px; padding: 0 5px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background); font-size: 11px; cursor: pointer; }
    .line-link:hover { color: var(--vscode-textLink-activeForeground); background: var(--vscode-list-hoverBackground); }
    .expand { position: absolute; right: -15px; top: 50%; width: 12px; height: 12px; padding: 0; z-index: 2; display: flex; align-items: center; justify-content: center; transform: translateY(-50%); border: 1px solid var(--vscode-button-border, transparent); border-radius: 50%; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 9px; line-height: 1; cursor: pointer; }
    .expand:hover { background: var(--vscode-button-hoverBackground); }
    .expand.loading { animation: pulse 1s infinite alternate; }
    @keyframes pulse { from { opacity: .45; } to { opacity: 1; } }
    #status { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; color: var(--vscode-descriptionForeground); pointer-events: none; }
    #status strong { color: var(--vscode-foreground); font-size: 13px; }
  </style>
</head>
<body>
  <div id="tabs"></div>
  <div id="viewport">
    <div id="world"><svg id="edges"></svg><div id="nodes"></div></div>
    <div id="status"></div>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const tabsLayer = document.getElementById('tabs');
    const viewport = document.getElementById('viewport');
    const world = document.getElementById('world');
    const edges = document.getElementById('edges');
    const nodesLayer = document.getElementById('nodes');
    const status = document.getElementById('status');
    let tabs = [];
    let activeTabId;
    let graph = { nodes: [] };
    const INITIAL_PAN_X = 0;
    const INITIAL_PAN_Y = 30;
    let panX = INITIAL_PAN_X;
    let panY = INITIAL_PAN_Y;
    let worldWidth = 1;
    let worldHeight = 1;
    const COLUMN_GAP = 110;
    const ROW_GAP = 12;
    const layoutVariableWidthGraph = ${layoutVariableWidthGraph.toString()};
    const viewPositions = new Map();

    function post(message) {
      vscode.postMessage({ tabId: activeTabId, ...message });
    }

    function applyTransform() {
      world.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(1)';
    }

    function edgePath(parent, child) {
      const x1 = parent.x + parent.width;
      const y1 = parent.y + parent.height / 2;
      const x2 = child.x;
      const y2 = child.y + child.height / 2;
      const bend = Math.max(35, (x2 - x1) * .48);
      return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    }

    function createCard(node) {
      const card = document.createElement('div');
      card.className = 'node'
        + (node.root ? ' root' : '')
        + (node.cycle ? ' cycle' : '')
        + (node.expandable ? ' expandable' : '');
      card.dataset.id = node.id;
      card.title = node.message || 'Double-click to open definition';

      const main = document.createElement('div');
      main.className = 'node-main';
      const title = document.createElement('div');
      title.className = 'node-title';
      title.textContent = node.label;
      title.title = node.references.length > 0
        ? 'Open the call to the parent function'
        : 'Open the function definition';
      title.addEventListener('click', event => {
        event.stopPropagation();
        post({ type: 'openCallSite', nodeId: node.id });
      });
      title.addEventListener('dblclick', event => event.stopPropagation());
      main.appendChild(title);

      const uniqueReferences = new Map();
      for (const reference of node.references) {
        const key = reference.uri + ':' + reference.line;
        if (!uniqueReferences.has(key)) uniqueReferences.set(key, reference);
      }
      if (uniqueReferences.size > 1) {
        const lineLinks = document.createElement('div');
        lineLinks.className = 'line-links';
        for (const reference of uniqueReferences.values()) {
          const line = document.createElement('button');
          line.className = 'line-link';
          line.textContent = 'L' + reference.line;
          line.title = reference.path + ':' + reference.line + '\\n' + reference.preview;
          line.addEventListener('click', event => {
            event.stopPropagation();
            post({ type: 'openReference', uri: reference.uri, range: reference.range });
          });
          line.addEventListener('dblclick', event => event.stopPropagation());
          lineLinks.appendChild(line);
        }
        main.appendChild(lineLinks);
      }
      card.appendChild(main);

      if (node.expandable) {
        const expand = document.createElement('button');
        expand.className = 'expand' + (node.loading ? ' loading' : '');
        expand.textContent = node.loading ? '…' : node.expanded ? '−' : '+';
        expand.title = node.expanded ? 'Collapse callers' : 'Expand callers';
        expand.addEventListener('click', event => {
          event.stopPropagation();
          post({ type: node.expanded ? 'collapse' : 'expand', nodeId: node.id });
        });
        card.appendChild(expand);
      }
      card.addEventListener('dblclick', () => post({ type: 'openNode', nodeId: node.id }));
      return card;
    }

    function renderTabs() {
      tabsLayer.replaceChildren();
      for (const tab of tabs) {
        const button = document.createElement('div');
        button.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
        button.title = tab.title;
        button.tabIndex = 0;
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => {
          if (tab.id !== activeTabId) {
            post({ type: 'selectTab', tabId: tab.id });
          }
        });
        button.addEventListener('keydown', event => {
          if ((event.key === 'Enter' || event.key === ' ') && tab.id !== activeTabId) {
            post({ type: 'selectTab', tabId: tab.id });
          }
        });
        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = tab.title;
        button.appendChild(label);
        const close = document.createElement('button');
        close.className = 'tab-close';
        close.textContent = '×';
        close.title = 'Close ' + tab.title;
        close.addEventListener('click', event => {
          event.stopPropagation();
          post({ type: 'closeTab', tabId: tab.id });
        });
        button.appendChild(close);
        tabsLayer.appendChild(button);
      }
    }

    function render() {
      status.replaceChildren();
      if (graph.status || !graph.rootId) {
        const wrap = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = graph.status ? graph.status.label : 'Place the cursor on a symbol and generate a graph';
        wrap.appendChild(strong);
        if (graph.status && graph.status.detail) {
          const detail = document.createElement('div');
          detail.textContent = graph.status.detail;
          wrap.appendChild(detail);
        }
        status.appendChild(wrap);
      }

      edges.replaceChildren();
      nodesLayer.replaceChildren();
      const cards = new Map();
      for (const node of graph.nodes) {
        const card = createCard(node);
        cards.set(node.id, card);
        nodesLayer.appendChild(card);
      }
      const sizes = new Map();
      for (const [id, card] of cards) {
        const bounds = card.getBoundingClientRect();
        sizes.set(id, {
          width: Math.ceil(bounds.width),
          height: Math.ceil(bounds.height)
        });
      }
      const computedLayout = layoutVariableWidthGraph(
        graph.rootId,
        graph.nodes,
        sizes,
        {
          left: 0,
          top: 35,
          right: 0,
          bottom: 35,
          columnGap: COLUMN_GAP,
          rowGap: ROW_GAP
        }
      );
      const positions = computedLayout.positions;
      worldWidth = computedLayout.width;
      worldHeight = computedLayout.height;
      edges.setAttribute('width', String(worldWidth));
      edges.setAttribute('height', String(worldHeight));
      edges.setAttribute('viewBox', '0 0 ' + worldWidth + ' ' + worldHeight);
      nodesLayer.style.width = worldWidth + 'px';
      nodesLayer.style.height = worldHeight + 'px';

      for (const [id, card] of cards) {
        const position = positions.get(id);
        if (!position) {
          card.remove();
          continue;
        }
        card.style.left = position.x + 'px';
        card.style.top = position.y + 'px';
      }

      for (const node of graph.nodes) {
        const position = positions.get(node.id);
        if (!position) continue;
        if (node.parentId) {
          const parentPosition = positions.get(node.parentId);
          if (parentPosition) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', edgePath(parentPosition, position));
            path.setAttribute('class', 'edge' + (node.cycle ? ' cycle' : ''));
            edges.appendChild(path);
          }
        }
      }
      applyTransform();
      post({
        type: 'layoutMeasured',
        measurements: graph.nodes.flatMap(node => {
          const position = positions.get(node.id);
          return position
            ? [{
                id: node.id,
                label: node.label,
                width: position.width,
                height: position.height
              }]
            : [];
        })
      });
    }

    window.addEventListener('message', event => {
      if (event.data.type !== 'workspaceState') return;
      if (activeTabId) {
        viewPositions.set(activeTabId, { panX, panY, rootId: graph.rootId });
      }
      tabs = event.data.tabs;
      const previousTabId = activeTabId;
      const previousRoot = graph.rootId;
      activeTabId = event.data.activeTabId;
      graph = event.data.state;
      const saved = activeTabId ? viewPositions.get(activeTabId) : undefined;
      if (activeTabId !== previousTabId) {
        panX = saved?.panX ?? INITIAL_PAN_X;
        panY = saved?.panY ?? INITIAL_PAN_Y;
      } else if (graph.rootId !== previousRoot) {
        panX = INITIAL_PAN_X;
        panY = INITIAL_PAN_Y;
      }
      renderTabs();
      render();
    });

    let drag;
    viewport.addEventListener('pointerdown', event => {
      if (event.target.closest('button, .node')) return;
      drag = { x: event.clientX, y: event.clientY, panX, panY };
      viewport.classList.add('dragging');
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointermove', event => {
      if (!drag) return;
      panX = drag.panX + event.clientX - drag.x;
      panY = drag.panY + event.clientY - drag.y;
      applyTransform();
    });
    viewport.addEventListener('pointerup', event => {
      drag = undefined;
      viewport.classList.remove('dragging');
      viewport.releasePointerCapture(event.pointerId);
    });
    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      panX -= event.deltaX;
      panY -= event.deltaY;
      applyTransform();
    }, { passive: false });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    for (const document of this.documents.values()) {
      document.session.dispose();
    }
    this.documents.clear();
    this.documentOrder.splice(0);
  }
}
