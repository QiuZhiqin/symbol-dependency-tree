import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
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
  readonly getIndexStatus: () => IndexStatus;
}

interface IndexStatus {
  readonly phase: "idle" | "loading" | "building" | "ready" | "cancelled" | "error";
  readonly stats: {
    readonly files: number;
    readonly functions: number;
    readonly calls: number;
  };
  readonly processedFiles?: number;
  readonly totalFiles?: number;
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

function compactSnapshotName(firstWorkspaceFolder: vscode.WorkspaceFolder): string {
  const digest = createHash("sha256")
    .update(firstWorkspaceFolder.uri.toString())
    .digest("hex")
    .slice(0, 20);
  return `call-index-${digest}.json.gz`;
}

async function waitForIndex(
  api: ExtensionApi,
  predicate: (status: IndexStatus) => boolean
): Promise<IndexStatus> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = api.getIndexStatus();
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return api.getIndexStatus();
}

async function waitForGraph(
  api: ExtensionApi,
  predicate: (state: GraphState) => boolean
): Promise<GraphState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = api.getGraphState();
    if (predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return api.getGraphState();
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
    const { api } = await activate();
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
    assert.notEqual(
      api.getIndexStatus().phase,
      "idle",
      "Workspace activation should start loading the persistent index"
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
    const indexStatus = api.getIndexStatus();
    assert.equal(indexStatus.phase, "ready");
    assert.ok(indexStatus.stats.files > 0);
    assert.ok(indexStatus.stats.functions > 0);
    assert.ok(indexStatus.stats.calls > 0);
    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(firstWorkspaceFolder, "The index requires a workspace folder");
    const indexDirectory = vscode.Uri.joinPath(
      firstWorkspaceFolder.uri,
      ".symbol-dependency-tree"
    );
    const indexEntries = await vscode.workspace.fs.readDirectory(indexDirectory);
    const snapshotName = compactSnapshotName(firstWorkspaceFolder);
    const compressedIndex = indexEntries.find(
      ([name, type]) =>
        type === vscode.FileType.File && name === snapshotName
    );
    assert.ok(
      compressedIndex,
      `No compressed workspace-local index database was written to ${indexDirectory.toString()}`
    );
    const compressedBytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(indexDirectory, compressedIndex[0])
    );
    assert.deepEqual(
      [...compressedBytes.slice(0, 2)],
      [0x1f, 0x8b],
      "Persistent index does not have a gzip header"
    );
    const compactDocument = JSON.parse(
      gunzipSync(compressedBytes).toString("utf8")
    ) as Record<string, unknown>;
    assert.equal(compactDocument.v, 15);
    assert.ok(Array.isArray(compactDocument.s), "Compact index has no string table");
    assert.ok(Array.isArray(compactDocument.f), "Compact index has no file tuples");
    assert.equal("files" in compactDocument, false, "Keyed v10 records were persisted");
    assert.equal(
      indexEntries.some(([name]) =>
        /^call-index-[a-f0-9]{20}\.json$/u.test(name)
      ),
      false,
      "Legacy uncompressed index was not removed"
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
        new vscode.Selection(line.range.start, line.range.end)
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
    if (!(await exists(uri))) {
      return;
    }
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
    if (!(await exists(uri))) {
      return;
    }
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

  test("links callback-table initialization to chained indirect calls", async () => {
    const { api } = await activate();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "Integration test requires a workspace folder");
    const uri = vscode.Uri.joinPath(root, "call_chain.cpp");
    if (!(await exists(uri))) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const initializerOffset = source.indexOf(".complete = callback_impl");
    assert.ok(initializerOffset >= 0, "Missing callback-table initializer fixture");
    const callbackOffset = initializerOffset + 1;
    const position = document.positionAt(callbackOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const state = api.getGraphState();
    assert.ok(state.rootId, "The callback-member graph has no root");
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
      ["callback_event_ops", "dispatch_callback"]
    );
    assert.deepEqual(
      callers
        .find((caller) => caller.label === "callback_event_ops")
        ?.references.map((reference) => reference.line),
      [document.positionAt(callbackOffset).line + 1]
    );
    const indirectCallOffset = source.indexOf(
      "complete(1)",
      callbackOffset + "complete".length
    );
    assert.ok(indirectCallOffset >= 0, "Missing callback-table indirect call fixture");
    assert.deepEqual(
      callers
        .find((caller) => caller.label === "dispatch_callback")
        ?.references.map((reference) => reference.line),
      [document.positionAt(indirectCallOffset).line + 1]
    );
  });

  test("links a type definition to containing types and function users", async () => {
    const { api } = await activate();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "Integration test requires a workspace folder");
    const uri = vscode.Uri.joinPath(root, "call_chain.hpp");
    if (!(await exists(uri))) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const definitionOffset = source.indexOf("Payload {");
    assert.ok(definitionOffset >= 0, "Missing contained-type fixture");
    const position = document.positionAt(definitionOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const state = api.getGraphState();
    assert.ok(state.rootId, "The type-reference graph has no root");
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
      ["PayloadContainer", "consume_payload"]
    );
  });

  test("automatically refreshes indexed offsets after an unsaved edit", async () => {
    const { api } = await activate();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "Integration test requires a workspace folder");
    const uri = vscode.Uri.joinPath(root, "call_chain.cpp");
    if (!(await exists(uri))) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const targetOffset = document.getText().indexOf("leaf(int input)");
    assert.ok(targetOffset >= 0, "Missing live-update fixture target");
    const position = document.positionAt(targetOffset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand("symbolDependencyTree.show");

    const callerLines = (state: GraphState): number[] => {
      const nodes = new Map(state.nodes.map((node) => [node.id, node]));
      const graphRoot = state.rootId === undefined ? undefined : nodes.get(state.rootId);
      return graphRoot?.childIds
        .map((id) => nodes.get(id))
        .find((node) => node?.label === "middle")
        ?.references.map((reference) => reference.line) ?? [];
    };
    assert.deepEqual(callerLines(api.getGraphState()), [34, 35]);

    try {
      assert.equal(
        await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// shift\n")),
        true
      );
      const updated = await waitForGraph(
        api,
        (state) => callerLines(state).join(",") === "35,36"
      );
      assert.deepEqual(callerLines(updated), [35, 36]);
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await waitForGraph(api, (state) => callerLines(state).join(",") === "34,35");
    }
  });

  test("updates added and removed workspace roots through the delta journal", async () => {
    const { api } = await activate();
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length < 2) {
      return;
    }
    const primary = folders[0];
    const secondary = folders[1];
    assert.ok(primary);
    assert.ok(secondary);
    const secondarySource = vscode.Uri.joinPath(secondary.uri, "noise.c");
    if (!(await exists(secondarySource))) {
      return;
    }

    await vscode.commands.executeCommand("symbolDependencyTree.rebuildIndex");
    const initialStats = api.getIndexStatus().stats;
    const indexDirectory = vscode.Uri.joinPath(
      primary.uri,
      ".symbol-dependency-tree"
    );
    const snapshotName = compactSnapshotName(primary);
    const snapshotUri = vscode.Uri.joinPath(indexDirectory, snapshotName);
    const journalUri = vscode.Uri.joinPath(
      indexDirectory,
      snapshotName.replace(/\.json\.gz$/u, ".delta.json.gz")
    );
    const snapshotBefore = await vscode.workspace.fs.readFile(snapshotUri);
    let secondaryRemoved = false;

    try {
      assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
      secondaryRemoved = true;
      const removedStatus = await waitForIndex(
        api,
        (status) =>
          status.phase === "ready" &&
          status.stats.files < initialStats.files
      );
      assert.equal(removedStatus.phase, "ready");
      assert.ok(removedStatus.stats.files < initialStats.files);
      assert.equal(await exists(journalUri), true, "Root removal wrote no delta journal");

      assert.equal(
        vscode.workspace.updateWorkspaceFolders(1, 0, {
          uri: secondary.uri,
          name: secondary.name
        }),
        true
      );
      secondaryRemoved = false;
      const restoredStatus = await waitForIndex(
        api,
        (status) =>
          status.phase === "ready" &&
          status.stats.files === initialStats.files
      );
      assert.equal(restoredStatus.stats.files, initialStats.files);
    } finally {
      if (secondaryRemoved) {
        vscode.workspace.updateWorkspaceFolders(1, 0, {
          uri: secondary.uri,
          name: secondary.name
        });
        await waitForIndex(
          api,
          (status) =>
            status.phase === "ready" &&
            status.stats.files === initialStats.files
        );
      }
    }

    const snapshotAfter = await vscode.workspace.fs.readFile(snapshotUri);
    assert.equal(
      Buffer.compare(Buffer.from(snapshotBefore), Buffer.from(snapshotAfter)),
      0,
      "A workspace-root delta rewrote the full compact snapshot"
    );
    const journalBytes = await vscode.workspace.fs.readFile(journalUri);
    const journalDocument = JSON.parse(
      gunzipSync(journalBytes).toString("utf8")
    ) as Record<string, unknown>;
    assert.equal(journalDocument.v, 15);
    assert.ok(Array.isArray(journalDocument.f));
    assert.ok(Array.isArray(journalDocument.r));
  });
});
