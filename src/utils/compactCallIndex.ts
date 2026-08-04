import type {
  IndexedFileRecord,
  PersistentIndexDocument,
  StoredCallSite
} from "../model/persistentIndexTypes";
import type { IndexedFunctionDefinition } from "./callIndexScanner";

export const compactCallIndexVersion = 15;
export const legacyCallIndexVersion = 10;

type DefinitionTuple = [
  name: number,
  rangeStartDelta: number,
  rangeLength: number,
  selectionOffset: number,
  selectionLength: number,
  kind: number,
  isStatic: number,
  memberOwner: number,
  typeKind: number
];

type ScopeTuple =
  | [kind: 0, functionSelectionStart: number, declarationOffset: number]
  | [kind: 1, owner: number];

type CallTuple = [
  callee: number,
  offsetDelta: number,
  kind: number,
  scope: ScopeTuple | null,
  memberOwnerPath: readonly number[] | null,
  implicitMemberOwner: number,
  callerIndex: number
];

type MemberTypeTuple = [owner: number, member: number, typeName: number];
type ObjectTypeTuple = [name: number, typeName: number];
type InheritanceTuple = [derived: number, base: number];
type VirtualMemberTuple = [owner: number, name: number];

type FileTuple = [
  uri: number,
  mtime: number,
  size: number,
  definitions: readonly DefinitionTuple[],
  calls: readonly CallTuple[],
  memberTypes: readonly MemberTypeTuple[],
  objectTypes: readonly ObjectTypeTuple[],
  inheritances: readonly InheritanceTuple[],
  virtualMembers: readonly VirtualMemberTuple[]
];

interface CompactCallIndexDocument {
  readonly v: typeof compactCallIndexVersion;
  readonly s: readonly string[];
  readonly r: readonly number[];
  readonly f: readonly FileTuple[];
  readonly d?: readonly number[];
}

interface StringTable {
  readonly values: string[];
  readonly id: (value: string) => number;
}

function createStringTable(): StringTable {
  const values: string[] = [];
  const ids = new Map<string, number>();
  return {
    values,
    id: (value): number => {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const id = values.length;
      values.push(value);
      ids.set(value, id);
      return id;
    }
  };
}

function definitionKind(kind: IndexedFunctionDefinition["kind"]): number {
  return kind === "function" ? 0 : kind === "initializer" ? 1 : 2;
}

function decodeDefinitionKind(value: number): IndexedFunctionDefinition["kind"] {
  if (value === 0) {
    return "function";
  }
  if (value === 1) {
    return "initializer";
  }
  if (value === 2) {
    return "type";
  }
  throw new Error(`Unknown compact definition kind: ${value}`);
}

function typeKind(kind: IndexedFunctionDefinition["typeKind"]): number {
  if (kind === undefined) {
    return -1;
  }
  return kind === "class" ? 0 : kind === "enum" ? 1 : kind === "struct" ? 2 : 3;
}

function decodeTypeKind(
  value: number
): IndexedFunctionDefinition["typeKind"] {
  if (value === -1) {
    return undefined;
  }
  if (value === 0) {
    return "class";
  }
  if (value === 1) {
    return "enum";
  }
  if (value === 2) {
    return "struct";
  }
  if (value === 3) {
    return "union";
  }
  throw new Error(`Unknown compact type kind: ${value}`);
}

function encodeScope(
  call: StoredCallSite,
  stringId: (value: string) => number
): ScopeTuple | null {
  if (call.scope === undefined) {
    return null;
  }
  return call.scope.kind === "local"
    ? [
        0,
        call.scope.functionSelectionStart,
        call.scope.declarationOffset
      ]
    : [1, stringId(call.scope.owner)];
}

function encodeOwnerPath(
  call: StoredCallSite,
  stringId: (value: string) => number
): readonly number[] | null {
  return call.memberOwnerPath === undefined
    ? null
    : [
        stringId(call.memberOwnerPath.rootOwner),
        ...call.memberOwnerPath.members.map(stringId)
      ];
}

function requireString(strings: readonly string[], id: number): string {
  const value = strings[id];
  if (value === undefined) {
    throw new Error(`Unknown compact string id: ${id}`);
  }
  return value;
}

function encodeFile(
  file: IndexedFileRecord,
  stringId: (value: string) => number
): FileTuple {
  const sortedDefinitions = file.definitions
    .map((definition, oldIndex) => ({ definition, oldIndex }))
    .sort(
      (left, right) =>
        left.definition.rangeStart - right.definition.rangeStart ||
        left.definition.selectionStart - right.definition.selectionStart
    );
  const callerIndexes = new Map(
    sortedDefinitions.map(({ oldIndex }, newIndex) => [oldIndex, newIndex])
  );
  let previousDefinitionStart = 0;
  const definitions = sortedDefinitions.map(({ definition }): DefinitionTuple => {
    const rangeStart = definition.rangeStart;
    const tuple: DefinitionTuple = [
      stringId(definition.name),
      rangeStart - previousDefinitionStart,
      definition.rangeEnd - rangeStart,
      definition.selectionStart - rangeStart,
      definition.selectionEnd - definition.selectionStart,
      definitionKind(definition.kind),
      definition.isStatic ? 1 : 0,
      definition.memberOwner === undefined
        ? -1
        : stringId(definition.memberOwner),
      typeKind(definition.typeKind)
    ];
    previousDefinitionStart = rangeStart;
    return tuple;
  });

  let previousCallOffset = 0;
  const calls = [...file.calls]
    .sort((left, right) => left.offset - right.offset)
    .map((call): CallTuple => {
      const callerIndex = callerIndexes.get(call.callerIndex);
      if (callerIndex === undefined) {
        throw new Error(
          `Call ${call.callee} in ${file.uri} has an invalid caller index`
        );
      }
      const offset = call.offset;
      const tuple: CallTuple = [
        stringId(call.callee),
        offset - previousCallOffset,
        call.kind === "callable" ? 0 : 1,
        encodeScope(call, stringId),
        encodeOwnerPath(call, stringId),
        call.implicitMemberOwner === undefined
          ? -1
          : stringId(call.implicitMemberOwner),
        callerIndex
      ];
      previousCallOffset = offset;
      return tuple;
    });

  return [
    stringId(file.uri),
    file.mtime,
    file.size,
    definitions,
    calls,
    file.memberTypes.map((member) => [
      stringId(member.owner),
      stringId(member.member),
      stringId(member.typeName)
    ]),
    (file.objectTypes ?? []).map((objectType) => [
      stringId(objectType.name),
      stringId(objectType.typeName)
    ]),
    (file.inheritances ?? []).map((inheritance) => [
      stringId(inheritance.derived),
      stringId(inheritance.base)
    ]),
    (file.virtualMembers ?? []).map((member) => [
      stringId(member.owner),
      stringId(member.name)
    ])
  ];
}

function decodeFile(
  file: FileTuple,
  strings: readonly string[]
): IndexedFileRecord {
  let rangeStart = 0;
  const definitions = file[3].map((definition): IndexedFunctionDefinition => {
    rangeStart += definition[1];
    const selectionStart = rangeStart + definition[3];
    const memberOwner =
      definition[7] === -1
        ? undefined
        : requireString(strings, definition[7]);
    const decodedTypeKind = decodeTypeKind(definition[8]);
    return {
      name: requireString(strings, definition[0]),
      rangeStart,
      rangeEnd: rangeStart + definition[2],
      selectionStart,
      selectionEnd: selectionStart + definition[4],
      kind: decodeDefinitionKind(definition[5]),
      isStatic: definition[6] === 1,
      ...(memberOwner === undefined ? {} : { memberOwner }),
      ...(decodedTypeKind === undefined ? {} : { typeKind: decodedTypeKind })
    };
  });

  let offset = 0;
  const calls = file[4].map((call): StoredCallSite => {
    offset += call[1];
    const scope =
      call[3] === null
        ? undefined
        : call[3][0] === 0
          ? {
              kind: "local" as const,
              functionSelectionStart: call[3][1],
              declarationOffset: call[3][2]
            }
          : {
              kind: "member" as const,
              owner: requireString(strings, call[3][1])
            };
    const memberOwnerPath =
      call[4] === null
        ? undefined
        : {
            rootOwner: requireString(strings, call[4][0]!),
            members: call[4].slice(1).map((id) => requireString(strings, id))
          };
    const implicitMemberOwner =
      call[5] === -1 ? undefined : requireString(strings, call[5]);
    return {
      callee: requireString(strings, call[0]),
      offset,
      kind: call[2] === 0 ? "callable" : "symbol",
      ...(scope === undefined ? {} : { scope }),
      ...(memberOwnerPath === undefined ? {} : { memberOwnerPath }),
      ...(implicitMemberOwner === undefined ? {} : { implicitMemberOwner }),
      callerIndex: call[6]
    };
  });

  return {
    uri: requireString(strings, file[0]),
    mtime: file[1],
    size: file[2],
    definitions,
    calls,
    memberTypes: file[5].map((member) => ({
      owner: requireString(strings, member[0]),
      member: requireString(strings, member[1]),
      typeName: requireString(strings, member[2])
    })),
    objectTypes: file[6].map((objectType) => ({
      name: requireString(strings, objectType[0]),
      typeName: requireString(strings, objectType[1])
    })),
    inheritances: file[7].map((inheritance) => ({
      derived: requireString(strings, inheritance[0]),
      base: requireString(strings, inheritance[1])
    })),
    virtualMembers: file[8].map((member) => ({
      owner: requireString(strings, member[0]),
      name: requireString(strings, member[1])
    }))
  };
}

export function encodeCompactCallIndex(
  document: PersistentIndexDocument
): CompactCallIndexDocument {
  const strings = createStringTable();
  return {
    v: compactCallIndexVersion,
    s: strings.values,
    r: document.roots.map(strings.id),
    f: [...document.files]
      .sort((left, right) => left.uri.localeCompare(right.uri))
      .map((file) => encodeFile(file, strings.id)),
    ...(document.deletedUris.length === 0
      ? {}
      : { d: document.deletedUris.map(strings.id) })
  };
}

export function isCompactCallIndex(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    value.v === compactCallIndexVersion
  );
}

export function decodeCompactCallIndex(
  value: unknown
): PersistentIndexDocument {
  if (!isCompactCallIndex(value)) {
    throw new Error("Unsupported compact call-index version");
  }
  const compact = value as CompactCallIndexDocument;
  if (
    !Array.isArray(compact.s) ||
    !Array.isArray(compact.r) ||
    !Array.isArray(compact.f)
  ) {
    throw new Error("Invalid compact call-index document");
  }
  return {
    roots: compact.r.map((id) => requireString(compact.s, id)),
    files: compact.f.map((file) => decodeFile(file, compact.s)),
    deletedUris: (compact.d ?? []).map((id) => requireString(compact.s, id))
  };
}
