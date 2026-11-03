import { describe, expect, it } from "vitest";
import type { FileTypeContributions } from "../../src/services/callIndexDatabase";
import { memberTypeKey, TypeLookup } from "../../src/services/typeLookup";
import { virtualMemberKey } from "../../src/utils/virtualDispatch";

function contributions(partial: Partial<FileTypeContributions>): FileTypeContributions {
  return { memberTypes: [], objectTypes: [], inheritances: [], virtualMembers: [], ...partial };
}

describe("TypeLookup", () => {
  it("marks conflicting member and object types as ambiguous until the conflict is removed", () => {
    const types = new TypeLookup();
    const first = contributions({
      memberTypes: [{ owner: "Box", member: "value", typeName: "int" }],
      objectTypes: [{ name: "g_box", typeName: "Box" }]
    });
    const second = contributions({
      memberTypes: [{ owner: "Box", member: "value", typeName: "long" }],
      objectTypes: [{ name: "g_box", typeName: "Crate" }]
    });
    types.add(first);
    types.add(second);
    expect(types.memberTypes.has(memberTypeKey("Box", "value"))).toBe(true);
    expect(types.memberTypes.get(memberTypeKey("Box", "value"))).toBeUndefined();
    expect(types.objectTypes.has("g_box")).toBe(true);
    expect(types.objectTypes.get("g_box")).toBeUndefined();

    types.remove(second);
    expect(types.memberTypes.get(memberTypeKey("Box", "value"))).toBe("int");
    expect(types.objectTypes.get("g_box")).toBe("Box");

    types.remove(first);
    expect(types.memberTypes.size).toBe(0);
    expect(types.objectTypes.size).toBe(0);
  });

  it("keeps every base of a multiple inheritance and edges other files still contribute", () => {
    const types = new TypeLookup();
    const header = contributions({
      inheritances: [
        { derived: "D", base: "A" },
        { derived: "D", base: "B" }
      ]
    });
    const copy = contributions({ inheritances: [{ derived: "D", base: "A" }] });
    types.add(header);
    types.add(copy);
    expect(types.baseTypes.get("D")).toEqual(new Set(["A", "B"]));

    types.remove(header);
    expect(types.baseTypes.get("D")).toEqual(new Set(["A"]));

    types.remove(copy);
    expect(types.baseTypes.has("D")).toBe(false);
  });

  it("keeps a virtual member while any file still declares it", () => {
    const types = new TypeLookup();
    const declaration = contributions({ virtualMembers: [{ owner: "Task", name: "run" }] });
    const override = contributions({ virtualMembers: [{ owner: "Task", name: "run" }] });
    types.add(declaration);
    types.add(override);

    types.remove(declaration);
    expect(types.virtualMembers.has(virtualMemberKey("Task", "run"))).toBe(true);

    types.remove(override);
    expect(types.virtualMembers.size).toBe(0);
  });

  it("reuses the dispatch lookups until the types change", () => {
    const types = new TypeLookup();
    const task = contributions({
      inheritances: [{ derived: "VbssTask", base: "Task" }],
      virtualMembers: [{ owner: "Task", name: "handle_message" }]
    });
    types.add(task);
    const dispatch = types.dispatch;
    expect(types.dispatch).toBe(dispatch);
    expect(dispatch.knownOwnersNamed("vbsstask")).toEqual(["VbssTask"]);
    expect(dispatch.virtualOwnersOf("handle_message")).toEqual(["Task"]);

    types.remove(task);
    expect(types.dispatch).not.toBe(dispatch);
    expect(types.dispatch.knownOwners.size).toBe(0);
    expect(types.dispatch.virtualOwnersOf("handle_message")).toEqual([]);

    types.add(task);
    expect(types.dispatch.knownOwners).toEqual(new Set(["VbssTask", "Task"]));
    types.clear();
    expect(types.dispatch.knownOwners.size).toBe(0);
  });
});
