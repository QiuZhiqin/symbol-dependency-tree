import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { callFields } from "../model/persistentIndexTypes";
import type {
  IndexedFileRecord,
  PackedCallSites,
  StoredCallSite,
  StoredInheritance,
  StoredMemberType,
  StoredObjectType,
  StoredVirtualMember
} from "../model/persistentIndexTypes";
import type { IndexedFunctionDefinition } from "../utils/callIndexScanner";
import type {
  IndexedMemberOwnerPath,
  IndexedSymbolScope
} from "../utils/cppSymbolScopes";

/** Bump when the table layout or stored semantics change; older databases are rebuilt. */
const schemaVersion = 5;

const definitionKinds = ["function", "initializer", "type", "macro"] as const;
const typeKinds = ["class", "enum", "struct", "union"] as const;
const busyTimeoutMs = 5000;
/**
 * Page cache of a bulk write (a rebuild, the startup check, added folders),
 * in KiB. It cut the write time of a 59,000-file rebuild by about a fifth over
 * SQLite's default of about 2 MB, and is given back when the transaction ends.
 */
const bulkWriteCacheKiB = 64 * 1024;
const sqliteCorrupt = 11;
const sqliteNotADatabase = 26;

const tables = [
  "meta",
  "strings",
  "files",
  "definitions",
  "calls",
  "file_callees",
  "member_types",
  "object_types",
  "inheritances",
  "virtual_members"
] as const;

const contentTables = tables.filter((table) => table !== "meta");
const perFileTables = [
  "definitions",
  "file_callees",
  "member_types",
  "object_types",
  "inheritances",
  "virtual_members"
] as const;

const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE strings(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE);
CREATE TABLE files(
  id INTEGER PRIMARY KEY,
  uri TEXT NOT NULL UNIQUE,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  functions INTEGER NOT NULL,
  calls INTEGER NOT NULL
);
CREATE TABLE definitions(
  file INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  is_static INTEGER NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  selection_start INTEGER NOT NULL,
  selection_end INTEGER NOT NULL,
  member_owner INTEGER,
  type_kind INTEGER,
  scope_kind INTEGER,
  scope_a INTEGER,
  scope_b INTEGER,
  PRIMARY KEY(file, idx)
) WITHOUT ROWID;
CREATE INDEX definitions_name ON definitions(name);
CREATE TABLE calls(
  callee INTEGER NOT NULL,
  file INTEGER NOT NULL,
  caller INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  scope_kind INTEGER,
  scope_a INTEGER,
  scope_b INTEGER,
  owner_path TEXT,
  implicit_owner INTEGER,
  PRIMARY KEY(callee, file, caller, offset)
) WITHOUT ROWID;
CREATE TABLE file_callees(
  file INTEGER NOT NULL,
  callee INTEGER NOT NULL,
  PRIMARY KEY(file, callee)
) WITHOUT ROWID;
CREATE TABLE member_types(file INTEGER NOT NULL, owner INTEGER NOT NULL, member INTEGER NOT NULL, type_name INTEGER NOT NULL);
CREATE INDEX member_types_file ON member_types(file);
CREATE TABLE object_types(file INTEGER NOT NULL, name INTEGER NOT NULL, type_name INTEGER NOT NULL);
CREATE INDEX object_types_file ON object_types(file);
CREATE TABLE inheritances(file INTEGER NOT NULL, derived INTEGER NOT NULL, base INTEGER NOT NULL);
CREATE INDEX inheritances_file ON inheritances(file);
CREATE TABLE virtual_members(file INTEGER NOT NULL, owner INTEGER NOT NULL, name INTEGER NOT NULL);
CREATE INDEX virtual_members_file ON virtual_members(file);
`;

const definitionColumns =
  "name, kind, is_static, range_start, range_end, selection_start, selection_end, member_owner, type_kind, scope_kind, scope_a, scope_b";

type Row = Record<string, SQLOutputValue>;

export interface StoredFileState {
  readonly mtime: number;
  readonly size: number;
}

export interface IndexTotals {
  readonly files: number;
  readonly functions: number;
  readonly calls: number;
}

/** The per-file facts that are merged across files into the shared type lookup. */
export interface FileTypeContributions {
  readonly memberTypes: readonly StoredMemberType[];
  readonly objectTypes: readonly StoredObjectType[];
  readonly inheritances: readonly StoredInheritance[];
  readonly virtualMembers: readonly StoredVirtualMember[];
}

export interface IndexedFileDefinitions {
  readonly uri: string;
  readonly definitions: readonly IndexedFunctionDefinition[];
}

export interface IndexedDefinitionWithFile {
  readonly file: { readonly uri: string };
  readonly definition: IndexedFunctionDefinition;
}

/** Narrows `callsByCallee()` in SQL; the caller still applies its own scope rules. */
export interface CallFilter {
  /** Keep only callable references (function targets). */
  readonly callableOnly?: boolean;
  /** Keep only references in this file (static targets). */
  readonly fileUri?: string;
}

function callsByCalleeSql(filter: CallFilter): string {
  return `SELECT f.uri, c.file AS call_file, c.caller AS call_caller, c.offset AS call_offset,
                 c.kind AS call_kind, c.scope_kind AS call_scope_kind, c.scope_a AS call_scope_a,
                 c.scope_b AS call_scope_b, c.owner_path AS call_owner_path,
                 c.implicit_owner AS call_implicit_owner,
                 ${definitionColumns.split(", ").map((column) => `d.${column}`).join(", ")}
          FROM calls c
          JOIN files f ON f.id = c.file
          JOIN definitions d ON d.file = c.file AND d.idx = c.caller
          WHERE c.callee = ?${filter.callableOnly === true ? " AND c.kind = 0" : ""}${filter.fileUri === undefined ? "" : " AND c.file = ?"}
          ORDER BY c.file, c.caller, c.offset`;
}

export interface IndexedCallWithFile {
  readonly file: { readonly uri: string };
  readonly call: StoredCallSite;
  readonly caller: IndexedFunctionDefinition;
}

function recordTypeContributions(record: IndexedFileRecord): FileTypeContributions {
  return {
    memberTypes: record.memberTypes,
    objectTypes: record.objectTypes ?? [],
    inheritances: record.inheritances ?? [],
    virtualMembers: record.virtualMembers ?? []
  };
}

/**
 * Copies a string so it no longer pins the source text it was sliced from:
 * scanner names are slices of a whole masked file.
 */
function detachedCopy(value: string): string {
  return JSON.parse(JSON.stringify(value)) as string;
}

function numberValue(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function optionalNumber(value: SQLOutputValue | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function sqliteErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "errcode" in error
    ? Number((error as { errcode: unknown }).errcode)
    : undefined;
}

async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `The symbol index needs the built-in node:sqlite module of VS Code 1.101 or newer: ${String(error)}`
    );
  }
}

/**
 * Opens the index database, recreating it when it is corrupt or has an older
 * schema. Writes go through one connection; queries use a second connection so
 * an in-flight query never sees a write transaction that is still open.
 */
export async function openCallIndexDatabase(filePath: string): Promise<CallIndexDatabase> {
  const sqlite = await loadSqlite();
  mkdirSync(path.dirname(filePath), { recursive: true });
  // Only APIs that Node 22.15 (VS Code 1.101) already offers: no `timeout`
  // option and no `isTransaction`.
  const connect = (): DatabaseSync => {
    const database = new sqlite.DatabaseSync(filePath);
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return database;
  };
  const open = (): CallIndexDatabase => {
    const writer = connect();
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      const version = numberValue(writer.prepare("PRAGMA user_version").get()?.["user_version"]);
      if (version !== schemaVersion) {
        writer.exec("BEGIN IMMEDIATE");
        for (const table of tables) {
          writer.exec(`DROP TABLE IF EXISTS ${table}`);
        }
        writer.exec(schema);
        writer.exec(`PRAGMA user_version = ${schemaVersion}`);
        writer.exec("COMMIT");
        // The dropped tables leave their pages free inside the file; compacting
        // the still-empty database shrinks the file instead of keeping its old size.
        writer.exec("VACUUM");
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      const reader = connect();
      reader.exec("PRAGMA query_only = ON");
      return new CallIndexDatabase(writer, reader);
    } catch (error) {
      writer.close();
      throw error;
    }
  };
  try {
    return open();
  } catch (error) {
    const code = sqliteErrorCode(error);
    if (code !== sqliteCorrupt && code !== sqliteNotADatabase) {
      throw error;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${filePath}${suffix}`, { force: true });
    }
    return open();
  }
}

type Statements<Name extends string> = Readonly<Record<Name, StatementSync>>;

type TypeStatements = Statements<"memberTypes" | "objectTypes" | "inheritances" | "virtualMembers">;

interface WriteStatements
  extends Statements<
    | "stringId"
    | "insertString"
    | "fileId"
    | "insertFile"
    | "updateFile"
    | "deleteFile"
    | "insertDefinition"
    | "insertCall"
    | "insertFileCallee"
    | "insertMemberType"
    | "insertObjectType"
    | "insertInheritance"
    | "insertVirtualMember"
    | "setMeta"
  > {
  readonly deleteFileRows: readonly StatementSync[];
  readonly types: TypeStatements;
}

interface ReadStatements
  extends Statements<
    | "stringId"
    | "stringValue"
    | "meta"
    | "fileStates"
    | "totals"
    | "fileId"
    | "fileDefinitions"
    | "definitionsByName"
  > {
  readonly types: TypeStatements;
  readonly fileTypes: TypeStatements;
}

function typeStatements(database: DatabaseSync, where: string): TypeStatements {
  const value = (column: string): string =>
    `(SELECT value FROM strings WHERE id = t.${column})`;
  return {
    memberTypes: database.prepare(
      `SELECT ${value("owner")} AS owner, ${value("member")} AS member, ${value("type_name")} AS type_name FROM member_types t WHERE ${where}`
    ),
    objectTypes: database.prepare(
      `SELECT ${value("name")} AS name, ${value("type_name")} AS type_name FROM object_types t WHERE ${where}`
    ),
    inheritances: database.prepare(
      `SELECT ${value("derived")} AS derived, ${value("base")} AS base FROM inheritances t WHERE ${where}`
    ),
    virtualMembers: database.prepare(
      `SELECT ${value("owner")} AS owner, ${value("name")} AS name FROM virtual_members t WHERE ${where}`
    )
  };
}

function writeStatements(database: DatabaseSync): WriteStatements {
  return {
    stringId: database.prepare("SELECT id FROM strings WHERE value = ?"),
    insertString: database.prepare("INSERT INTO strings(value) VALUES (?)"),
    fileId: database.prepare("SELECT id FROM files WHERE uri = ?"),
    insertFile: database.prepare(
      "INSERT INTO files(uri, mtime, size, functions, calls) VALUES (?, ?, ?, ?, ?)"
    ),
    updateFile: database.prepare(
      "UPDATE files SET mtime = ?, size = ?, functions = ?, calls = ? WHERE id = ?"
    ),
    deleteFile: database.prepare("DELETE FROM files WHERE id = ?"),
    deleteFileRows: [
      // calls has no index on file, which would take a third of the database:
      // a file's rows are found through the callees it references, before
      // file_callees itself is cleared.
      database.prepare(
        "DELETE FROM calls WHERE file = ?1 AND callee IN (SELECT callee FROM file_callees WHERE file = ?1)"
      ),
      ...perFileTables.map((table) => database.prepare(`DELETE FROM ${table} WHERE file = ?`))
    ],
    insertDefinition: database.prepare(
      `INSERT INTO definitions(file, idx, ${definitionColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertCall: database.prepare(
      "INSERT INTO calls(callee, file, caller, offset, kind, scope_kind, scope_a, scope_b, owner_path, implicit_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    insertFileCallee: database.prepare("INSERT INTO file_callees(file, callee) VALUES (?, ?)"),
    insertMemberType: database.prepare(
      "INSERT INTO member_types(file, owner, member, type_name) VALUES (?, ?, ?, ?)"
    ),
    insertObjectType: database.prepare(
      "INSERT INTO object_types(file, name, type_name) VALUES (?, ?, ?)"
    ),
    insertInheritance: database.prepare("INSERT INTO inheritances(file, derived, base) VALUES (?, ?, ?)"),
    insertVirtualMember: database.prepare(
      "INSERT INTO virtual_members(file, owner, name) VALUES (?, ?, ?)"
    ),
    setMeta: database.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ),
    types: typeStatements(database, "file = ?")
  };
}

function readStatements(database: DatabaseSync): ReadStatements {
  return {
    stringId: database.prepare("SELECT id FROM strings WHERE value = ?"),
    stringValue: database.prepare("SELECT value FROM strings WHERE id = ?"),
    meta: database.prepare("SELECT value FROM meta WHERE key = ?"),
    fileStates: database.prepare("SELECT uri, mtime, size FROM files"),
    totals: database.prepare(
      "SELECT count(*) AS files, coalesce(sum(functions), 0) AS functions, coalesce(sum(calls), 0) AS calls FROM files"
    ),
    fileId: database.prepare("SELECT id FROM files WHERE uri = ?"),
    fileDefinitions: database.prepare(
      `SELECT ${definitionColumns} FROM definitions WHERE file = ? ORDER BY idx`
    ),
    definitionsByName: database.prepare(
      `SELECT f.uri, ${definitionColumns} FROM definitions d JOIN files f ON f.id = d.file WHERE d.name = ? ORDER BY d.file, d.idx`
    ),
    types: typeStatements(database, "1 = 1"),
    fileTypes: typeStatements(database, "file = ?")
  };
}

export class CallIndexDatabase {
  // String ids are cached only for the current write transaction: a rollback
  // discards the ids it allocated.
  private readonly transactionStringIds = new Map<string, number>();
  private transactionOpen = false;
  /** The cache size to restore once a bulk write ends. */
  private cacheSizeAfterBulkWrite: number | undefined;
  private readonly write: WriteStatements;
  private readonly read: ReadStatements;
  private readonly callQueries = new Map<string, StatementSync>();

  public constructor(
    private readonly writer: DatabaseSync,
    private readonly reader: DatabaseSync
  ) {
    this.write = writeStatements(writer);
    this.read = readStatements(reader);
  }

  public close(): void {
    this.reader.close();
    this.writer.close();
  }

  /** @param bulk use a larger page cache until the transaction ends */
  public begin(bulk = false): void {
    this.writer.exec("BEGIN IMMEDIATE");
    this.transactionOpen = true;
    if (bulk) {
      this.cacheSizeAfterBulkWrite = numberValue(
        this.writer.prepare("PRAGMA cache_size").get()?.["cache_size"]
      );
      this.writer.exec(`PRAGMA cache_size = -${bulkWriteCacheKiB}`);
    }
  }

  public commit(): void {
    this.writer.exec("COMMIT");
    this.transactionOpen = false;
    this.transactionStringIds.clear();
    // A checkpoint leaves the write-ahead log at its largest size until the
    // database closes; one rebuild would keep a log as large as the index.
    // Queries finish synchronously, so no reader holds the log here.
    this.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.endBulkWrite();
  }

  public rollback(): void {
    this.transactionStringIds.clear();
    if (this.transactionOpen) {
      this.transactionOpen = false;
      this.writer.exec("ROLLBACK");
    }
    this.endBulkWrite();
  }

  private endBulkWrite(): void {
    if (this.cacheSizeAfterBulkWrite === undefined) {
      return;
    }
    this.writer.exec(`PRAGMA cache_size = ${this.cacheSizeAfterBulkWrite}`);
    // Free the pages the larger cache still holds.
    this.writer.exec("PRAGMA shrink_memory");
    this.cacheSizeAfterBulkWrite = undefined;
  }

  /** Removes every indexed file inside the current write transaction. */
  public clear(): void {
    for (const table of contentTables) {
      this.writer.exec(`DELETE FROM ${table}`);
    }
  }

  public setRoots(roots: readonly string[]): void {
    this.write.setMeta.run("roots", JSON.stringify(roots));
  }

  /** Replaces one file's rows and returns the type facts it contributed before. */
  public replaceFile(record: IndexedFileRecord): FileTypeContributions | undefined {
    const existing = optionalNumber(this.write.fileId.get(record.uri)?.["id"]);
    const previous = existing === undefined ? undefined : this.deleteFileRows(existing);
    const functions = record.definitions.filter((definition) => definition.kind === "function").length;
    const calls = record.calls.rows.length / callFields;
    let fileId: number;
    if (existing === undefined) {
      fileId = Number(
        this.write.insertFile.run(record.uri, record.mtime, record.size, functions, calls).lastInsertRowid
      );
    } else {
      fileId = existing;
      this.write.updateFile.run(record.mtime, record.size, functions, calls, fileId);
    }
    record.definitions.forEach((definition, index) => {
      this.write.insertDefinition.run(fileId, index, ...this.definitionValues(definition));
    });
    this.insertCalls(fileId, record.calls);
    const contributions = recordTypeContributions(record);
    for (const memberType of contributions.memberTypes) {
      this.write.insertMemberType.run(
        fileId,
        this.stringId(memberType.owner),
        this.stringId(memberType.member),
        this.stringId(memberType.typeName)
      );
    }
    for (const objectType of contributions.objectTypes) {
      this.write.insertObjectType.run(
        fileId,
        this.stringId(objectType.name),
        this.stringId(objectType.typeName)
      );
    }
    for (const inheritance of contributions.inheritances) {
      this.write.insertInheritance.run(
        fileId,
        this.stringId(inheritance.derived),
        this.stringId(inheritance.base)
      );
    }
    for (const member of contributions.virtualMembers) {
      this.write.insertVirtualMember.run(
        fileId,
        this.stringId(member.owner),
        this.stringId(member.name)
      );
    }
    return previous;
  }

  /** Writes a file's references and its callee list; `PackedCallSites` gives the layout. */
  private insertCalls(fileId: number, { names, ownerPaths, rows }: PackedCallSites): void {
    const nameIds = names.map((name) => this.stringId(name));
    const callees = new Set<number>();
    for (let row = 0; row < rows.length; row += callFields) {
      const callee = nameIds[rows[row]!]!;
      const scopeKind = rows[row + 4]!;
      const ownerPath = rows[row + 7]!;
      const implicitOwner = rows[row + 8]!;
      callees.add(callee);
      this.write.insertCall.run(
        callee,
        fileId,
        rows[row + 1]!,
        rows[row + 2]!,
        rows[row + 3]!,
        scopeKind < 0 ? null : scopeKind,
        scopeKind === 0 ? rows[row + 5]! : scopeKind === 1 ? nameIds[rows[row + 5]!]! : null,
        scopeKind === 0 ? rows[row + 6]! : null,
        ownerPath < 0 ? null : ownerPaths[ownerPath]!,
        implicitOwner < 0 ? null : nameIds[implicitOwner]!
      );
    }
    for (const callee of callees) {
      this.write.insertFileCallee.run(fileId, callee);
    }
  }

  /** Deletes one file and returns the type facts it contributed. */
  public deleteFile(uri: string): FileTypeContributions | undefined {
    const existing = optionalNumber(this.write.fileId.get(uri)?.["id"]);
    if (existing === undefined) {
      return undefined;
    }
    const previous = this.deleteFileRows(existing);
    this.write.deleteFile.run(existing);
    return previous;
  }

  private deleteFileRows(fileId: number): FileTypeContributions {
    const previous = this.typeContributionsFrom(this.write.types, fileId);
    for (const statement of this.write.deleteFileRows) {
      statement.run(fileId);
    }
    return previous;
  }

  private stringId(value: string): number {
    const cached = this.transactionStringIds.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const id =
      optionalNumber(this.write.stringId.get(value)?.["id"]) ??
      Number(this.write.insertString.run(value).lastInsertRowid);
    this.transactionStringIds.set(detachedCopy(value), id);
    return id;
  }

  private definitionValues(definition: IndexedFunctionDefinition): (number | null)[] {
    const typeKind = definition.typeKind === undefined ? -1 : typeKinds.indexOf(definition.typeKind);
    return [
      this.stringId(definition.name),
      definitionKinds.indexOf(definition.kind),
      definition.isStatic ? 1 : 0,
      definition.rangeStart,
      definition.rangeEnd,
      definition.selectionStart,
      definition.selectionEnd,
      definition.memberOwner === undefined ? null : this.stringId(definition.memberOwner),
      typeKind < 0 ? null : typeKind,
      ...this.scopeValues(definition.scope)
    ];
  }

  private scopeValues(scope: IndexedSymbolScope | undefined): (number | null)[] {
    return scope === undefined
      ? [null, null, null]
      : scope.kind === "local"
        ? [0, scope.functionSelectionStart, scope.declarationOffset]
        : [1, this.stringId(scope.owner), null];
  }

  public roots(): readonly string[] {
    const value = this.read.meta.get("roots")?.["value"];
    return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
  }

  public fileStates(): Map<string, StoredFileState> {
    return new Map(
      this.read.fileStates.all().map((row) => [
        String(row["uri"]),
        { mtime: numberValue(row["mtime"]), size: numberValue(row["size"]) }
      ])
    );
  }

  public totals(): IndexTotals {
    const row = this.read.totals.get();
    return {
      files: numberValue(row?.["files"]),
      functions: numberValue(row?.["functions"]),
      calls: numberValue(row?.["calls"])
    };
  }

  /** Every committed type fact, for building the in-memory type lookup. */
  public typeContributions(): FileTypeContributions {
    return this.typeContributionsFrom(this.read.types);
  }

  /** The committed type facts of one file. */
  public fileTypeContributions(uri: string): FileTypeContributions | undefined {
    const fileId = optionalNumber(this.read.fileId.get(uri)?.["id"]);
    return fileId === undefined ? undefined : this.typeContributionsFrom(this.read.fileTypes, fileId);
  }

  private typeContributionsFrom(
    statements: TypeStatements,
    ...parameters: number[]
  ): FileTypeContributions {
    return {
      memberTypes: statements.memberTypes.all(...parameters).map((row) => ({
        owner: String(row["owner"]),
        member: String(row["member"]),
        typeName: String(row["type_name"])
      })),
      objectTypes: statements.objectTypes.all(...parameters).map((row) => ({
        name: String(row["name"]),
        typeName: String(row["type_name"])
      })),
      inheritances: statements.inheritances.all(...parameters).map((row) => ({
        derived: String(row["derived"]),
        base: String(row["base"])
      })),
      virtualMembers: statements.virtualMembers.all(...parameters).map((row) => ({
        owner: String(row["owner"]),
        name: String(row["name"])
      }))
    };
  }

  public fileDefinitions(uri: string): IndexedFileDefinitions | undefined {
    const fileId = optionalNumber(this.read.fileId.get(uri)?.["id"]);
    if (fileId === undefined) {
      return undefined;
    }
    const strings = this.stringResolver();
    return {
      uri,
      definitions: this.read.fileDefinitions.all(fileId).map((row) =>
        this.definitionFromRow(row, strings)
      )
    };
  }

  public definitionsByName(name: string): IndexedDefinitionWithFile[] {
    const nameId = this.readStringId(name);
    if (nameId === undefined) {
      return [];
    }
    const strings = this.stringResolver();
    return this.read.definitionsByName.all(nameId).map((row) => ({
      file: { uri: String(row["uri"]) },
      definition: this.definitionFromRow(row, strings)
    }));
  }

  /** References to `name`, ordered as the scanner produced them within each file. */
  public callsByCallee(name: string, filter: CallFilter = {}): IndexedCallWithFile[] {
    const calleeId = this.readStringId(name);
    const fileId =
      filter.fileUri === undefined
        ? undefined
        : optionalNumber(this.read.fileId.get(filter.fileUri)?.["id"]);
    if (calleeId === undefined || (filter.fileUri !== undefined && fileId === undefined)) {
      return [];
    }
    const sql = callsByCalleeSql(filter);
    let statement = this.callQueries.get(sql);
    if (statement === undefined) {
      statement = this.reader.prepare(sql);
      this.callQueries.set(sql, statement);
    }
    const strings = this.stringResolver();
    // Many references share one caller; build each caller definition once.
    const callers = new Map<string, IndexedFunctionDefinition>();
    const rows = fileId === undefined ? statement.all(calleeId) : statement.all(calleeId, fileId);
    return rows.map((row) => {
      const scope = this.scopeFromRow(
        row["call_scope_kind"],
        row["call_scope_a"],
        row["call_scope_b"],
        strings
      );
      const ownerPath = row["call_owner_path"];
      const implicitOwner = optionalNumber(row["call_implicit_owner"]);
      let memberOwnerPath: IndexedMemberOwnerPath | undefined;
      if (typeof ownerPath === "string") {
        const [rootOwner, ...members] = JSON.parse(ownerPath) as string[];
        memberOwnerPath = { rootOwner: rootOwner!, members };
      }
      const call: StoredCallSite = {
        callee: name,
        offset: numberValue(row["call_offset"]),
        kind: numberValue(row["call_kind"]) === 0 ? "callable" : "symbol",
        callerIndex: numberValue(row["call_caller"]),
        ...(scope === undefined ? {} : { scope }),
        ...(memberOwnerPath === undefined ? {} : { memberOwnerPath }),
        ...(implicitOwner === undefined ? {} : { implicitMemberOwner: strings(implicitOwner) })
      };
      const callerKey = `${String(row["call_file"])}:${call.callerIndex}`;
      let caller = callers.get(callerKey);
      if (caller === undefined) {
        caller = this.definitionFromRow(row, strings);
        callers.set(callerKey, caller);
      }
      return { file: { uri: String(row["uri"]) }, call, caller };
    });
  }

  private readStringId(value: string): number | undefined {
    return optionalNumber(this.read.stringId.get(value)?.["id"]);
  }

  private stringResolver(): (id: number) => string {
    const values = new Map<number, string>();
    return (id) => {
      let value = values.get(id);
      if (value === undefined) {
        value = String(this.read.stringValue.get(id)?.["value"]);
        values.set(id, value);
      }
      return value;
    };
  }

  private definitionFromRow(row: Row, strings: (id: number) => string): IndexedFunctionDefinition {
    const memberOwner = optionalNumber(row["member_owner"]);
    const typeKind = optionalNumber(row["type_kind"]);
    const scope = this.scopeFromRow(row["scope_kind"], row["scope_a"], row["scope_b"], strings);
    return {
      name: strings(numberValue(row["name"])),
      rangeStart: numberValue(row["range_start"]),
      rangeEnd: numberValue(row["range_end"]),
      selectionStart: numberValue(row["selection_start"]),
      selectionEnd: numberValue(row["selection_end"]),
      kind: definitionKinds[numberValue(row["kind"])]!,
      isStatic: numberValue(row["is_static"]) === 1,
      ...(memberOwner === undefined ? {} : { memberOwner: strings(memberOwner) }),
      ...(typeKind === undefined ? {} : { typeKind: typeKinds[typeKind]! }),
      ...(scope === undefined ? {} : { scope })
    };
  }

  private scopeFromRow(
    kind: SQLOutputValue | undefined,
    first: SQLOutputValue | undefined,
    second: SQLOutputValue | undefined,
    strings: (id: number) => string
  ): IndexedSymbolScope | undefined {
    const scopeKind = optionalNumber(kind);
    return scopeKind === undefined
      ? undefined
      : scopeKind === 0
        ? {
            kind: "local",
            functionSelectionStart: numberValue(first),
            declarationOffset: numberValue(second)
          }
        : { kind: "member", owner: strings(numberValue(first)) };
  }
}
