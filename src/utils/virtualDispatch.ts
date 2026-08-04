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

export function virtualMemberOwnersMatch(
  targetOwner: string,
  candidateOwner: string,
  member: string,
  baseTypes: ReadonlyMap<string, ReadonlySet<string>>,
  virtualMembers: ReadonlySet<string>
): boolean {
  if (targetOwner === candidateOwner) {
    return true;
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
