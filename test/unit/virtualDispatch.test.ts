import { describe, expect, it } from "vitest";
import {
  definitionOwnerMatchesTarget,
  VirtualDispatchIndex,
  virtualMemberKey,
  virtualMemberOwnersMatch
} from "../../src/utils/virtualDispatch";

describe("virtual dispatch", () => {
  const baseTypes = new Map<string, ReadonlySet<string>>([
    ["AssociationTask", new Set(["Task"])],
    ["SpecialAssociationTask", new Set(["AssociationTask"])],
    ["VbssTask", new Set(["Task"])],
    ["controller_task", new Set(["task"])],
    ["UnrelatedTask", new Set(["OtherBase"])]
  ]);
  const virtualMembers = new Set([virtualMemberKey("Task", "handle_message")]);
  const dispatch = new VirtualDispatchIndex(baseTypes, virtualMembers);

  it("matches a base-typed virtual call to direct and transitive overrides", () => {
    expect(
      virtualMemberOwnersMatch(
        "AssociationTask",
        "Task",
        "handle_message",
        dispatch
      )
    ).toBe(true);
    expect(
      virtualMemberOwnersMatch(
        "SpecialAssociationTask",
        "Task",
        "handle_message",
        dispatch
      )
    ).toBe(true);
  });

  it("does not merge unrelated or non-virtual equal member names", () => {
    expect(
      virtualMemberOwnersMatch(
        "UnrelatedTask",
        "Task",
        "handle_message",
        dispatch
      )
    ).toBe(false);
    expect(
      virtualMemberOwnersMatch(
        "AssociationTask",
        "Task",
        "ordinary_method",
        dispatch
      )
    ).toBe(false);
  });

  it.each(["task", "handler", "current_entry", "implementation"])(
    "recovers an untyped auto receiver named %s in an unambiguous virtual hierarchy",
    (receiver) => {
      expect(
        virtualMemberOwnersMatch(
          "VbssTask",
          receiver,
          "handle_message",
          dispatch
        )
      ).toBe(true);
    }
  );

  it("prefers the target inheritance family over an unrelated exact-case type name", () => {
    expect(
      virtualMemberOwnersMatch(
        "VbssTask",
        "task",
        "handle_message",
        dispatch
      )
    ).toBe(true);
  });

  it("recovers arbitrary receiver names through transitive inheritance", () => {
    expect(
      virtualMemberOwnersMatch(
        "SpecialAssociationTask",
        "selected_handler",
        "handle_message",
        dispatch
      )
    ).toBe(true);
  });

  it("does not guess when unrelated virtual hierarchies use the same member name", () => {
    const ambiguousVirtualMembers = new Set([
      ...virtualMembers,
      virtualMemberKey("OtherBase", "handle_message")
    ]);
    expect(
      virtualMemberOwnersMatch(
        "VbssTask",
        "handler",
        "handle_message",
        new VirtualDispatchIndex(baseTypes, ambiguousVirtualMembers)
      )
    ).toBe(false);
  });

  it("does not recover an unresolved receiver for a non-virtual member", () => {
    expect(
      virtualMemberOwnersMatch(
        "VbssTask",
        "handler",
        "ordinary_method",
        dispatch
      )
    ).toBe(false);
  });

  it("keeps member-scoped targets from binding to an unowned same-name function", () => {
    expect(
      definitionOwnerMatchesTarget(
        "vbss_operations_t",
        undefined,
        "vbss_if_get_sta_assoc",
        dispatch
      )
    ).toBe(false);
  });

  it("binds member-scoped targets to same-owner and virtual-family definitions", () => {
    expect(
      definitionOwnerMatchesTarget(
        "vbss_operations_t",
        "vbss_operations_t",
        "vbss_if_get_sta_assoc",
        dispatch
      )
    ).toBe(true);
    expect(
      definitionOwnerMatchesTarget(
        "SpecialAssociationTask",
        "AssociationTask",
        "handle_message",
        dispatch
      )
    ).toBe(true);
  });

  it("keeps unowned function targets binding to unowned definitions", () => {
    expect(
      definitionOwnerMatchesTarget(
        undefined,
        undefined,
        "vbss_if_get_sta_assoc",
        dispatch
      )
    ).toBe(true);
  });
});
