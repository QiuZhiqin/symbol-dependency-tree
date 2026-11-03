/**
 * `std::shared_ptr<T>`, `std::unique_ptr<T>` and `std::weak_ptr<T>` are
 * recorded as `smart_ptr<T>` (no identifier can contain `<`), so a call
 * through `->` can reach `T` while the smart pointer's own members stay apart.
 */
const prefix = "smart_ptr<";

export const smartPointerTemplates: ReadonlySet<string> = new Set([
  "shared_ptr",
  "unique_ptr",
  "weak_ptr"
]);

/** Calls whose template argument is the pointee of the smart pointer they return. */
export const smartPointerFactories: ReadonlySet<string> = new Set([
  ...smartPointerTemplates,
  "const_pointer_cast",
  "dynamic_pointer_cast",
  "make_shared",
  "make_unique",
  "static_pointer_cast"
]);

/** Members of the smart pointer itself, which a call with `.` reaches. */
const smartPointerMembers = new Set([
  "expired",
  "get",
  "get_deleter",
  "lock",
  "owner_before",
  "release",
  "reset",
  "swap",
  "unique",
  "use_count"
]);

/** Members the smart pointer itself answers with a pointer: `p.get()`, `w.lock()`. */
const smartPointerAccessors = new Set(["get", "lock"]);

/**
 * The path member for a call `.name()`. `.get` and `.lock` keep the `.` so
 * the query can tell the smart pointer's own `p.get()` from the pointee's
 * `p->get()`; every other name is recorded as is.
 */
export function dotCallPathMember(name: string): string {
  return smartPointerAccessors.has(name) ? `.${name}` : name;
}

export function smartPointerType(pointee: string): string {
  return `${prefix}${pointee}>`;
}

function smartPointee(typeName: string): string | undefined {
  return typeName.startsWith(prefix) && typeName.endsWith(">")
    ? typeName.slice(prefix.length, -1)
    : undefined;
}

/**
 * The type a path member on `owner` yields. On a smart pointer, `.lock()`
 * keeps the pointer and `.get()` yields the pointee; any other member,
 * `->get()` included, is the pointee's own member.
 */
export function memberTypeOf(
  owner: string,
  member: string,
  memberType: (owner: string, member: string) => string | undefined
): string | undefined {
  const accessor = member.startsWith(".") ? member.slice(1) : undefined;
  const name = accessor ?? member;
  const pointee = smartPointee(owner);
  if (pointee === undefined) {
    return memberType(owner, name);
  }
  if (accessor === "lock") {
    return owner;
  }
  return accessor === "get" ? pointee : memberType(pointee, name);
}

/**
 * The owner whose member `memberName` a call on a receiver of type `owner`
 * reaches: the pointee for a smart pointer, unless the name is one of the
 * smart pointer's own members (`p.reset()`).
 */
export function calledMemberOwner(owner: string, memberName: string): string {
  const pointee = smartPointee(owner);
  return pointee === undefined || smartPointerMembers.has(memberName) ? owner : pointee;
}
