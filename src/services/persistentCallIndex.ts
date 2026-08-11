import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  symbolKey,
  type ReferenceHit,
  type ScopeReference,
  type TargetSymbol
} from "../model/symbolTypes";
import type {
  IndexedFileRecord,
  PersistentIndexDocument,
  StoredCallSite
} from "../model/persistentIndexTypes";
import {
  scanCallIndexFile,
  type IndexedFunctionDefinition
} from "../utils/callIndexScanner";
import {
  decodeCompactCallIndex,
  encodeCompactCallIndex,
  isCompactCallIndex,
  legacyCallIndexVersion
} from "../utils/compactCallIndex";
import type {
  IndexedMemberOwnerPath,
  IndexedSymbolScope
} from "../utils/cppSymbolScopes";
import {
  decodeCompressedOrPlainJson,
  encodeCompressedJson
} from "../utils/compressedJson";
import {
  buildExcludeGlob,
  buildExtensionGlob,
  normalizeExtension
} from "../utils/exclusions";
import { shortSymbolName } from "../utils/symbolNames";
import {
  virtualMemberKey,
  virtualMemberOwnersMatch
} from "../utils/virtualDispatch";

const updateConcurrency = 12;
const journalCompactionEntries = 256;
const journalCompactionBytes = 2 * 1024 * 1024;

interface LegacyPersistedCallIndex {
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

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    folder.uri.toString()
  );
}

function storageIdentity(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "global";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function sameValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function configuredExtensions(): string[] {
  const configuration = vscode.workspace.getConfiguration("symbolDependencyTree");
  return configuration.get<string[]>("persistentIndex.fileExtensions", [
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
}

function configurationGlobs(): { include: string; exclude: string } {
  const extensions = configuredExtensions();
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

function isIndexedUri(uri: vscode.Uri): boolean {
  const extensions = configuredExtensions().map(normalizeExtension).filter(Boolean);
  return (
    extensions.length === 0 ||
    extensions.some((extension) => uri.path.toLowerCase().endsWith(extension))
  );
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
  targetMemberOwnerPath: IndexedMemberOwnerPath | undefined,
  canonicalUri: vscode.Uri,
  candidate: IndexedCallWithFile,
  memberName: string,
  memberTypes: ReadonlyMap<string, string | undefined>,
  objectTypes: ReadonlyMap<string, string | undefined>,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
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
    const targetOwner = resolveMemberOwner(
      targetScope,
      targetMemberOwnerPath,
      memberTypes,
      objectTypes
    );
    const candidateOwner = resolveMemberOwner(
      candidate.call.scope,
      candidate.call.memberOwnerPath,
      memberTypes,
      objectTypes
    );
    const explicitMatch =
      targetOwner !== undefined &&
      candidateOwner !== undefined &&
      virtualMemberOwnersMatch(
        targetOwner,
        candidateOwner,
        memberName,
        baseTypes,
        virtualMembers
      );
    const implicitOwner = candidate.call.implicitMemberOwner;
    const implicitMatch =
      targetOwner !== undefined &&
      implicitOwner !== undefined &&
      virtualMemberOwnersMatch(
        targetOwner,
        implicitOwner,
        memberName,
        baseTypes,
        virtualMembers
      );
    return explicitMatch || implicitMatch;
  }
  return candidate.call.scope === undefined;
}

function memberTypeKey(owner: string, member: string): string {
  return `${owner}\u0000${member}`;
}

function resolveMemberOwner(
  scope: IndexedSymbolScope | undefined,
  path: IndexedMemberOwnerPath | undefined,
  memberTypes: ReadonlyMap<string, string | undefined>,
  objectTypes: ReadonlyMap<string, string | undefined>
): string | undefined {
  if (scope?.kind !== "member" || path === undefined) {
    return scope?.kind === "member"
      ? objectTypes.get(scope.owner) ?? scope.owner
      : undefined;
  }
  let owner = objectTypes.get(path.rootOwner) ?? path.rootOwner;
  for (const member of path.members) {
    const typeName = memberTypes.get(memberTypeKey(owner, member));
    if (typeName === undefined) {
      return objectTypes.get(scope.owner) ?? scope.owner;
    }
    owner = typeName;
  }
  return owner;
}

export class PersistentCallIndex implements vscode.Disposable {
  private readonly files = new Map<string, IndexedFileRecord>();
  private readonly callsByCallee = new Map<string, IndexedCallWithFile[]>();
  private readonly definitionsByName = new Map<string, IndexedDefinitionWithFile[]>();
  private readonly memberTypes = new Map<string, string | undefined>();
  private readonly objectTypes = new Map<string, string | undefined>();
  private readonly baseTypes = new Map<string, Set<string>>();
  private readonly virtualMembers = new Set<string>();
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly statusChanges = new vscode.EventEmitter<PersistentIndexStatus>();
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly workspaceFolderChanges: vscode.Disposable;
  private readonly pendingUpdates = new Map<string, NodeJS.Timeout>();
  private readonly journalEntries = new Map<
    string,
    IndexedFileRecord | undefined
  >();
  private readonly legacySources = new Set<string>();
  private loaded = false;
  private databaseAvailable = false;
  private persistedRoots: readonly string[] = [];
  private snapshotLocation: string | undefined;
  private readyPromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
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
      void this.enqueueMutation(() => this.deleteFile(uri)).catch(
        (error: unknown) => this.reportBackgroundFailure(error)
      );
    });
    this.workspaceFolderChanges = vscode.workspace.onDidChangeWorkspaceFolders(
      (event) => {
        const operation = this.enqueueMutation(async () => {
          const source = new vscode.CancellationTokenSource();
          try {
            if (!this.loaded) {
              await this.loadOrBuild(source.token);
            }
            await this.updateWorkspaceFolders(event);
          } finally {
            source.dispose();
          }
        });
        void this.trackReady(operation).catch((error: unknown) => {
          this.output.appendLine(
            `Workspace-folder index update failed: ${String(error)}`
          );
        });
      }
    );
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(task, task);
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private trackReady(operation: Promise<void>): Promise<void> {
    this.readyPromise = operation.catch((error: unknown) => {
      this.readyPromise = undefined;
      this.setStatus({
        phase: "error",
        stats: this.stats(),
        detail: String(error)
      });
      throw error;
    });
    return this.readyPromise;
  }

  public dispose(): void {
    for (const timeout of this.pendingUpdates.values()) {
      clearTimeout(timeout);
    }
    this.pendingUpdates.clear();
    this.watcher.dispose();
    this.workspaceFolderChanges.dispose();
    this.changes.dispose();
    this.statusChanges.dispose();
  }

  public async ensureReady(token: vscode.CancellationToken): Promise<void> {
    if (this.readyPromise === undefined) {
      this.trackReady(
        this.enqueueMutation(() => this.loadOrBuild(token))
      );
    }
    await this.readyPromise;
  }

  public async rebuild(token: vscode.CancellationToken): Promise<PersistentIndexStats> {
    this.trackReady(
      this.enqueueMutation(() => this.refresh(token, true))
    );
    await this.readyPromise;
    return this.stats();
  }

  public scheduleDocumentUpdate(document: vscode.TextDocument, delayMs = 350): void {
    const uri = document.uri;
    if (
      vscode.workspace.getWorkspaceFolder(uri) === undefined ||
      !isIndexedUri(uri)
    ) {
      return;
    }
    this.scheduleMutation(uri, delayMs, () =>
      document.isClosed ? this.updateFile(uri) : this.updateDocument(document)
    );
  }

  public scheduleFileUpdate(uri: vscode.Uri, delayMs = 0): void {
    if (
      vscode.workspace.getWorkspaceFolder(uri) === undefined ||
      !isIndexedUri(uri)
    ) {
      return;
    }
    this.scheduleMutation(uri, delayMs, () => this.updateFile(uri));
  }

  public status(): PersistentIndexStatus {
    return this.currentStatus;
  }

  public stats(): PersistentIndexStats {
    let functions = 0;
    let calls = 0;
    for (const file of this.files.values()) {
      functions += file.definitions.filter(
        (definition) => definition.kind === "function"
      ).length;
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
    const functionTarget = targetDefinition?.definition.kind === "function";
    const candidates = (this.callsByCallee.get(queryName) ?? []).filter(
      (candidate) =>
        (!functionTarget || candidate.call.kind === "callable") &&
        (!staticTarget || candidate.file.uri === targetDefinition.file.uri) &&
        callMatchesScope(
          target.scope,
          target.memberOwnerPath,
          canonicalUri,
          candidate,
          queryName,
          this.memberTypes,
          this.objectTypes,
          this.baseTypes,
          this.virtualMembers
        )
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
      const callerKind =
        caller.kind === "initializer"
          ? vscode.SymbolKind.Variable
          : caller.kind === "type"
            ? caller.typeKind === "class"
              ? vscode.SymbolKind.Class
              : caller.typeKind === "enum"
                ? vscode.SymbolKind.Enum
                : vscode.SymbolKind.Struct
            : caller.memberOwner === undefined
              ? vscode.SymbolKind.Function
              : vscode.SymbolKind.Method;
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
          callerKind
        ),
        name: caller.name,
        displayName: caller.name,
        kind: callerKind,
        uri,
        range,
        selectionRange,
        definition: new vscode.Location(uri, selectionRange),
        scope:
          caller.kind === "initializer" || caller.memberOwner === undefined
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

  private snapshotUri(
    directory = this.databaseDirectoryUri()
  ): vscode.Uri {
    return vscode.Uri.joinPath(
      directory,
      `call-index-${digest(storageIdentity())}.json.gz`
    );
  }

  private journalUri(
    directory = this.databaseDirectoryUri()
  ): vscode.Uri {
    return vscode.Uri.joinPath(
      directory,
      `call-index-${digest(storageIdentity())}.delta.json.gz`
    );
  }

  private legacyDatabaseUri(
    directory = this.databaseDirectoryUri(),
    compressed = true
  ): vscode.Uri {
    return vscode.Uri.joinPath(
      directory,
      `call-index-${digest(workspaceIdentity())}.${compressed ? "json.gz" : "json"}`
    );
  }

  private databaseCandidateUris(): readonly vscode.Uri[] {
    const values = [
      this.snapshotUri(),
      this.legacyDatabaseUri(),
      this.legacyDatabaseUri(this.databaseDirectoryUri(), false),
      this.snapshotUri(this.fallbackStorageUri),
      this.legacyDatabaseUri(this.fallbackStorageUri),
      this.legacyDatabaseUri(this.fallbackStorageUri, false)
    ];
    return [
      ...new Map(values.map((uri) => [uri.toString(), uri])).values()
    ];
  }

  private async loadOrBuild(token: vscode.CancellationToken): Promise<void> {
    const loaded = await this.load();
    if (!token.isCancellationRequested) {
      await this.refresh(token, !loaded);
    }
  }

  private async load(): Promise<boolean> {
    if (this.loaded) {
      return this.databaseAvailable;
    }
    this.setStatus({ phase: "loading", stats: this.stats() });
    this.loaded = true;
    const snapshotUri = this.snapshotUri();
    let sourceUri: vscode.Uri | undefined;
    let persisted: PersistentIndexDocument | undefined;
    let compactSource = false;
    for (const candidate of this.databaseCandidateUris()) {
      try {
        const bytes = await vscode.workspace.fs.readFile(candidate);
        const decoded = await decodeCompressedOrPlainJson<unknown>(bytes);
        if (isCompactCallIndex(decoded)) {
          sourceUri = candidate;
          persisted = decodeCompactCallIndex(decoded);
          compactSource = true;
          break;
        }
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          !("version" in decoded) ||
          decoded.version !== legacyCallIndexVersion ||
          !("files" in decoded) ||
          !Array.isArray(decoded.files)
        ) {
          continue;
        }
        sourceUri = candidate;
        persisted = {
          roots: [],
          files: (decoded as LegacyPersistedCallIndex).files,
          deletedUris: []
        };
        break;
      } catch {
        // Try the next stable, workspace-combination, or global candidate.
      }
    }
    if (sourceUri === undefined || persisted === undefined) {
      return false;
    }
    try {
      for (const file of persisted.files) {
        this.files.set(file.uri, file);
      }
      for (const uri of persisted.deletedUris) {
        this.files.delete(uri);
      }
      this.persistedRoots = persisted.roots;
      if (
        compactSource &&
        sourceUri.toString() === snapshotUri.toString()
      ) {
        this.snapshotLocation = sourceUri.toString();
        await this.loadJournal();
      } else {
        this.legacySources.add(sourceUri.toString());
      }
      this.rebuildLookup();
      this.databaseAvailable = true;
      const stats = this.stats();
      this.setStatus({ phase: "ready", stats });
      this.output.appendLine(
        `Persistent call index loaded from ${sourceUri.toString()}: ${stats.files} files, ${stats.functions} functions, ${stats.calls} calls${compactSource ? "" : " (legacy v10 migration pending)"}`
      );
      return true;
    } catch (error) {
      this.output.appendLine(`Unable to load the persistent call index: ${String(error)}`);
      return false;
    }
  }

  private async refresh(token: vscode.CancellationToken, force: boolean): Promise<void> {
    const started = Date.now();
    await this.load();
    const roots = workspaceRoots();
    const rootsChanged = !sameValues(this.persistedRoots, roots);
    this.setStatus({
      phase: "building",
      stats: this.stats(),
      processedFiles: 0,
      totalFiles: 0
    });
    const { include, exclude } = configurationGlobs();
    const uris = await vscode.workspace.findFiles(include, exclude, undefined, token);
    let changed = false;
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
        this.recordDeletion(key);
        changed = true;
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
          const indexed = await this.indexFile(uri, stat);
          this.recordUpsert(indexed);
          changed = true;
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
    if (
      force ||
      changed ||
      rootsChanged ||
      this.snapshotLocation !== this.snapshotUri().toString()
    ) {
      if (force) {
        await this.writeSnapshot();
      } else {
        await this.persistIncremental();
      }
    }
    const stats = this.stats();
    this.setStatus({ phase: "ready", stats });
    this.output.appendLine(
      `Persistent call index ready: ${stats.files} files, ${stats.functions} functions, ${stats.calls} calls in ${Date.now() - started} ms`
    );
    this.changes.fire();
  }

  private async indexFile(
    uri: vscode.Uri,
    stat?: vscode.FileStat
  ): Promise<IndexedFileRecord> {
    const currentStat = stat ?? (await vscode.workspace.fs.stat(uri));
    const bytes = await vscode.workspace.fs.readFile(uri);
    return this.indexSource(
      uri,
      Buffer.from(bytes).toString("utf8"),
      currentStat.mtime,
      currentStat.size
    );
  }

  private indexSource(
    uri: vscode.Uri,
    source: string,
    mtime: number,
    size: number
  ): IndexedFileRecord {
    const scanned = scanCallIndexFile(source);
    const callerIndexes = new Map(
      scanned.definitions.map((definition, index) => [definition.selectionStart, index])
    );
    const indexed: IndexedFileRecord = {
      uri: uri.toString(),
      mtime,
      size,
      definitions: scanned.definitions,
      memberTypes: scanned.declarations.flatMap((declaration) =>
        declaration.scope.kind === "member" &&
        declaration.typeName !== undefined
          ? [{
              owner: declaration.scope.owner,
              member: declaration.name,
              typeName: declaration.typeName
            }]
          : []
      ),
      inheritances: scanned.inheritances,
      objectTypes: scanned.objectTypes.map((objectType) => ({
        name: objectType.name,
        typeName: objectType.typeName
      })),
      virtualMembers: scanned.virtualMembers,
      calls: scanned.calls.flatMap((call) => {
        const callerIndex = callerIndexes.get(call.callerSelectionStart);
        return callerIndex === undefined
          ? []
          : [{
              callee: call.callee,
              offset: call.offset,
              kind: call.kind,
              scope: call.scope,
              memberOwnerPath: call.memberOwnerPath,
              implicitMemberOwner: call.implicitMemberOwner,
              callerIndex
            }];
      })
    };
    this.files.set(uri.toString(), indexed);
    return indexed;
  }

  private rebuildLookup(): void {
    this.callsByCallee.clear();
    this.definitionsByName.clear();
    this.memberTypes.clear();
    this.objectTypes.clear();
    this.baseTypes.clear();
    this.virtualMembers.clear();
    for (const file of this.files.values()) {
      for (const memberType of file.memberTypes) {
        const key = memberTypeKey(memberType.owner, memberType.member);
        if (!this.memberTypes.has(key)) {
          this.memberTypes.set(key, memberType.typeName);
        } else if (this.memberTypes.get(key) !== memberType.typeName) {
          this.memberTypes.set(key, undefined);
        }
      }
      for (const objectType of file.objectTypes ?? []) {
        if (!this.objectTypes.has(objectType.name)) {
          this.objectTypes.set(objectType.name, objectType.typeName);
        } else if (this.objectTypes.get(objectType.name) !== objectType.typeName) {
          this.objectTypes.set(objectType.name, undefined);
        }
      }
      for (const inheritance of file.inheritances ?? []) {
        const bases = this.baseTypes.get(inheritance.derived);
        if (bases === undefined) {
          this.baseTypes.set(inheritance.derived, new Set([inheritance.base]));
        } else {
          bases.add(inheritance.base);
        }
      }
      for (const member of file.virtualMembers ?? []) {
        this.virtualMembers.add(virtualMemberKey(member.owner, member.name));
      }
    }
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

  private async loadJournal(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.journalUri());
      const decoded = await decodeCompressedOrPlainJson<unknown>(bytes);
      const journal = decodeCompactCallIndex(decoded);
      for (const file of journal.files) {
        this.files.set(file.uri, file);
        this.journalEntries.set(file.uri, file);
      }
      for (const uri of journal.deletedUris) {
        this.files.delete(uri);
        this.journalEntries.set(uri, undefined);
      }
      this.persistedRoots = journal.roots;
      this.output.appendLine(
        `Persistent call-index journal loaded: ${journal.files.length} updates, ${journal.deletedUris.length} deletions`
      );
    } catch {
      // A missing or interrupted journal leaves the last atomic snapshot usable.
    }
  }

  private recordUpsert(file: IndexedFileRecord): void {
    this.journalEntries.set(file.uri, file);
  }

  private recordDeletion(uri: string): void {
    this.journalEntries.set(uri, undefined);
  }

  private async persistIncremental(): Promise<void> {
    if (
      this.snapshotLocation !== this.snapshotUri().toString() ||
      this.journalEntries.size >= journalCompactionEntries
    ) {
      await this.writeSnapshot();
      return;
    }
    const document: PersistentIndexDocument = {
      roots: workspaceRoots(),
      files: [...this.journalEntries.values()].flatMap((file) =>
        file === undefined ? [] : [file]
      ),
      deletedUris: [...this.journalEntries.entries()].flatMap(
        ([uri, file]) => file === undefined ? [uri] : []
      )
    };
    const encoded = await encodeCompressedJson(
      encodeCompactCallIndex(document)
    );
    if (encoded.bytes.byteLength >= journalCompactionBytes) {
      await this.writeSnapshot();
      return;
    }
    await this.writeAtomic(this.journalUri(), encoded.bytes);
    this.persistedRoots = document.roots;
    this.databaseAvailable = true;
    this.output.appendLine(
      `Persistent call-index journal saved: ${document.files.length} updates, ${document.deletedUris.length} deletions, ${encoded.bytes.byteLength} bytes`
    );
  }

  private async writeSnapshot(): Promise<void> {
    const document: PersistentIndexDocument = {
      roots: workspaceRoots(),
      files: [...this.files.values()],
      deletedUris: []
    };
    const encoded = await encodeCompressedJson(
      encodeCompactCallIndex(document)
    );
    const snapshotUri = this.snapshotUri();
    await this.writeAtomic(snapshotUri, encoded.bytes);
    try {
      await vscode.workspace.fs.delete(this.journalUri());
    } catch {
      // The first compact snapshot has no journal yet.
    }
    this.journalEntries.clear();
    this.persistedRoots = document.roots;
    this.snapshotLocation = snapshotUri.toString();
    this.databaseAvailable = true;
    await this.removeLegacyDatabaseFiles();
    this.output.appendLine(
      `Persistent compact call index saved: ${encoded.uncompressedBytes} -> ${encoded.bytes.byteLength} bytes`
    );
  }

  private async writeAtomic(
    target: vscode.Uri,
    bytes: Uint8Array
  ): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.databaseDirectoryUri());
    const temporary = target.with({ path: `${target.path}.tmp` });
    await vscode.workspace.fs.writeFile(temporary, bytes);
    await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
  }

  private async removeLegacyDatabaseFiles(): Promise<void> {
    const activeSnapshot = this.snapshotUri().toString();
    const activeJournal = this.journalUri().toString();
    const candidates = new Map<string, vscode.Uri>(
      [
        ...this.databaseCandidateUris(),
        ...[...this.legacySources].map((uri) => vscode.Uri.parse(uri))
      ].map((uri) => [uri.toString(), uri])
    );
    try {
      const directory = this.databaseDirectoryUri();
      const entries = await vscode.workspace.fs.readDirectory(directory);
      for (const [name, type] of entries) {
        if (
          type === vscode.FileType.File &&
          /^call-index-[a-f0-9]{20}(?:\.delta)?\.json(?:\.gz)?$/u.test(name)
        ) {
          const uri = vscode.Uri.joinPath(directory, name);
          candidates.set(uri.toString(), uri);
        }
      }
    } catch {
      // A newly created storage directory has no additional legacy files.
    }
    for (const [key, uri] of candidates) {
      if (key === activeSnapshot || key === activeJournal) {
        continue;
      }
      try {
        await vscode.workspace.fs.delete(uri);
        this.output.appendLine(`Removed legacy symbol index: ${uri.toString()}`);
      } catch {
        // Missing or inaccessible legacy files need no cleanup.
      }
    }
    this.legacySources.clear();
  }

  private async updateWorkspaceFolders(
    event: vscode.WorkspaceFoldersChangeEvent
  ): Promise<void> {
    const started = Date.now();
    const { include, exclude } = configurationGlobs();
    const addedUris = (
      await Promise.all(
        event.added.map((folder) =>
          vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, include),
            exclude
          )
        )
      )
    ).flat();
    let changed = false;
    let processedFiles = 0;
    this.setStatus({
      phase: "building",
      stats: this.stats(),
      processedFiles,
      totalFiles: addedUris.length,
      detail: "Updating workspace folders"
    });

    for (const [key, file] of this.files) {
      if (
        vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(file.uri)) ===
        undefined
      ) {
        this.files.delete(key);
        this.recordDeletion(key);
        changed = true;
      }
    }

    for (const batch of chunks(addedUris, updateConcurrency)) {
      await Promise.all(
        batch.map(async (uri) => {
          const stat = await vscode.workspace.fs.stat(uri);
          const existing = this.files.get(uri.toString());
          if (
            existing !== undefined &&
            existing.mtime === stat.mtime &&
            existing.size === stat.size
          ) {
            return;
          }
          const indexed = await this.indexFile(uri, stat);
          this.recordUpsert(indexed);
          changed = true;
        })
      );
      processedFiles += batch.length;
      this.setStatus({
        phase: "building",
        stats: this.stats(),
        processedFiles,
        totalFiles: addedUris.length,
        detail: "Updating workspace folders"
      });
    }

    const rootsChanged = !sameValues(this.persistedRoots, workspaceRoots());
    if (
      changed ||
      rootsChanged ||
      this.snapshotLocation !== this.snapshotUri().toString()
    ) {
      this.rebuildLookup();
      await this.persistIncremental();
      this.changes.fire();
    }
    const stats = this.stats();
    this.setStatus({ phase: "ready", stats });
    this.output.appendLine(
      `Workspace-folder index update ready: ${event.added.length} added roots, ${event.removed.length} removed roots, ${stats.files} files in ${Date.now() - started} ms`
    );
  }

  private async deleteFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (!this.files.delete(key)) {
      return;
    }
    this.recordDeletion(key);
    this.rebuildLookup();
    await this.persistIncremental();
    this.setStatus({ phase: "ready", stats: this.stats() });
    this.changes.fire();
  }

  private scheduleUpdate(uri: vscode.Uri): void {
    if (!this.loaded) {
      return;
    }
    this.scheduleFileUpdate(uri, 350);
  }

  private scheduleMutation(
    uri: vscode.Uri,
    delayMs: number,
    mutation: () => Promise<void>
  ): void {
    const key = uri.toString();
    const existing = this.pendingUpdates.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.pendingUpdates.set(
      key,
      setTimeout(() => {
        this.pendingUpdates.delete(key);
        void this.enqueueMutation(mutation).catch(
          (error: unknown) => this.reportBackgroundFailure(error)
        );
      }, delayMs)
    );
  }

  private async updateFile(uri: vscode.Uri): Promise<void> {
    try {
      if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
        return;
      }
      const stat = await vscode.workspace.fs.stat(uri);
      const existing = this.files.get(uri.toString());
      if (
        existing !== undefined &&
        existing.mtime === stat.mtime &&
        existing.size === stat.size
      ) {
        return;
      }
      const indexed = await this.indexFile(uri, stat);
      this.recordUpsert(indexed);
      this.rebuildLookup();
      await this.persistIncremental();
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

  private async updateDocument(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri;
    try {
      if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
        return;
      }
      const source = document.getText();
      const bytes = Buffer.from(source, "utf8");
      const stat = await vscode.workspace.fs.stat(uri);
      const indexed = this.indexSource(
        uri,
        source,
        document.isDirty ? -document.version : stat.mtime,
        bytes.byteLength
      );
      this.recordUpsert(indexed);
      this.rebuildLookup();
      await this.persistIncremental();
      this.setStatus({ phase: "ready", stats: this.stats() });
      this.output.appendLine(
        `Document index updated: ${uri.toString()}${document.isDirty ? " (unsaved)" : ""}`
      );
      this.changes.fire();
    } catch (error) {
      this.setStatus({
        phase: "error",
        stats: this.stats(),
        detail: `Unable to update ${uri.fsPath}: ${String(error)}`
      });
      this.output.appendLine(`Document index update failed for ${uri.toString()}: ${String(error)}`);
    }
  }

  private setStatus(status: PersistentIndexStatus): void {
    this.currentStatus = status;
    this.statusChanges.fire(status);
  }

  private reportBackgroundFailure(error: unknown): void {
    this.setStatus({
      phase: "error",
      stats: this.stats(),
      detail: String(error)
    });
    this.output.appendLine(`Persistent index background update failed: ${String(error)}`);
  }
}
