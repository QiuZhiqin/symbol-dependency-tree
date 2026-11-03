import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  symbolKey,
  type ReferenceHit,
  type ScopeReference,
  type TargetSymbol
} from "../model/symbolTypes";
import type { IndexedFileRecord } from "../model/persistentIndexTypes";
import {
  scanCallIndexFile,
  type IndexedFunctionDefinition
} from "../utils/callIndexScanner";
import type {
  IndexedMemberOwnerPath,
  IndexedSymbolScope
} from "../utils/cppSymbolScopes";
import {
  buildExcludeGlob,
  buildExtensionGlob,
  normalizeExtension
} from "../utils/exclusions";
import { countArgumentsAfterName } from "../utils/arityMatcher";
import { calledMemberOwner, memberTypeOf } from "../utils/smartPointers";
import { shortSymbolName } from "../utils/symbolNames";
import {
  definitionOwnerMatchesTarget,
  virtualMemberOwnersMatch,
  type VirtualDispatchIndex
} from "../utils/virtualDispatch";
import {
  openCallIndexDatabase,
  type CallIndexDatabase,
  type FileTypeContributions,
  type IndexedCallWithFile,
  type IndexedDefinitionWithFile,
  type StoredFileState
} from "./callIndexDatabase";
import { memberTypeKey, TypeLookup } from "./typeLookup";

const updateConcurrency = 12;
const bytesPerMegabyte = 1024 * 1024;

type FileChanges = Map<string, IndexedFileRecord | undefined>;
type FileUpdate = (changes: FileChanges) => Promise<void>;

/**
 * What one write transaction changes in memory once it has committed. New type
 * facts are read back from the database after the commit instead of being kept
 * here, so a long rebuild does not hold every scanned file in memory.
 */
interface PendingPublication {
  /** A rebuild replaces the whole index instead of updating the published one. */
  readonly reset: boolean;
  readonly removed: FileTypeContributions[];
  readonly states: Map<string, StoredFileState | undefined>;
}

/** What one file needs in the write transaction, decided before anything is written. */
type PreparedFile =
  | { readonly kind: "unchanged" }
  | { readonly kind: "remove"; readonly key: string }
  | { readonly kind: "write"; readonly record: IndexedFileRecord };

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
  readonly targetDefinition?: vscode.Location;
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

/** Files larger than this are left out of the index; `0` disables the limit. */
function maxIndexedFileBytes(): number {
  const megabytes = vscode.workspace
    .getConfiguration("symbolDependencyTree")
    .get<number>("persistentIndex.maxFileSizeMB", 4);
  return megabytes > 0 ? megabytes * bytesPerMegabyte : Number.POSITIVE_INFINITY;
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
  dispatch: VirtualDispatchIndex
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
      memberName,
      memberTypes,
      objectTypes
    );
    const candidateOwner = resolveMemberOwner(
      candidate.call.scope,
      candidate.call.memberOwnerPath,
      memberName,
      memberTypes,
      objectTypes
    );
    const explicitMatch =
      targetOwner !== undefined &&
      candidateOwner !== undefined &&
      virtualMemberOwnersMatch(targetOwner, candidateOwner, memberName, dispatch);
    const implicitOwner = candidate.call.implicitMemberOwner;
    const implicitMatch =
      targetOwner !== undefined &&
      implicitOwner !== undefined &&
      virtualMemberOwnersMatch(targetOwner, implicitOwner, memberName, dispatch);
    return explicitMatch || implicitMatch;
  }
  return candidate.call.scope === undefined;
}

/**
 * The type whose member `memberName` the reference reaches. The first member
 * of a path rooted at the enclosing class or namespace may instead be a
 * file-scope object declared in another file.
 */
function resolveMemberOwner(
  scope: IndexedSymbolScope | undefined,
  path: IndexedMemberOwnerPath | undefined,
  memberName: string,
  memberTypes: ReadonlyMap<string, string | undefined>,
  objectTypes: ReadonlyMap<string, string | undefined>
): string | undefined {
  if (scope?.kind !== "member") {
    return undefined;
  }
  const fallback = (): string =>
    calledMemberOwner(objectTypes.get(scope.owner) ?? scope.owner, memberName);
  if (path === undefined) {
    return fallback();
  }
  const memberType = (owner: string, member: string): string | undefined =>
    memberTypes.get(memberTypeKey(owner, member));
  let owner = objectTypes.get(path.rootOwner) ?? path.rootOwner;
  for (const [index, member] of path.members.entries()) {
    const typeName =
      memberTypeOf(owner, member, memberType) ??
      (index === 0 ? objectTypes.get(member) : undefined);
    if (typeName === undefined) {
      return fallback();
    }
    owner = typeName;
  }
  return calledMemberOwner(owner, memberName);
}

export class PersistentCallIndex implements vscode.Disposable {
  private database: CallIndexDatabase | undefined;
  private readonly fileStates = new Map<string, StoredFileState>();
  private readonly types = new TypeLookup();
  private totals: PersistentIndexStats = { files: 0, functions: 0, calls: 0 };
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly statusChanges = new vscode.EventEmitter<PersistentIndexStatus>();
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly workspaceFolderChanges: vscode.Disposable;
  private readonly pendingUpdates = new Map<string, NodeJS.Timeout>();
  private readonly pendingMutations = new Map<string, FileUpdate>();
  private flushTimer: NodeJS.Timeout | undefined;
  private loaded = false;
  private databaseAvailable = false;
  private legacyFilesRemoved = false;
  private persistedRoots: readonly string[] = [];
  private readyPromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private currentStatus: PersistentIndexStatus = {
    phase: "idle",
    stats: { files: 0, functions: 0, calls: 0 }
  };

  public readonly onDidChange = this.changes.event;
  public readonly onDidStatusChange = this.statusChanges.event;

  /**
   * @param storageUri local directory that holds the index database
   * @param legacyStorageUri global storage that older versions used when no folder was open
   */
  public constructor(
    private readonly storageUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly legacyStorageUri: vscode.Uri = storageUri
  ) {
    const { include } = configurationGlobs();
    this.watcher = vscode.workspace.createFileSystemWatcher(include);
    this.watcher.onDidCreate((uri) => this.scheduleUpdate(uri));
    this.watcher.onDidChange((uri) => this.scheduleUpdate(uri));
    this.watcher.onDidDelete((uri) => {
      this.scheduleMutation(uri, 0, (changes) => this.deleteFile(uri, changes));
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
    clearTimeout(this.flushTimer);
    this.pendingMutations.clear();
    this.watcher.dispose();
    this.workspaceFolderChanges.dispose();
    this.changes.dispose();
    this.statusChanges.dispose();
    this.database?.close();
    this.database = undefined;
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

  public scheduleDocumentUpdate(document: vscode.TextDocument, delayMs = 350): boolean {
    const uri = document.uri;
    if (
      vscode.workspace.getWorkspaceFolder(uri) === undefined ||
      !isIndexedUri(uri)
    ) {
      return false;
    }
    this.scheduleMutation(uri, delayMs, (changes) =>
      document.isClosed ? this.updateFile(uri, changes) : this.updateDocument(document, changes)
    );
    return true;
  }

  public scheduleFileUpdate(uri: vscode.Uri, delayMs = 0): void {
    if (
      vscode.workspace.getWorkspaceFolder(uri) === undefined ||
      !isIndexedUri(uri)
    ) {
      return;
    }
    this.scheduleMutation(uri, delayMs, (changes) => this.updateFile(uri, changes));
  }

  public status(): PersistentIndexStatus {
    return this.currentStatus;
  }

  /**
   * Resolves the defining location of a member call such as
   * `m_sta_wlan_pool.reserve_vbss()` from another file.
   *
   * Walks the member-owner path (`ApManager::m_sta_wlan_pool`) through the
   * indexed member types to find the receiver's type, then returns the
   * unique indexed function definition for that member when one exists.
   */
  public async resolveMemberDefinition(
    target: TargetSymbol,
    token: vscode.CancellationToken
  ): Promise<vscode.Location | undefined> {
    await this.ensureReady(token);
    if (token.isCancellationRequested) {
      return undefined;
    }
    const queryName = shortSymbolName(target.name);
    const memberOwner = resolveMemberOwner(
      target.scope,
      target.memberOwnerPath,
      queryName,
      this.types.memberTypes,
      this.types.objectTypes
    );
    if (memberOwner === undefined) {
      return undefined;
    }
    const definitions = this.requireDatabase().definitionsByName(queryName);
    const matching = definitions.filter(
      (candidate) => candidate.definition.memberOwner === memberOwner
    );
    const definition =
      matching.length === 1 ? matching[0] : undefined;
    if (definition === undefined) {
      return undefined;
    }
    const uri = vscode.Uri.parse(definition.file.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    return new vscode.Location(
      uri,
      new vscode.Range(
        document.positionAt(definition.definition.selectionStart),
        document.positionAt(definition.definition.selectionEnd)
      )
    );
  }

  public stats(): PersistentIndexStats {
    return this.totals;
  }

  public async query(
    target: TargetSymbol,
    token: vscode.CancellationToken
  ): Promise<PersistentIndexQueryResult> {
    await this.ensureReady(token);
    if (token.isCancellationRequested) {
      return { scopes: [] };
    }

    const database = this.requireDatabase();
    const queryName = shortSymbolName(target.name);
    const canonicalUri = target.definition?.uri ?? target.uri;
    const targetFile = database.fileDefinitions(canonicalUri.toString());
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
    // An implicit member owner (a bare call inside a member function) can be
    // a free function the enclosing class never declared. Without an explicit
    // receiver path, treat the target as member-scoped only when the owner
    // is a real indexed type (class/struct, not a namespace) that — or one of
    // whose ancestors — actually declares that member.
    const ownerIsKnownType = (owner: string): boolean =>
      database.definitionsByName(owner).some(
        (candidate) => candidate.definition.kind === "type"
      );
    const scopeOwnerDeclaresMember = (owner: string): boolean => {
      const pending = [owner];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current)) {
          continue;
        }
        visited.add(current);
        if (this.types.memberTypes.has(memberTypeKey(current, queryName))) {
          return true;
        }
        pending.push(...(this.types.baseTypes.get(current) ?? []));
      }
      return false;
    };
    const effectiveScope: IndexedSymbolScope | undefined =
      target.scope?.kind === "member" &&
      target.memberOwnerPath === undefined &&
      ownerIsKnownType(target.scope.owner) &&
      !scopeOwnerDeclaresMember(target.scope.owner)
        ? undefined
        : target.scope;
    const targetMemberOwner =
      effectiveScope?.kind === "member"
        ? resolveMemberOwner(
            effectiveScope,
            target.memberOwnerPath,
            queryName,
            this.types.memberTypes,
            this.types.objectTypes
          )
        : undefined;
    const definitionMatchesTargetOwner = (definition: IndexedFunctionDefinition): boolean =>
      definitionOwnerMatchesTarget(
        targetMemberOwner,
        definition.memberOwner,
        queryName,
        this.types.dispatch
      );
    const nameDefinitions = database
      .definitionsByName(queryName)
      .filter((candidate) => definitionMatchesTargetOwner(candidate.definition));
    // Macros were not indexed before: one binds the name only when it has no
    // function, initializer or type definition, whichever way the target was
    // reached (exact position, same file or anywhere).
    const macrosBind = nameDefinitions.every((candidate) => candidate.definition.kind === "macro");
    const bindable = (definition: IndexedFunctionDefinition): boolean =>
      macrosBind || definition.kind !== "macro";
    const sameFileDefinitions =
      targetFile?.definitions.filter(
        (definition) =>
          definition.name === queryName &&
          definitionMatchesTargetOwner(definition) &&
          bindable(definition)
      ) ?? [];
    const globalDefinitions = nameDefinitions.filter((candidate) => bindable(candidate.definition));
    const targetCanBeCallable =
      callableKind(target.kind) && target.scope?.kind !== "local";
    const disambiguateByArity = async (
      candidates: readonly IndexedDefinitionWithFile[]
    ): Promise<IndexedDefinitionWithFile | undefined> => {
      if (targetDocument === undefined || targetOffset === undefined) {
        return undefined;
      }
      const callArgumentCount = countArgumentsAfterName(
        targetDocument.getText(),
        targetOffset + queryName.length
      );
      if (callArgumentCount === undefined) {
        return undefined;
      }
      const matches: IndexedDefinitionWithFile[] = [];
      for (const candidate of candidates) {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(candidate.file.uri)
        );
        if (
          countArgumentsAfterName(
            document.getText(),
            candidate.definition.selectionEnd
          ) === callArgumentCount
        ) {
          matches.push(candidate);
        }
      }
      return matches.length === 1 ? matches[0] : undefined;
    };
    const targetDefinition: IndexedDefinitionWithFile | undefined =
      exactDefinition !== undefined && bindable(exactDefinition)
        ? { file: targetFile!, definition: exactDefinition }
        : !targetCanBeCallable
          ? undefined
          : sameFileDefinitions.length === 1
            ? { file: targetFile!, definition: sameFileDefinitions[0]! }
            : sameFileDefinitions.length > 1
              ? await disambiguateByArity(
                  sameFileDefinitions.map((definition) => ({
                    file: targetFile!,
                    definition
                  }))
                )
              : globalDefinitions.length === 1
                ? globalDefinitions[0]!
                : await disambiguateByArity(globalDefinitions);
    const staticTarget = targetDefinition?.definition.isStatic === true;
    const functionTarget = targetDefinition?.definition.kind === "function";
    let targetDefinitionLocation: vscode.Location | undefined;
    if (targetDefinition !== undefined) {
      const definitionUri = vscode.Uri.parse(targetDefinition.file.uri);
      const definitionDocument = await vscode.workspace.openTextDocument(definitionUri);
      targetDefinitionLocation = new vscode.Location(
        definitionUri,
        new vscode.Range(
          definitionDocument.positionAt(targetDefinition.definition.selectionStart),
          definitionDocument.positionAt(targetDefinition.definition.selectionEnd)
        )
      );
    }
    const candidates = database
      .callsByCallee(queryName, {
        callableOnly: functionTarget,
        fileUri: staticTarget
          ? targetDefinition.file.uri
          : effectiveScope?.kind === "local"
            ? canonicalUri.toString()
            : undefined
      })
      .filter((candidate) =>
        callMatchesScope(
          effectiveScope,
          target.memberOwnerPath,
          canonicalUri,
          candidate,
          queryName,
          this.types.memberTypes,
          this.types.objectTypes,
          this.types.dispatch
        )
    );
    const grouped = new Map<string, IndexedCallWithFile[]>();
    for (const candidate of candidates) {
      const key = `${candidate.file.uri}#${candidate.caller.selectionStart}`;
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
      const caller = first.caller;
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
          caller.kind === "initializer"
            ? caller.scope
            : caller.memberOwner === undefined
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
    return { scopes, targetDefinition: targetDefinitionLocation };
  }

  private databasePath(): string {
    return path.join(
      this.storageUri.fsPath,
      `call-index-${digest(storageIdentity())}.sqlite`
    );
  }

  private requireDatabase(): CallIndexDatabase {
    if (this.database === undefined) {
      throw new Error("The symbol index database is not open.");
    }
    return this.database;
  }

  /** Index files written by versions that kept a gzip snapshot under the first workspace folder. */
  private legacyIndexUris(): vscode.Uri[] {
    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const directories = [
      ...(firstWorkspaceFolder === undefined
        ? []
        : [vscode.Uri.joinPath(firstWorkspaceFolder.uri, ".symbol-dependency-tree")]),
      this.legacyStorageUri
    ];
    const snapshot = `call-index-${digest(storageIdentity())}.json.gz`;
    const journal = `call-index-${digest(storageIdentity())}.delta.json.gz`;
    const names = [
      snapshot,
      journal,
      `${snapshot}.tmp`,
      `${journal}.tmp`,
      `call-index-${digest(workspaceIdentity())}.json.gz`,
      `call-index-${digest(workspaceIdentity())}.json`
    ];
    return [
      ...new Map(
        directories
          .flatMap((directory) => names.map((name) => vscode.Uri.joinPath(directory, name)))
          .map((uri) => [uri.toString(), uri])
      ).values()
    ];
  }

  private async removeLegacyIndexFiles(): Promise<void> {
    if (this.legacyFilesRemoved) {
      return;
    }
    this.legacyFilesRemoved = true;
    for (const uri of this.legacyIndexUris()) {
      try {
        await vscode.workspace.fs.delete(uri);
        this.output.appendLine(`Removed legacy symbol index: ${uri.toString()}`);
      } catch {
        // Missing or inaccessible legacy files need no cleanup.
      }
    }
    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (firstWorkspaceFolder !== undefined) {
      try {
        // Only succeeds once the old index directory is empty.
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(firstWorkspaceFolder.uri, ".symbol-dependency-tree"),
          { recursive: false }
        );
      } catch {
        // Keep a directory that still holds other files.
      }
    }
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
    const databasePath = this.databasePath();
    const database = await openCallIndexDatabase(databasePath);
    this.database = database;
    this.loaded = true;
    const states = database.fileStates();
    if (states.size === 0) {
      return false;
    }
    for (const [uri, state] of states) {
      this.fileStates.set(uri, state);
    }
    this.types.add(database.typeContributions());
    this.persistedRoots = database.roots();
    this.totals = database.totals();
    this.databaseAvailable = true;
    const stats = this.stats();
    this.setStatus({ phase: "ready", stats });
    this.output.appendLine(
      `Persistent call index loaded from ${databasePath}: ${stats.files} files, ${stats.functions} functions, ${stats.calls} calls`
    );
    return true;
  }

  private createPublication(reset: boolean): PendingPublication {
    return { reset, removed: [], states: new Map() };
  }

  private writeRecord(
    database: CallIndexDatabase,
    record: IndexedFileRecord,
    publication: PendingPublication
  ): void {
    const previous = database.replaceFile(record);
    if (previous !== undefined) {
      publication.removed.push(previous);
    }
    publication.states.set(record.uri, { mtime: record.mtime, size: record.size });
  }

  private deleteRecord(
    database: CallIndexDatabase,
    uri: string,
    publication: PendingPublication
  ): void {
    const previous = database.deleteFile(uri);
    if (previous !== undefined) {
      publication.removed.push(previous);
    }
    publication.states.set(uri, undefined);
  }

  /** Applies a committed write transaction to the in-memory file states and type lookup. */
  private publish(database: CallIndexDatabase, publication: PendingPublication): void {
    if (publication.reset) {
      this.types.clear();
      this.types.add(database.typeContributions());
      this.fileStates.clear();
    } else {
      for (const contributions of publication.removed) {
        this.types.remove(contributions);
      }
    }
    for (const [uri, state] of publication.states) {
      if (state === undefined) {
        this.fileStates.delete(uri);
        continue;
      }
      this.fileStates.set(uri, state);
      const contributions = publication.reset ? undefined : database.fileTypeContributions(uri);
      if (contributions !== undefined) {
        this.types.add(contributions);
      }
    }
    this.totals = database.totals();
    this.databaseAvailable = true;
  }

  /**
   * Reads and scans `uri` without touching the database. A file that grew past
   * the size limit is removed from the index.
   */
  private async prepareFile(
    uri: vscode.Uri,
    force: boolean,
    skipped: { files: number; bytes: number }
  ): Promise<PreparedFile> {
    const key = uri.toString();
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxIndexedFileBytes()) {
      skipped.files += 1;
      skipped.bytes += stat.size;
      return !force && this.fileStates.has(key) ? { kind: "remove", key } : { kind: "unchanged" };
    }
    const existing = this.fileStates.get(key);
    if (
      !force &&
      existing !== undefined &&
      existing.mtime === stat.mtime &&
      existing.size === stat.size
    ) {
      return { kind: "unchanged" };
    }
    return { kind: "write", record: await this.indexFile(uri, stat) };
  }

  /**
   * Writes one batch into the open transaction only after every file in it has
   * settled, so a failed read can never leave a later write behind its rollback.
   */
  private async writeBatch(
    database: CallIndexDatabase,
    uris: readonly vscode.Uri[],
    force: boolean,
    publication: PendingPublication,
    skipped: { files: number; bytes: number }
  ): Promise<void> {
    const settled = await Promise.allSettled(
      uris.map((uri) => this.prepareFile(uri, force, skipped))
    );
    const prepared: PreparedFile[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      prepared.push(result.value);
    }
    for (const file of prepared) {
      if (file.kind === "remove") {
        this.deleteRecord(database, file.key, publication);
      } else if (file.kind === "write") {
        this.writeRecord(database, file.record, publication);
      }
    }
  }

  private reportSkippedFiles(skipped: { files: number; bytes: number }): void {
    if (skipped.files > 0) {
      this.output.appendLine(
        `Skipped ${skipped.files} files larger than ${maxIndexedFileBytes() / bytesPerMegabyte} MB (${(skipped.bytes / bytesPerMegabyte).toFixed(1)} MB in total); change symbolDependencyTree.persistentIndex.maxFileSizeMB to index them.`
      );
    }
  }

  private async refresh(token: vscode.CancellationToken, force: boolean): Promise<void> {
    const started = Date.now();
    await this.load();
    const database = this.requireDatabase();
    const previousStats = this.stats();
    const roots = workspaceRoots();
    const rootsChanged = !sameValues(this.persistedRoots, roots);
    this.setStatus({
      phase: "building",
      stats: previousStats,
      processedFiles: 0,
      totalFiles: 0
    });
    const { include, exclude } = configurationGlobs();
    const uris = await vscode.workspace.findFiles(include, exclude, undefined, token);
    let processedFiles = 0;
    this.setStatus({
      phase: "building",
      stats: previousStats,
      processedFiles,
      totalFiles: uris.length
    });
    const publication = this.createPublication(force);
    const skipped = { files: 0, bytes: 0 };
    const stopIfCancelled = (): boolean => {
      if (!token.isCancellationRequested) {
        return false;
      }
      // Rolling back keeps the last committed index for this and every other reader.
      database.rollback();
      this.setStatus({
        phase: "cancelled",
        stats: this.stats(),
        processedFiles,
        totalFiles: uris.length
      });
      return true;
    };
    database.begin();
    try {
      if (force) {
        database.clear();
      } else {
        const seen = new Set(uris.map((uri) => uri.toString()));
        for (const key of this.fileStates.keys()) {
          if (!seen.has(key)) {
            this.deleteRecord(database, key, publication);
          }
        }
      }
      for (const batch of chunks(uris, updateConcurrency)) {
        if (stopIfCancelled()) {
          return;
        }
        await this.writeBatch(database, batch, force, publication, skipped);
        processedFiles += batch.length;
        this.setStatus({
          phase: "building",
          stats: previousStats,
          processedFiles,
          totalFiles: uris.length
        });
      }
      if (stopIfCancelled()) {
        return;
      }
      if (force || rootsChanged) {
        database.setRoots(roots);
      }
      database.commit();
    } catch (error) {
      database.rollback();
      throw error;
    }
    this.publish(database, publication);
    this.persistedRoots = roots;
    const contentChanged = force || publication.states.size > 0;
    this.reportSkippedFiles(skipped);
    await this.removeLegacyIndexFiles();
    const stats = this.stats();
    this.setStatus({ phase: "ready", stats });
    this.output.appendLine(
      `Persistent call index ready: ${stats.files} files, ${stats.functions} functions, ${stats.calls} calls in ${Date.now() - started} ms`
    );
    if (contentChanged) {
      this.changes.fire();
    }
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
    // Two definitions found at one name position (gmock's template template
    // parameter `template <class> class MatcherImpl` is read as a class twice)
    // share a caller index, so the same reference would be stored twice.
    const storedCalls = new Set<string>();
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
        const key = `${call.callee}\u0000${callerIndex}\u0000${call.offset}`;
        if (callerIndex === undefined || storedCalls.has(key)) {
          return [];
        }
        storedCalls.add(key);
        return [{
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
    return indexed;
  }

  private async updateWorkspaceFolders(
    event: vscode.WorkspaceFoldersChangeEvent
  ): Promise<void> {
    const started = Date.now();
    const database = this.requireDatabase();
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
    let processedFiles = 0;
    this.setStatus({
      phase: "building",
      stats: this.stats(),
      processedFiles,
      totalFiles: addedUris.length,
      detail: "Updating workspace folders"
    });
    const publication = this.createPublication(false);
    const skipped = { files: 0, bytes: 0 };
    const roots = workspaceRoots();
    const rootsChanged = !sameValues(this.persistedRoots, roots);
    database.begin();
    try {
      for (const key of this.fileStates.keys()) {
        if (vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(key)) === undefined) {
          this.deleteRecord(database, key, publication);
        }
      }
      for (const batch of chunks(addedUris, updateConcurrency)) {
        await this.writeBatch(database, batch, false, publication, skipped);
        processedFiles += batch.length;
        this.setStatus({
          phase: "building",
          stats: this.stats(),
          processedFiles,
          totalFiles: addedUris.length,
          detail: "Updating workspace folders"
        });
      }
      if (rootsChanged) {
        database.setRoots(roots);
      }
      database.commit();
    } catch (error) {
      database.rollback();
      throw error;
    }
    this.publish(database, publication);
    this.persistedRoots = roots;
    this.reportSkippedFiles(skipped);
    if (publication.states.size > 0 || rootsChanged) {
      this.changes.fire();
    }
    const stats = this.stats();
    this.setStatus({ phase: "ready", stats });
    this.output.appendLine(
      `Workspace-folder index update ready: ${event.added.length} added roots, ${event.removed.length} removed roots, ${stats.files} files in ${Date.now() - started} ms`
    );
  }

  private async deleteFile(uri: vscode.Uri, changes: FileChanges): Promise<void> {
    const key = uri.toString();
    if (this.fileStates.has(key)) {
      changes.set(key, undefined);
    }
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
    mutation: FileUpdate
  ): void {
    const key = uri.toString();
    const existing = this.pendingUpdates.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.pendingMutations.set(key, mutation);
    this.pendingUpdates.set(
      key,
      setTimeout(() => {
        this.pendingUpdates.delete(key);
        if (this.flushTimer === undefined) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.enqueueMutation(() => this.flushPendingUpdates()).catch(
              (error: unknown) => this.reportBackgroundFailure(error)
            );
          }, 0);
        }
      }, delayMs)
    );
  }

  private async flushPendingUpdates(): Promise<void> {
    const changes: FileChanges = new Map();
    const ready = [...this.pendingMutations].filter(([key]) => !this.pendingUpdates.has(key));
    for (const [key, mutation] of ready) {
      // A later edit/delete may replace a task while another file is being read.
      if (this.pendingMutations.get(key) !== mutation) {
        continue;
      }
      this.pendingMutations.delete(key);
      await mutation(changes);
    }
    for (const key of changes.keys()) {
      if (this.pendingMutations.has(key)) {
        changes.delete(key);
      }
    }
    if (changes.size === 0) {
      return;
    }
    // No await between begin and commit: the transaction never spans another task.
    const database = this.requireDatabase();
    const publication = this.createPublication(false);
    database.begin();
    try {
      for (const [key, file] of changes) {
        if (file === undefined) {
          this.deleteRecord(database, key, publication);
        } else {
          this.writeRecord(database, file, publication);
        }
      }
      database.commit();
    } catch (error) {
      database.rollback();
      throw error;
    }
    this.publish(database, publication);
    this.setStatus({ phase: "ready", stats: this.stats() });
    this.changes.fire();
  }

  private async updateFile(uri: vscode.Uri, changes: FileChanges): Promise<void> {
    try {
      if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
        return;
      }
      const key = uri.toString();
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxIndexedFileBytes()) {
        if (this.fileStates.has(key)) {
          changes.set(key, undefined);
        }
        return;
      }
      const existing = this.fileStates.get(key);
      if (
        existing !== undefined &&
        existing.mtime === stat.mtime &&
        existing.size === stat.size
      ) {
        return;
      }
      const indexed = await this.indexFile(uri, stat);
      changes.set(indexed.uri, indexed);
    } catch (error) {
      if (this.pendingMutations.has(uri.toString())) {
        return;
      }
      this.setStatus({
        phase: "error",
        stats: this.stats(),
        detail: `Unable to update ${uri.fsPath}: ${String(error)}`
      });
      this.output.appendLine(`Persistent index update failed for ${uri.toString()}: ${String(error)}`);
    }
  }

  private async updateDocument(document: vscode.TextDocument, changes: FileChanges): Promise<void> {
    const uri = document.uri;
    try {
      if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
        return;
      }
      const source = document.getText();
      const byteLength = Buffer.byteLength(source, "utf8");
      if (byteLength > maxIndexedFileBytes()) {
        if (this.fileStates.has(uri.toString())) {
          changes.set(uri.toString(), undefined);
        }
        return;
      }
      const stat = await vscode.workspace.fs.stat(uri);
      const indexed = this.indexSource(
        uri,
        source,
        document.isDirty ? -document.version : stat.mtime,
        byteLength
      );
      changes.set(indexed.uri, indexed);
      this.output.appendLine(
        `Document index updated: ${uri.toString()}${document.isDirty ? " (unsaved)" : ""}`
      );
    } catch (error) {
      if (this.pendingMutations.has(uri.toString())) {
        return;
      }
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
