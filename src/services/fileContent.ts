import type { IndexedFileRecord, StoredCallSite } from "../model/persistentIndexTypes";
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
    calls: storedCallSites(scanned).filter((call) => call.scope?.kind !== "local")
  };
}
