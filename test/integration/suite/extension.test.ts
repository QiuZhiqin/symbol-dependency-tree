import * as assert from "node:assert/strict";
import { suite, test } from "mocha";
import * as vscode from "vscode";

const extensionId = "local.symbol-dependency-tree";

interface GraphReference {
  readonly line: number;
}

interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly root: boolean;
  readonly childIds: readonly string[];
  readonly references: readonly GraphReference[];
  readonly message?: string;
}

interface GraphState {
  readonly rootId?: string;
  readonly nodes: readonly GraphNode[];
}

interface ExtensionApi {
  readonly getGraphState: () => GraphState;
  readonly getLayoutMeasurements: () => readonly GraphNodeMeasurement[];
  readonly getGraphPanels: () => readonly GraphPanelSnapshot[];
}

interface GraphNodeMeasurement {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

interface GraphPanelSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: GraphState;
  readonly measurements: readonly GraphNodeMeasurement[];
}

interface SourceCase {
  readonly uri: vscode.Uri;
  readonly target: string;
  readonly callers: ReadonlyArray<{
    readonly name: string;
    readonly lines: readonly number[];
  }>;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function sourceCase(): Promise<SourceCase> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, "Integration test requires a workspace folder");
  const linux = vscode.Uri.joinPath(root, "mac80211", "sta_info.c");
  if (await exists(linux)) {
    return {
      uri: linux,
      target: "__sta_info_destroy_part1",
      callers: [
        { name: "__sta_info_destroy", lines: [1117] },
        { name: "__sta_info_flush", lines: [1217] }
      ]
    };
  }
  return {
    uri: vscode.Uri.joinPath(root, "call_chain.cpp"),
    target: "leaf",
    callers: [{ name: "middle", lines: [34, 35] }]
  };
}

async function secondSourceCase(): Promise<SourceCase> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, "Integration test requires a workspace folder");
  const linux = vscode.Uri.joinPath(root, "mac80211", "iface.c");
  if (await exists(linux)) {
    return {
      uri: linux,
      target: "ieee80211_iface_work",
      callers: [
        { name: "ieee80211_add_virtual_monitor", lines: [975] },
        { name: "ieee80211_setup_sdata", lines: [1532] }
      ]
    };
  }
  return {
    uri: vscode.Uri.joinPath(root, "call_chain.cpp"),
    target: "middle",
    callers: [{ name: "entry", lines: [40] }]
  };
}

async function symbolSourceCase(): Promise<SourceCase> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, "Integration test requires a workspace folder");
  const linux = vscode.Uri.joinPath(root, "mac80211", "agg-tx.c");
  if (await exists(linux)) {
    return {
      uri: linux,
      target: "WLAN_ACTION_ADDBA_REQ",
      callers: [
        { name: "ieee80211_send_addba_request", lines: [95] },
        { name: "ieee80211_iface_work", lines: [1366] },
        { name: "ieee80211_rx_h_action", lines: [3394] }
      ]
    };
  }
  return {
    uri: vscode.Uri.joinPath(root, "call_chain.cpp"),
    target: "APPLY_TWICE",
    callers: [{ name: "leaf", lines: [28] }]
  };
}

async function activate(): Promise<{
  readonly extension: vscode.Extension<ExtensionApi>;
  readonly api: ExtensionApi;
}> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(extensionId);
  assert.ok(extension, `Extension ${extensionId} was not discovered`);
  const api = await extension.activate();
  return { extension, api };
}

async function waitForMeasurements(
  api: ExtensionApi,
  expected: number
): Promise<readonly GraphNodeMeasurement[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const measurements = api.getLayoutMeasurements();
    if (measurements.length >= expected) {
      return measurements;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return api.getLayoutMeasurements();
}

suite("Symbol Dependency Tree integration", () => {
  test("activates and registers every public command", async () => {
    await activate();
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of [
      "symbolDependencyTree.show",
      "symbolDependencyTree.refresh",
      "symbolDependencyTree.clear",
      "symbolDependencyTree.collapseAll",
      "symbolDependencyTree.openReference",
      "symbolDependencyTree.rebuildIndex"
    ]) {
      assert.ok(commands.has(command), `Missing command: ${command}`);
    }
    assert.ok(
      !commands.has("symbolDependencyTree.retryWithTextSearch"),
      "Directory text-search fallback command must not be registered"
    );
  });

  test("right-click command resolves callers exclusively from the rebuilt database", async () => {
    const { api } = await activate();
    const sample = await sourceCase();
    const document = await vscode.workspace.openTextDocument(sample.uri);
    const definitionOffset = document.getText().indexOf(sample.target);
    assert.ok(definitionOffset >= 0, `Missing target ${sample.target}`);
    const position = document.positionAt(definitionOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.rebuildIndex");
    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(firstWorkspaceFolder, "The index requires a workspace folder");
    const indexDirectory = vscode.Uri.joinPath(
      firstWorkspaceFolder.uri,
      ".symbol-dependency-tree"
    );
    const indexEntries = await vscode.workspace.fs.readDirectory(indexDirectory);
    assert.ok(
      indexEntries.some(
        ([name, type]) =>
          type === vscode.FileType.File &&
          /^call-index-[a-f0-9]{20}\.json$/u.test(name)
      ),
      `No workspace-local index database was written to ${indexDirectory.toString()}`
    );
    for (const additionalFolder of vscode.workspace.workspaceFolders?.slice(1) ?? []) {
      assert.equal(
        await exists(vscode.Uri.joinPath(additionalFolder.uri, ".symbol-dependency-tree")),
        false,
        `Index database was incorrectly written to ${additionalFolder.uri.toString()}`
      );
    }
    await vscode.commands.executeCommand("symbolDependencyTree.show");

    assert.deepEqual(
      api.getGraphPanels().map((panel) => panel.title),
      [sample.target]
    );
    const state = api.getGraphState();
    assert.ok(state.rootId, "Graph has no root");
    const nodes = new Map(state.nodes.map((node) => [node.id, node]));
    const root = nodes.get(state.rootId);
    assert.ok(root, "Root node is missing");
    assert.equal(root.label, sample.target);
    assert.equal(root.message, undefined);

    const callers = root.childIds.map((id) => {
      const node = nodes.get(id);
      assert.ok(node, `Missing caller node ${id}`);
      return node;
    });
    assert.deepEqual(
      callers.map((caller) => caller.label).sort(),
      sample.callers.map((caller) => caller.name).sort()
    );
    for (const expected of sample.callers) {
      const caller = callers.find((node) => node.label === expected.name);
      assert.ok(caller, `Missing caller ${expected.name}`);
      assert.deepEqual(
        caller.references.map((reference) => reference.line).sort((left, right) => left - right),
        [...expected.lines]
      );
    }

    const measurements = await waitForMeasurements(api, 1 + sample.callers.length);
    const visibleLabels = [sample.target, ...sample.callers.map((caller) => caller.name)];
    const visibleMeasurements = visibleLabels.map((label) => {
      const measurement = measurements.find((candidate) => candidate.label === label);
      assert.ok(measurement, `Webview did not report a box for ${label}`);
      return measurement;
    });
    assert.ok(
      visibleMeasurements.every((measurement) => measurement.width < 360),
      "Function boxes still reserve the old fixed 360px width"
    );
    assert.ok(
      new Set(visibleMeasurements.map((measurement) => measurement.width)).size > 1,
      "Function boxes did not vary with their labels"
    );
  });

  test("opens and selects an exact indexed call site", async () => {
    const { api } = await activate();
    const state = api.getGraphState();
    assert.ok(state.rootId);
    const nodes = new Map(state.nodes.map((node) => [node.id, node]));
    const root = nodes.get(state.rootId);
    assert.ok(root);
    const caller = nodes.get(root.childIds[0] ?? "");
    assert.ok(caller);
    const reference = caller.references[0];
    assert.ok(reference);

    const sample = await sourceCase();
    const document = await vscode.workspace.openTextDocument(sample.uri);
    const line = document.lineAt(reference.line - 1);
    const expectedName = sample.target;
    const startCharacter = line.text.indexOf(expectedName);
    assert.ok(startCharacter >= 0);
    const range = new vscode.Range(
      reference.line - 1,
      startCharacter,
      reference.line - 1,
      startCharacter + expectedName.length
    );
    await vscode.commands.executeCommand("symbolDependencyTree.openReference", {
      hit: { uri: sample.uri, range }
    });

    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sample.uri.toString());
    assert.ok(
      vscode.window.activeTextEditor?.selection.isEqual(
        new vscode.Selection(range.start, range.end)
      )
    );
  });

  test("indexes bare callback arguments and preserves searches as tabs in the bottom view", async () => {
    const { api } = await activate();
    const first = await sourceCase();
    const sample = await secondSourceCase();
    const document = await vscode.workspace.openTextDocument(sample.uri);
    const targetOffset = document.getText().indexOf(sample.target);
    assert.ok(targetOffset >= 0, `Missing target ${sample.target}`);
    const position = document.positionAt(targetOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const panels = api.getGraphPanels();
    assert.deepEqual(
      panels.map((panel) => panel.title),
      [first.target, sample.target]
    );
    assert.ok(
      panels.every((panel) => panel.id.startsWith("tab:")),
      "Graph searches were not stored as internal bottom-view tabs"
    );
    const firstRoot = panels[0]?.state.nodes.find(
      (node) => node.id === panels[0]?.state.rootId
    );
    assert.equal(firstRoot?.label, first.target, "The first graph panel was overwritten");

    const current = panels[1]?.state;
    assert.ok(current?.rootId, "The callback graph has no root");
    const nodes = new Map(current.nodes.map((node) => [node.id, node]));
    const root = nodes.get(current.rootId);
    assert.ok(root);
    assert.equal(root.label, sample.target);
    const callers = root.childIds.map((id) => {
      const caller = nodes.get(id);
      assert.ok(caller);
      return caller;
    });
    assert.deepEqual(
      callers.map((caller) => caller.label).sort(),
      sample.callers.map((caller) => caller.name).sort()
    );
    for (const expected of sample.callers) {
      const caller = callers.find((node) => node.label === expected.name);
      assert.ok(caller, `Missing callback registrar ${expected.name}`);
      assert.deepEqual(
        caller.references.map((reference) => reference.line).sort((left, right) => left - right),
        [...expected.lines]
      );
    }
  });

  test("indexes enum values and macros as exact database references", async () => {
    const { api } = await activate();
    const sample = await symbolSourceCase();
    const document = await vscode.workspace.openTextDocument(sample.uri);
    const targetOffset = document.getText().indexOf(sample.target);
    assert.ok(targetOffset >= 0, `Missing target ${sample.target}`);
    const position = document.positionAt(targetOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const panels = api.getGraphPanels();
    assert.equal(panels.at(-1)?.title, sample.target);
    const state = api.getGraphState();
    assert.ok(state.rootId, "The symbol-reference graph has no root");
    const nodes = new Map(state.nodes.map((node) => [node.id, node]));
    const root = nodes.get(state.rootId);
    assert.ok(root);
    assert.equal(root.label, sample.target);
    const callers = root.childIds.map((id) => {
      const caller = nodes.get(id);
      assert.ok(caller);
      return caller;
    });
    assert.deepEqual(
      callers.map((caller) => caller.label).sort(),
      sample.callers.map((caller) => caller.name).sort()
    );
    for (const expected of sample.callers) {
      const caller = callers.find((node) => node.label === expected.name);
      assert.ok(caller, `Missing symbol reference scope ${expected.name}`);
      assert.deepEqual(
        caller.references.map((reference) => reference.line).sort((left, right) => left - right),
        [...expected.lines]
      );
    }
  });

  test("keeps a local variable inside its declaring function", async () => {
    const { api } = await activate();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "Integration test requires a workspace folder");
    const uri = vscode.Uri.joinPath(root, "call_chain.cpp");
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const declarationOffset = source.indexOf("scoped_value");
    assert.ok(declarationOffset >= 0, "Missing scoped local-variable fixture");
    const position = document.positionAt(declarationOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const state = api.getGraphState();
    assert.ok(state.rootId, "The local-variable graph has no root");
    const nodes = new Map(state.nodes.map((node) => [node.id, node]));
    const graphRoot = nodes.get(state.rootId);
    assert.ok(graphRoot);
    const callers = graphRoot.childIds.map((id) => {
      const caller = nodes.get(id);
      assert.ok(caller);
      return caller;
    });
    assert.deepEqual(
      callers.map((caller) => caller.label),
      ["local_scope_one"]
    );
    assert.deepEqual(
      callers[0]?.references.map((reference) => reference.line),
      [12, 13, 14]
    );
  });

  test("keeps equal member names separated by their owner type", async () => {
    const { api } = await activate();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "Integration test requires a workspace folder");
    const uri = vscode.Uri.joinPath(root, "call_chain.hpp");
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const declarationLineOffset = source.indexOf("int value");
    assert.ok(declarationLineOffset >= 0, "Missing member-variable fixture");
    const declarationOffset = declarationLineOffset + "int ".length;
    const position = document.positionAt(declarationOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const state = api.getGraphState();
    assert.ok(state.rootId, "The member-variable graph has no root");
    const nodes = new Map(state.nodes.map((node) => [node.id, node]));
    const graphRoot = nodes.get(state.rootId);
    assert.ok(graphRoot);
    const callers = graphRoot.childIds.map((id) => {
      const caller = nodes.get(id);
      assert.ok(caller);
      return caller;
    });
    assert.deepEqual(
      callers.map((caller) => caller.label).sort(),
      ["increment", "update_members"]
    );
    assert.deepEqual(
      callers
        .find((caller) => caller.label === "increment")
        ?.references.map((reference) => reference.line),
      [7, 8]
    );
    assert.deepEqual(
      callers
        .find((caller) => caller.label === "update_members")
        ?.references.map((reference) => reference.line),
      [23]
    );
  });
});
