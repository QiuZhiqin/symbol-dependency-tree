import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  symbolKey,
  type ReferenceHit,
  type ScopeReference,
  type TargetSymbol
} from "../model/symbolTypes";
import {
  scanCallIndexFile,
  type IndexedFunctionDefinition
} from "../utils/callIndexScanner";
import type { IndexedSymbolScope } from "../utils/cppSymbolScopes";
import { buildExcludeGlob, buildExtensionGlob } from "../utils/exclusions";
import { shortSymbolName } from "../utils/symbolNames";

const databaseVersion = 7;
const updateConcurrency = 12;

interface StoredCallSite {
  readonly callee: string;
  readonly offset: number;
  readonly kind: "callable" | "symbol";
  readonly scope?: IndexedSymbolScope;
  readonly implicitMemberOwner?: string;
  readonly callerIndex: number;
}

interface IndexedFileRecord {
  readonly uri: string;
  readonly mtime: number;
  readonly size: number;
  readonly definitions: readonly IndexedFunctionDefinition[];
  readonly calls: readonly StoredCallSite[];
}

interface PersistedCallIndex {
  readonly version: number;
  readonly files: readonly IndexedFileRecord[];
}

interface IndexedCallWithFile {
  readonly file: IndexedFileRecord;
  readonly call: StoredCallSite;
}

interface IndexedDefinitionWithFile {
  readonly file: IndexedFileRecord;
  readonly definition: IndexedFunctionDefinition;
}

export interface PersistentIndexStats {
  readonly files: number;
  readonly functions: number;
  readonly calls: number;
}

export interface PersistentIndexStatus {
  readonly phase:
    | "idle"
    | "loading"
    | "building"
    | "ready"
    | "cancelled"
    | "error";
  readonly stats: PersistentIndexStats;
  readonly processedFiles?: number;
  readonly totalFiles?: number;
  readonly detail?: string;
}

export interface PersistentIndexQueryResult {
  readonly scopes: readonly ScopeReference[];
}

function workspaceIdentity(): string {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.toString())
    .sort()
    .join("|");
}

function configurationGlobs(): { include: string; exclude: string } {
  const configuration = vscode.workspace.getConfiguration("symbolDependencyTree");
  const extensions = configuration.get<string[]>("persistentIndex.fileExtensions", [
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".h",
    ".hh",
    ".hpp",
    ".hxx",
    ".inl",
    ".ipp"
  ]);
  const filesExclude = vscode.workspace
    .getConfiguration("files")
    .get<Record<string, boolean>>("exclude");
  const searchExclude = vscode.workspace
    .getConfiguration("search")
    .get<Record<string, boolean>>("exclude");
  return {
    include: buildExtensionGlob(extensions),
    exclude: buildExcludeGlob(filesExclude, searchExclude)
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function callableKind(kind: vscode.SymbolKind): boolean {
  return (
    kind === vscode.SymbolKind.Function ||
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Constructor ||
    kind === vscode.SymbolKind.Operator
  );
}

function callMatchesScope(
  targetScope: IndexedSymbolScope | undefined,
  canonicalUri: vscode.Uri,
  candidate: IndexedCallWithFile
): boolean {
  if (targetScope?.kind === "local") {
    return (
      candidate.file.uri === canonicalUri.toString() &&
      candidate.call.scope?.kind === "local" &&
      candidate.call.scope.functionSelectionStart ===
        targetScope.functionSelectionStart &&
      candidate.call.scope.declarationOffset === targetScope.declarationOffset
    );
  }
  if (targetScope?.kind === "member") {
    return (
      (candidate.call.scope?.kind === "member" &&
        candidate.call.scope.owner === targetScope.owner) ||
      candidate.call.implicitMemberOwner === targetScope.owner
    );
  }
  return candidate.call.scope === undefined;
}

export class PersistentCallIndex implements vscode.Disposable {
  private readonly files = new Map<string, IndexedFileRecord>();
  private readonly callsByCallee = new Map<string, IndexedCallWithFile[]>();
  private readonly definitionsByName = new Map<string, IndexedDefinitionWithFile[]>();
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly statusChanges = new vscode.EventEmitter<PersistentIndexStatus>();
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly pendingUpdates = new Map<string, NodeJS.Timeout>();
  private loaded = false;
  private databaseAvailable = false;
  private readyPromise: Promise<void> | undefined;
  private currentStatus: PersistentIndexStatus = {
    phase: "idle",
    stats: { files: 0, functions: 0, calls: 0 }
  };

  public readonly onDidChange = this.changes.event;
  public readonly onDidStatusChange = this.statusChanges.event;

  public constructor(
    private readonly fallbackStorageUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    const { include } = configurationGlobs();
    this.watcher = vscode.workspace.createFileSystemWatcher(include);
    this.watcher.onDidCreate((uri) => this.scheduleUpdate(uri));
    this.watcher.onDidChange((uri) => this.scheduleUpdate(uri));
    this.watcher.onDidDelete((uri) => {
      if (this.files.delete(uri.toString())) {
        this.rebuildLookup();
        void this.save();
        this.setStatus({ phase: "ready", stats: this.stats() });
        this.changes.fire();
      }
    });
  }

  public dispose(): void {
    for (const timeout of this.pendingUpdates.values()) {
      clearTimeout(timeout);
    }
    this.pendingUpdates.clear();
    this.watcher.dispose();
    this.changes.dispose();
    this.statusChanges.dispose();
  }

  public async ensureReady(token: vscode.CancellationToken): Promise<void> {
    if (this.readyPromise === undefined) {
      this.readyPromise = this.loadOrBuild(token).catch((error: unknown) => {
        this.readyPromise = undefined;
        this.setStatus({
          phase: "error",
          stats: this.stats(),
          detail: String(error)
        });
        throw error;
      });
    }
    await this.readyPromise;
  }

  public async rebuild(token: vscode.CancellationToken): Promise<PersistentIndexStats> {
    this.readyPromise = this.refresh(token, true).catch((error: unknown) => {
      this.readyPromise = undefined;
      this.setStatus({
        phase: "error",
        stats: this.stats(),
        detail: String(error)
      });
      throw error;
    });
    await this.readyPromise;
    return this.stats();
  }

  public status(): PersistentIndexStatus {
    return this.currentStatus;
  }

  public stats(): PersistentIndexStats {
    let functions = 0;
    let calls = 0;
    for (const file of this.files.values()) {
      functions += file.definitions.length;
      calls += file.calls.length;
    }
    return { files: this.files.size, functions, calls };
  }

  public async query(
    target: TargetSymbol,
    token: vscode.CancellationToken
  ): Promise<PersistentIndexQueryResult> {
    await this.ensureReady(token);
    if (token.isCancellationRequested) {
      return { scopes: [] };
    }

    const queryName = shortSymbolName(target.name);
    const canonicalUri = target.definition?.uri ?? target.uri;
    const targetFile = this.files.get(canonicalUri.toString());
    const targetDocument =
      targetFile === undefined ? undefined : await vscode.workspace.openTextDocument(canonicalUri);
    const canonicalPosition = target.definition?.range.start ?? target.selectionRange.start;
    const targetOffset = targetDocument?.offsetAt(canonicalPosition);
    const exactDefinition =
      targetOffset === undefined
        ? undefined
        : targetFile?.definitions.find(
            (definition) =>
              definition.name === queryName &&
              definition.selectionStart <= targetOffset &&
              targetOffset < definition.selectionEnd
          );
    const sameFileDefinitions =
      targetFile?.definitions.filter((definition) => definition.name === queryName) ?? [];
    const globalDefinitions = this.definitionsByName.get(queryName) ?? [];
    const targetCanBeCallable =
      callableKind(target.kind) && target.scope?.kind !== "local";
    const targetDefinition: IndexedDefinitionWithFile | undefined =
      exactDefinition !== undefined
        ? { file: targetFile!, definition: exactDefinition }
        : targetCanBeCallable && sameFileDefinitions.length === 1
          ? { file: targetFile!, definition: sameFileDefinitions[0]! }
          : targetCanBeCallable && globalDefinitions.length === 1
            ? globalDefinitions[0]!
            : undefined;
    const staticTarget = targetDefinition?.definition.isStatic === true;
    const functionTarget = targetDefinition !== undefined;
    const candidates = (this.callsByCallee.get(queryName) ?? []).filter(
      (candidate) =>
        (!functionTarget || candidate.call.kind === "callable") &&
        (!staticTarget || candidate.file.uri === targetDefinition.file.uri) &&
        callMatchesScope(target.scope, canonicalUri, candidate)
    );
    const grouped = new Map<string, IndexedCallWithFile[]>();
    for (const candidate of candidates) {
      const caller = candidate.file.definitions[candidate.call.callerIndex];
      if (caller === undefined) {
        continue;
      }
      const key = `${candidate.file.uri}#${caller.selectionStart}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, [candidate]);
      } else {
        existing.push(candidate);
      }
    }

    const scopes: ScopeReference[] = [];
    for (const group of grouped.values()) {
      if (token.isCancellationRequested) {
        return { scopes: [] };
      }
      const first = group[0];
      if (first === undefined) {
        continue;
      }
      const uri = vscode.Uri.parse(first.file.uri);
      const document = await vscode.workspace.openTextDocument(uri);
      const caller = first.file.definitions[first.call.callerIndex];
      if (caller === undefined) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(caller.rangeStart),
        document.positionAt(caller.rangeEnd)
      );
      const selectionRange = new vscode.Range(
        document.positionAt(caller.selectionStart),
        document.positionAt(caller.selectionEnd)
      );
      const references: ReferenceHit[] = group.map(({ call }) => ({
        uri,
        range: new vscode.Range(
          document.positionAt(call.offset),
          document.positionAt(call.offset + queryName.length)
        )
      }));
      const callerTarget: TargetSymbol = {
        id: symbolKey(
          uri,
          selectionRange,
          caller.name,
          caller.memberOwner === undefined
            ? vscode.SymbolKind.Function
            : vscode.SymbolKind.Method
        ),
        name: caller.name,
        displayName: caller.name,
        kind:
          caller.memberOwner === undefined
            ? vscode.SymbolKind.Function
            : vscode.SymbolKind.Method,
        uri,
        range,
        selectionRange,
        definition: new vscode.Location(uri, selectionRange),
        scope:
          caller.memberOwner === undefined
            ? undefined
            : { kind: "member", owner: caller.memberOwner }
      };
      scopes.push({
        id: callerTarget.id,
        name: callerTarget.name,
        displayName: callerTarget.displayName,
        kind: callerTarget.kind,
        uri,
        range,
        selectionRange,
        references,
        source: "index",
        target: callerTarget
      });
    }
    scopes.sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0 ? nameOrder : left.uri.fsPath.localeCompare(right.uri.fsPath);
    });
    return { scopes };
  }

  private databaseDirectoryUri(): vscode.Uri {
    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return firstWorkspaceFolder === undefined
      ? this.fallbackStorageUri
      : vscode.Uri.joinPath(firstWorkspaceFolder.uri, ".symbol-dependency-tree");
  }

  private databaseUri(directory = this.databaseDirectoryUri()): vscode.Uri {
    const digest = createHash("sha256")
      .update(workspaceIdentity())
      .digest("hex")
      .slice(0, 20);
    return vscode.Uri.joinPath(directory, `call-index-${digest}.json`);
  }

  private async loadOrBuild(token: vscode.CancellationToken): Promise<void> {
    const loaded = await this.load();
    if (!loaded && !token.isCancellationRequested) {
      await this.refresh(token, true);
    }
  }

  private async load(): Promise<boolean> {
    if (this.loaded) {
      return this.databaseAvailable;
    }
    this.setStatus({ phase: "loading", stats: this.stats() });
    this.loaded = true;
    const databaseUri = this.databaseUri();
    const legacyDatabaseUri = this.databaseUri(this.fallbackStorageUri);
    let sourceUri = databaseUri;
    let migrated = false;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(databaseUri);
      } catch {
        if (databaseUri.toString() === legacyDatabaseUri.toString()) {
          return false;
        }
        bytes = await vscode.workspace.fs.readFile(legacyDatabaseUri);
        sourceUri = legacyDatabaseUri;
        migrated = true;
      }
      const persisted = JSON.parse(Buffer.from(bytes).toString("utf8")) as PersistedCallIndex;
      if (persisted.version !== databaseVersion) {
        return false;
      }
      for (const file of persisted.files) {
        this.files.set(file.uri, file);
      }
      this.rebuildLookup();
      this.databaseAvailable = true;
      if (migrated) {
        try {
          await this.save();
          this.output.appendLine(
            `Persistent symbol index copied into the first workspace folder: ${databaseUri.toString()}`
          );
        } catch (error) {
          this.output.appendLine(
            `Unable to copy the legacy symbol index into the workspace: ${String(error)}`
          );
        }
      }
      const stats = this.stats();
      this.setStatus({ phase: "ready", stats });
      this.output.appendLine(
        `Persistent call index loaded from ${sourceUri.toString()}: ${stats.files} files, ${stats.functions} functions, ${stats.calls} calls`
      );
      return true;
    } catch {
      // The first run has no database yet.
      return false;
    }
  }

  private async refresh(token: vscode.CancellationToken, force: boolean): Promise<void> {
    const started = Date.now();
    await this.load();
    this.setStatus({
      phase: "building",
      stats: this.stats(),
      processedFiles: 0,
      totalFiles: 0
    });
    const { include, exclude } = configurationGlobs();
    const uris = await vscode.workspace.findFiles(include, exclude, undefined, token);
    let processedFiles = 0;
    this.setStatus({
      phase: "building",
      stats: this.stats(),
      processedFiles,
      totalFiles: uris.length
    });
    const seen = new Set(uris.map((uri) => uri.toString()));
    for (const key of this.files.keys()) {
      if (!seen.has(key)) {
        this.files.delete(key);
      }
    }

    for (const batch of chunks(uris, updateConcurrency)) {
      if (token.isCancellationRequested) {
        this.setStatus({
          phase: "cancelled",
          stats: this.stats(),
          processedFiles,
          totalFiles: uris.length
        });
        return;
      }
      await Promise.all(
        batch.map(async (uri) => {
          const stat = await vscode.workspace.fs.stat(uri);
          const existing = this.files.get(uri.toString());
          if (
            !force &&
            existing !== undefined &&
            existing.mtime === stat.mtime &&
            existing.size === stat.size
          ) {
            return;
          }
          await this.indexFile(uri, stat);
        })
      );
      processedFiles += batch.length;
      this.setStatus({
        phase: "building",
        stats: this.stats(),
        processedFiles,
        totalFiles: uris.length
      });
    }
    if (token.isCancellationRequested) {
      this.setStatus({
        phase: "cancelled",
        stats: this.stats(),
        processedFiles,
        totalFiles: uris.length
      });
      return;
    }
    this.rebuildLookup();
    await this.save();
    const stats = this.stats();
    this.setStatus({ phase: "ready", stats });
    this.output.appendLine(
      `Persistent call index ready: ${stats.files} files, ${stats.functions} functions, ${stats.calls} calls in ${Date.now() - started} ms`
    );
    this.changes.fire();
  }

  private async indexFile(uri: vscode.Uri, stat?: vscode.FileStat): Promise<void> {
    const currentStat = stat ?? (await vscode.workspace.fs.stat(uri));
    const bytes = await vscode.workspace.fs.readFile(uri);
    const scanned = scanCallIndexFile(Buffer.from(bytes).toString("utf8"));
    const callerIndexes = new Map(
      scanned.definitions.map((definition, index) => [definition.selectionStart, index])
    );
    this.files.set(uri.toString(), {
      uri: uri.toString(),
      mtime: currentStat.mtime,
      size: currentStat.size,
      definitions: scanned.definitions,
      calls: scanned.calls.flatMap((call) => {
        const callerIndex = callerIndexes.get(call.callerSelectionStart);
        return callerIndex === undefined
          ? []
          : [{
              callee: call.callee,
              offset: call.offset,
              kind: call.kind,
              scope: call.scope,
              implicitMemberOwner: call.implicitMemberOwner,
              callerIndex
            }];
      })
    });
  }

  private rebuildLookup(): void {
    this.callsByCallee.clear();
    this.definitionsByName.clear();
    for (const file of this.files.values()) {
      for (const definition of file.definitions) {
        const values = this.definitionsByName.get(definition.name);
        const value = { file, definition };
        if (values === undefined) {
          this.definitionsByName.set(definition.name, [value]);
        } else {
          values.push(value);
        }
      }
      for (const call of file.calls) {
        const values = this.callsByCallee.get(call.callee);
        const value = { file, call };
        if (values === undefined) {
          this.callsByCallee.set(call.callee, [value]);
        } else {
          values.push(value);
        }
      }
    }
  }

  private async save(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.databaseDirectoryUri());
    const persisted: PersistedCallIndex = {
      version: databaseVersion,
      files: [...this.files.values()]
    };
    await vscode.workspace.fs.writeFile(
      this.databaseUri(),
      Buffer.from(JSON.stringify(persisted), "utf8")
    );
    this.databaseAvailable = true;
  }

  private scheduleUpdate(uri: vscode.Uri): void {
    if (!this.loaded) {
      return;
    }
    const key = uri.toString();
    const existing = this.pendingUpdates.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.pendingUpdates.set(
      key,
      setTimeout(() => {
        this.pendingUpdates.delete(key);
        void this.updateFile(uri);
      }, 350)
    );
  }

  private async updateFile(uri: vscode.Uri): Promise<void> {
    try {
      await this.indexFile(uri);
      this.rebuildLookup();
      await this.save();
      this.setStatus({ phase: "ready", stats: this.stats() });
      this.changes.fire();
    } catch (error) {
      this.setStatus({
        phase: "error",
        stats: this.stats(),
        detail: `Unable to update ${uri.fsPath}: ${String(error)}`
      });
      this.output.appendLine(`Persistent index update failed for ${uri.toString()}: ${String(error)}`);
    }
  }

  private setStatus(status: PersistentIndexStatus): void {
    this.currentStatus = status;
    this.statusChanges.fire(status);
  }
}
