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

function knownVirtualOwners(
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
): Set<string> {
  const owners = new Set<string>();
  for (const [derived, bases] of baseTypes) {
    owners.add(derived);
    for (const base of bases) {
      owners.add(base);
    }
  }
  for (const member of virtualMembers) {
    const separator = member.indexOf("\u0000");
    if (separator > 0) {
      owners.add(member.slice(0, separator));
    }
  }
  return owners;
}

function canonicalVirtualOwner(
  owner: string,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
): string {
  const knownOwners = knownVirtualOwners(baseTypes, virtualMembers);
  if (knownOwners.has(owner)) {
    return owner;
  }
  const matches = [...knownOwners].filter(
    (candidate) => candidate.toLocaleLowerCase() === owner.toLocaleLowerCase()
  );
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
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
): string {
  const hierarchyMatches = [...knownVirtualOwners(baseTypes, virtualMembers)].filter(
    (candidate) =>
      candidate.toLocaleLowerCase() === owner.toLocaleLowerCase() &&
      ownersAreRelated(targetOwner, candidate, baseTypes)
  );
  return hierarchyMatches.length === 1
    ? hierarchyMatches[0]!
    : canonicalVirtualOwner(owner, baseTypes, virtualMembers);
}

function canRecoverUnknownReceiver(
  targetOwner: string,
  member: string,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
): boolean {
  const targetAncestors = ancestorsOf(targetOwner, baseTypes);
  if (!hasVirtualMember(targetAncestors, member, virtualMembers)) {
    return false;
  }
  const virtualOwners = [...virtualMembers]
    .filter((entry) => entry.endsWith(`\u0000${member}`))
    .map((entry) => entry.slice(0, entry.indexOf("\u0000")));
  return (
    virtualOwners.length > 0 &&
    virtualOwners.every((owner) => ownersAreRelated(targetOwner, owner, baseTypes))
  );
}

export function virtualMemberOwnersMatch(
  targetOwner: string,
  candidateOwner: string,
  member: string,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
): boolean {
  targetOwner = canonicalVirtualOwner(targetOwner, baseTypes, virtualMembers);
  candidateOwner = canonicalOwnerWithinHierarchy(
    candidateOwner,
    targetOwner,
    baseTypes,
    virtualMembers
  );
  if (targetOwner === candidateOwner) {
    return true;
  }
  const knownOwners = knownVirtualOwners(baseTypes, virtualMembers);
  const targetKnown = knownOwners.has(targetOwner);
  const candidateKnown = knownOwners.has(candidateOwner);
  if (targetKnown !== candidateKnown) {
    return canRecoverUnknownReceiver(
      targetKnown ? targetOwner : candidateOwner,
      member,
      baseTypes,
      virtualMembers
    );
  }
  if (!targetKnown) {
    return false;
  }
  const targetAncestors = ancestorsOf(targetOwner, baseTypes);
  const candidateAncestors = ancestorsOf(candidateOwner, baseTypes);
  if (!targetAncestors.has(candidateOwner) && !candidateAncestors.has(targetOwner)) {
    return false;
  }
  return (
    hasVirtualMember(targetAncestors, member, virtualMembers) ||
    hasVirtualMember(candidateAncestors, member, virtualMembers)
  );
}

export { virtualMemberKey };
