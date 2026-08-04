import { describe, expect, it } from "vitest";
import {
  virtualMemberKey,
  virtualMemberOwnersMatch
} from "../../src/utils/virtualDispatch";

describe("virtual dispatch", () => {
  const baseTypes = new Map<string, ReadonlySet<string>>([
    ["AssociationTask", new Set(["Task"])],
    ["SpecialAssociationTask", new Set(["AssociationTask"])],
    ["UnrelatedTask", new Set(["OtherBase"])]
  ]);
  const virtualMembers = new Set([virtualMemberKey("Task", "handle_message")]);

  it("matches a base-typed virtual call to direct and transitive overrides", () => {
    expect(
      virtualMemberOwnersMatch(
        "AssociationTask",
        "Task",
        "handle_message",
        baseTypes,
        virtualMembers
      )
    ).toBe(true);
    expect(
      virtualMemberOwnersMatch(
        "SpecialAssociationTask",
        "Task",
        "handle_message",
        baseTypes,
        virtualMembers
      )
    ).toBe(true);
  });

  it("does not merge unrelated or non-virtual equal member names", () => {
    expect(
      virtualMemberOwnersMatch(
        "UnrelatedTask",
        "Task",
        "handle_message",
        baseTypes,
        virtualMembers
      )
    ).toBe(false);
    expect(
      virtualMemberOwnersMatch(
        "AssociationTask",
        "Task",
        "ordinary_method",
        baseTypes,
        virtualMembers
      )
    ).toBe(false);
  });
});
