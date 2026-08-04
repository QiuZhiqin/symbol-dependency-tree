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
  readonly calls: readonly StoredCallSite[];
  readonly memberTypes: readonly StoredMemberType[];
  readonly inheritances?: readonly StoredInheritance[];
  readonly objectTypes?: readonly StoredObjectType[];
  readonly virtualMembers?: readonly StoredVirtualMember[];
}

export interface PersistentIndexDocument {
  readonly roots: readonly string[];
  readonly files: readonly IndexedFileRecord[];
  readonly deletedUris: readonly string[];
}
