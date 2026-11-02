import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";

/** A real directory for the index database, exposed through a minimal file Uri. */
export interface TempStorage {
  readonly uri: vscode.Uri;
  readonly directory: string;
  remove(): void;
}

export function createTempStorage(): TempStorage {
  const directory = mkdtempSync(path.join(tmpdir(), "sdt-index-"));
  const href = pathToFileURL(directory).href;
  const uri = {
    scheme: "file",
    fsPath: directory,
    path: new URL(href).pathname,
    toString: (): string => href
  } as unknown as vscode.Uri;
  return {
    uri,
    directory,
    remove: (): void => rmSync(directory, { recursive: true, force: true })
  };
}
