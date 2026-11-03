import { VirtualDispatchIndex, virtualMemberKey } from "../utils/virtualDispatch";
import type { FileTypeContributions } from "./callIndexDatabase";

export function memberTypeKey(owner: string, member: string): string {
  return `${owner}\u0000${member}`;
}

type ValueCounts = Map<string, Map<string, number>>;

/** Counts one value under `key` and returns the values still present there. */
function adjust(
  counts: ValueCounts,
  key: string,
  value: string,
  delta: number
): ReadonlyMap<string, number> {
  const values = counts.get(key) ?? new Map<string, number>();
  const next = (values.get(value) ?? 0) + delta;
  if (next > 0) {
    values.set(value, next);
  } else {
    values.delete(value);
  }
  if (values.size > 0) {
    counts.set(key, values);
  } else {
    counts.delete(key);
  }
  return values;
}

/**
 * Shared type facts merged across files. Each file's rows are counted, so one
 * file can be removed without rescanning the others:
 * - a member or object type with several distinct types is ambiguous (`undefined`);
 * - base types are the union over all files (multiple inheritance keeps every base);
 * - a virtual member exists while any file still declares it.
 */
export class TypeLookup {
  public readonly memberTypes = new Map<string, string | undefined>();
  public readonly objectTypes = new Map<string, string | undefined>();
  public readonly baseTypes = new Map<string, Set<string>>();
  public readonly virtualMembers = new Set<string>();
  private readonly memberTypeCounts: ValueCounts = new Map();
  private readonly objectTypeCounts: ValueCounts = new Map();
  private readonly baseTypeCounts: ValueCounts = new Map();
  private readonly virtualMemberCounts = new Map<string, number>();
  private dispatchIndex: VirtualDispatchIndex | undefined;

  /** Virtual dispatch lookups over the current types, rebuilt after they change. */
  public get dispatch(): VirtualDispatchIndex {
    this.dispatchIndex ??= new VirtualDispatchIndex(this.baseTypes, this.virtualMembers);
    return this.dispatchIndex;
  }

  public clear(): void {
    this.dispatchIndex = undefined;
    for (const collection of [
      this.memberTypes,
      this.objectTypes,
      this.baseTypes,
      this.virtualMembers,
      this.memberTypeCounts,
      this.objectTypeCounts,
      this.baseTypeCounts,
      this.virtualMemberCounts
    ]) {
      collection.clear();
    }
  }

  public add(contributions: FileTypeContributions): void {
    this.apply(contributions, 1);
  }

  public remove(contributions: FileTypeContributions): void {
    this.apply(contributions, -1);
  }

  private apply(contributions: FileTypeContributions, delta: number): void {
    this.dispatchIndex = undefined;
    for (const memberType of contributions.memberTypes) {
      const key = memberTypeKey(memberType.owner, memberType.member);
      this.setSingleType(
        this.memberTypes,
        key,
        adjust(this.memberTypeCounts, key, memberType.typeName, delta)
      );
    }
    for (const objectType of contributions.objectTypes) {
      this.setSingleType(
        this.objectTypes,
        objectType.name,
        adjust(this.objectTypeCounts, objectType.name, objectType.typeName, delta)
      );
    }
    for (const inheritance of contributions.inheritances) {
      const bases = adjust(this.baseTypeCounts, inheritance.derived, inheritance.base, delta);
      if (bases.size === 0) {
        this.baseTypes.delete(inheritance.derived);
      } else {
        this.baseTypes.set(inheritance.derived, new Set(bases.keys()));
      }
    }
    for (const member of contributions.virtualMembers) {
      const key = virtualMemberKey(member.owner, member.name);
      const count = (this.virtualMemberCounts.get(key) ?? 0) + delta;
      if (count > 0) {
        this.virtualMemberCounts.set(key, count);
        this.virtualMembers.add(key);
      } else {
        this.virtualMemberCounts.delete(key);
        this.virtualMembers.delete(key);
      }
    }
  }

  private setSingleType(
    target: Map<string, string | undefined>,
    key: string,
    types: ReadonlyMap<string, number>
  ): void {
    if (types.size === 0) {
      target.delete(key);
    } else {
      target.set(key, types.size === 1 ? types.keys().next().value : undefined);
    }
  }
}
