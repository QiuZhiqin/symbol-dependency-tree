function virtualMemberKey(owner: string, member: string): string {
  return `${owner}\u0000${member}`;
}

function ancestorsOf(
  owner: string,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const ancestors = new Set<string>();
  const pending = [owner];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || ancestors.has(current)) {
      continue;
    }
    ancestors.add(current);
    pending.push(...(baseTypes.get(current) ?? []));
  }
  return ancestors;
}

function hasVirtualMember(
  owners: ReadonlySet<string>,
  member: string,
  virtualMembers: ReadonlySet<string>
): boolean {
  return [...owners].some((owner) => virtualMembers.has(virtualMemberKey(owner, member)));
}

function pushValue(values: Map<string, string[]>, key: string, value: string): void {
  const existing = values.get(key);
  if (existing === undefined) {
    values.set(key, [value]);
  } else {
    existing.push(value);
  }
}

/**
 * Lookups over the base types and virtual members, built once and reused by
 * every comparison until the types change, instead of rescanning all types
 * for each candidate a query compares.
 */
export class VirtualDispatchIndex {
  /** Types that have a base, are a base, or declare a virtual member. */
  public readonly knownOwners = new Set<string>();
  private readonly knownOwnersByLowerName = new Map<string, string[]>();
  private readonly virtualOwnersByMember = new Map<string, string[]>();

  public constructor(
    public readonly baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
    public readonly virtualMembers: ReadonlySet<string>
  ) {
    for (const [derived, bases] of baseTypes) {
      this.knownOwners.add(derived);
      for (const base of bases) {
        this.knownOwners.add(base);
      }
    }
    for (const entry of virtualMembers) {
      const separator = entry.indexOf("\u0000");
      if (separator < 0) {
        continue;
      }
      const owner = entry.slice(0, separator);
      if (separator > 0) {
        this.knownOwners.add(owner);
      }
      pushValue(this.virtualOwnersByMember, entry.slice(separator + 1), owner);
    }
    for (const owner of this.knownOwners) {
      pushValue(this.knownOwnersByLowerName, owner.toLocaleLowerCase(), owner);
    }
  }

  /** Known types whose name equals `owner` ignoring case. */
  public knownOwnersNamed(owner: string): readonly string[] {
    return this.knownOwnersByLowerName.get(owner.toLocaleLowerCase()) ?? [];
  }

  /** Types that declare `member` virtual. */
  public virtualOwnersOf(member: string): readonly string[] {
    return this.virtualOwnersByMember.get(member) ?? [];
  }
}

function canonicalVirtualOwner(owner: string, dispatch: VirtualDispatchIndex): string {
  if (dispatch.knownOwners.has(owner)) {
    return owner;
  }
  const matches = dispatch.knownOwnersNamed(owner);
  return matches.length === 1 ? matches[0]! : owner;
}

function ownersAreRelated(
  left: string,
  right: string,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  return ancestorsOf(left, baseTypes).has(right) || ancestorsOf(right, baseTypes).has(left);
}

function canonicalOwnerWithinHierarchy(
  owner: string,
  targetOwner: string,
  dispatch: VirtualDispatchIndex
): string {
  const hierarchyMatches = dispatch
    .knownOwnersNamed(owner)
    .filter((candidate) => ownersAreRelated(targetOwner, candidate, dispatch.baseTypes));
  return hierarchyMatches.length === 1
    ? hierarchyMatches[0]!
    : canonicalVirtualOwner(owner, dispatch);
}

function canRecoverUnknownReceiver(
  targetOwner: string,
  member: string,
  dispatch: VirtualDispatchIndex
): boolean {
  const targetAncestors = ancestorsOf(targetOwner, dispatch.baseTypes);
  if (!hasVirtualMember(targetAncestors, member, dispatch.virtualMembers)) {
    return false;
  }
  const virtualOwners = dispatch.virtualOwnersOf(member);
  return (
    virtualOwners.length > 0 &&
    virtualOwners.every((owner) => ownersAreRelated(targetOwner, owner, dispatch.baseTypes))
  );
}

export function virtualMemberOwnersMatch(
  targetOwner: string,
  candidateOwner: string,
  member: string,
  dispatch: VirtualDispatchIndex
): boolean {
  targetOwner = canonicalVirtualOwner(targetOwner, dispatch);
  candidateOwner = canonicalOwnerWithinHierarchy(candidateOwner, targetOwner, dispatch);
  if (targetOwner === candidateOwner) {
    return true;
  }
  const targetKnown = dispatch.knownOwners.has(targetOwner);
  const candidateKnown = dispatch.knownOwners.has(candidateOwner);
  if (targetKnown !== candidateKnown) {
    return canRecoverUnknownReceiver(
      targetKnown ? targetOwner : candidateOwner,
      member,
      dispatch
    );
  }
  if (!targetKnown) {
    return false;
  }
  const targetAncestors = ancestorsOf(targetOwner, dispatch.baseTypes);
  const candidateAncestors = ancestorsOf(candidateOwner, dispatch.baseTypes);
  if (!targetAncestors.has(candidateOwner) && !candidateAncestors.has(targetOwner)) {
    return false;
  }
  return (
    hasVirtualMember(targetAncestors, member, dispatch.virtualMembers) ||
    hasVirtualMember(candidateAncestors, member, dispatch.virtualMembers)
  );
}

export { virtualMemberKey };

/**
 * Guards the same-file/global definition fallback in index queries: a
 * member-scoped target such as `g_vbss_ops.vbss_if_get_sta_assoc` must not
 * bind to an unowned global function that merely shares the member's name
 * (the facade pattern), while receiver-typed targets still match their
 * member-function definitions, including virtual base overrides.
 */
export function definitionOwnerMatchesTarget(
  targetMemberOwner: string | undefined,
  definitionMemberOwner: string | undefined,
  memberName: string,
  dispatch: VirtualDispatchIndex
): boolean {
  if (targetMemberOwner === undefined) {
    return true;
  }
  return (
    definitionMemberOwner !== undefined &&
    virtualMemberOwnersMatch(targetMemberOwner, definitionMemberOwner, memberName, dispatch)
  );
}
