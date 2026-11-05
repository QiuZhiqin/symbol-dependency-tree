import { callFields } from "../model/persistentIndexTypes";
import type { IndexedFileRecord, PackedCallSites, StoredCallSite } from "../model/persistentIndexTypes";
import { scanCallIndexFile, type ScannedCallIndexFile } from "../utils/callIndexScanner";

// Scan workers load this module, so it must not import `vscode`.

/** What one file contributes to the index, apart from its identity and version. */
export type FileContent = Omit<IndexedFileRecord, "uri" | "mtime" | "size">;

/**
 * The scanner's references, each tied to the index of its caller definition.
 * Two definitions found at one name position (gmock's template template
 * parameter `template <class> class MatcherImpl` is read as a class twice)
 * share a caller index, so the same reference is kept once.
 */
export function storedCallSites(scanned: ScannedCallIndexFile): StoredCallSite[] {
  const callerIndexes = new Map(
    scanned.definitions.map((definition, index) => [definition.selectionStart, index])
  );
  const storedCalls = new Set<string>();
  return scanned.calls.flatMap((call) => {
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
  });
}

/**
 * Packs references in their order. Names are numbered as the references first
 * use them, which is the order the index assigns new string ids in, so packing
 * does not change what the index stores.
 */
export function packCallSites(calls: readonly StoredCallSite[]): PackedCallSites {
  const names: string[] = [];
  const nameIndexes = new Map<string, number>();
  const name = (value: string): number => {
    let index = nameIndexes.get(value);
    if (index === undefined) {
      index = names.push(value) - 1;
      nameIndexes.set(value, index);
    }
    return index;
  };
  const ownerPaths: string[] = [];
  const rows = new Int32Array(calls.length * callFields);
  calls.forEach((call, index) => {
    const row = index * callFields;
    const scope = call.scope;
    rows[row] = name(call.callee);
    rows[row + 1] = call.callerIndex;
    rows[row + 2] = call.offset;
    rows[row + 3] = call.kind === "callable" ? 0 : 1;
    rows[row + 4] = scope === undefined ? -1 : scope.kind === "local" ? 0 : 1;
    if (scope?.kind === "local") {
      rows[row + 5] = scope.functionSelectionStart;
      rows[row + 6] = scope.declarationOffset;
    } else if (scope?.kind === "member") {
      rows[row + 5] = name(scope.owner);
    }
    rows[row + 7] =
      call.memberOwnerPath === undefined
        ? -1
        : ownerPaths.push(JSON.stringify([call.memberOwnerPath.rootOwner, ...call.memberOwnerPath.members])) - 1;
    rows[row + 8] = call.implicitMemberOwner === undefined ? -1 : name(call.implicitMemberOwner);
  });
  return { names, ownerPaths, rows };
}

export function scanFileContent(source: string): FileContent {
  const scanned = scanCallIndexFile(source);
  return {
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
    // Local references are scanned from the current document at query time.
    calls: packCallSites(storedCallSites(scanned).filter((call) => call.scope?.kind !== "local"))
  };
}
