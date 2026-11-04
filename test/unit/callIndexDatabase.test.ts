import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexedFileRecord } from "../../src/model/persistentIndexTypes";
import {
  openCallIndexDatabase,
  type CallIndexDatabase
} from "../../src/services/callIndexDatabase";

const first = "file:///e:/fixture/first.c";
const second = "file:///e:/fixture/second.c";

function record(uri: string, callees: readonly string[]): IndexedFileRecord {
  return {
    uri,
    mtime: 1,
    size: 1,
    definitions: [{
      name: "caller",
      kind: "function",
      isStatic: false,
      rangeStart: 0,
      rangeEnd: 100,
      selectionStart: 0,
      selectionEnd: 6
    }],
    calls: callees.map((callee, offset) => ({ callee, offset, kind: "callable" as const, callerIndex: 0 })),
    memberTypes: []
  };
}

let directory: string;
let databasePath: string;
let database: CallIndexDatabase;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "sdt-database-"));
  databasePath = path.join(directory, "index.sqlite");
  database = await openCallIndexDatabase(databasePath);
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function write(change: (database: CallIndexDatabase) => void): void {
  database.begin();
  change(database);
  database.commit();
}

function files(callee: string): string[] {
  return database.callsByCallee(callee).map((call) => call.file.uri);
}

/** The callee list kept beside the calls of each file, read through its own connection. */
async function fileCallees(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return reader.prepare(
      `SELECT f.uri || ' ' || s.value AS entry FROM file_callees c
       JOIN files f ON f.id = c.file JOIN strings s ON s.id = c.callee ORDER BY entry`
    ).all().map((row) => String(row["entry"]));
  } finally {
    reader.close();
  }
}

describe("CallIndexDatabase", () => {
  it("replaces and deletes only the calls of the file being written", async () => {
    write((db) => {
      db.replaceFile(record(first, ["shared", "only_first", "only_first"]));
      db.replaceFile(record(second, ["shared", "only_second"]));
    });
    write((db) => db.replaceFile(record(first, ["shared", "new_first"])));

    expect(files("shared")).toEqual([first, second]);
    expect(files("only_first")).toEqual([]);
    expect(files("new_first")).toEqual([first]);
    expect(files("only_second")).toEqual([second]);
    expect(await fileCallees()).toEqual([
      `${first} new_first`,
      `${first} shared`,
      `${second} only_second`,
      `${second} shared`
    ]);

    write((db) => db.deleteFile(first));

    expect(files("shared")).toEqual([second]);
    expect(files("new_first")).toEqual([]);
    expect(await fileCallees()).toEqual([`${second} only_second`, `${second} shared`]);
    expect(database.totals()).toEqual({ files: 1, functions: 1, calls: 2 });
  });

  it("clears the callee lists with the calls", async () => {
    write((db) => db.replaceFile(record(first, ["shared"])));
    write((db) => db.clear());
    // File ids start over after a clear: a stale callee list would collide.
    write((db) => db.replaceFile(record(second, ["shared"])));

    expect(files("shared")).toEqual([second]);
    expect(await fileCallees()).toEqual([`${second} shared`]);
  });

  it("truncates the write-ahead log after each commit", () => {
    write((db) => db.replaceFile(record(first, Array.from({ length: 2000 }, (_, index) => `callee_${index}`))));

    expect(statSync(`${databasePath}-wal`).size).toBe(0);
    expect(files("callee_1999")).toEqual([first]);
  });

  it("uses a larger page cache only while a bulk write is open", () => {
    const writer = (database as unknown as { writer: DatabaseSync }).writer;
    const cacheSize = (): number => Number(writer.prepare("PRAGMA cache_size").get()?.["cache_size"]);
    const initial = cacheSize();

    database.begin(true);
    expect(cacheSize()).toBe(-64 * 1024);
    database.commit();
    expect(cacheSize()).toBe(initial);
    database.begin(true);
    database.rollback();
    expect(cacheSize()).toBe(initial);
    database.begin();
    expect(cacheSize()).toBe(initial);
    database.rollback();
  });

  it("compacts the database file left by an older schema", async () => {
    database.close();
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(databasePath);
    old.exec(`DROP TABLE calls; CREATE TABLE calls(value BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
      INSERT INTO calls SELECT randomblob(4096) FROM n;
      PRAGMA user_version = 4;`);
    old.close();
    expect(statSync(databasePath).size).toBeGreaterThan(4_000_000);

    database = await openCallIndexDatabase(databasePath);

    expect(statSync(databasePath).size).toBeLessThan(200_000);
    expect(database.totals()).toEqual({ files: 0, functions: 0, calls: 0 });
  });
});
