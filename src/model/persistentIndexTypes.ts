import type { IndexedFunctionDefinition } from "../utils/callIndexScanner";
import type {
  IndexedMemberOwnerPath,
  IndexedSymbolScope
} from "../utils/cppSymbolScopes";

export interface StoredCallSite {
  readonly callee: string;
  readonly offset: number;
  readonly kind: "callable" | "symbol";
  readonly scope?: IndexedSymbolScope;
  readonly memberOwnerPath?: IndexedMemberOwnerPath;
  readonly implicitMemberOwner?: string;
  readonly callerIndex: number;
}

/** Integers per reference in `PackedCallSites.rows`. */
export const callFields = 9;

/**
 * A file's references as integers, so a scan worker hands them to the
 * extension host's thread without copying and that thread does not rebuild an
 * object per reference. Each reference is `callFields` integers in `rows`:
 * callee (index in `names`), caller index, offset, kind (0 callable, 1 symbol),
 * scope kind (-1 none, 0 local, 1 member), function selection start or owner
 * (index in `names`), declaration offset, member owner path (index in
 * `ownerPaths`, or -1), implicit member owner (index in `names`, or -1).
 */
export interface PackedCallSites {
  /** Each name once, in the order the references first use it. */
  readonly names: readonly string[];
  /** Member owner paths as the JSON arrays the index stores. */
  readonly ownerPaths: readonly string[];
  readonly rows: Int32Array<ArrayBuffer>;
}

export interface StoredMemberType {
  readonly owner: string;
  readonly member: string;
  readonly typeName: string;
}

export interface StoredObjectType {
  readonly name: string;
  readonly typeName: string;
}

export interface StoredInheritance {
  readonly derived: string;
  readonly base: string;
}

export interface StoredVirtualMember {
  readonly owner: string;
  readonly name: string;
}

export interface IndexedFileRecord {
  readonly uri: string;
  readonly mtime: number;
  readonly size: number;
  readonly definitions: readonly IndexedFunctionDefinition[];
  readonly calls: PackedCallSites;
  readonly memberTypes: readonly StoredMemberType[];
  readonly inheritances?: readonly StoredInheritance[];
  readonly objectTypes?: readonly StoredObjectType[];
  readonly virtualMembers?: readonly StoredVirtualMember[];
}
