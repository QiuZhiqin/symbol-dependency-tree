import { describe, expect, it } from "vitest";
import { scanCallIndexFile } from "../../src/utils/callIndexScanner";

// Guards the scope-downgrade precondition: namespaces (unlike classes) do not
// become indexed type definitions, and namespace-qualified calls keep member
// scope with the namespace as owner. Query-side member-scope downgrading must
// therefore skip owners that are not real indexed types.
const source = `namespace advanced {

int qualified_target(int value)
{
  return value;
}

}

class AdvancedWorker {
public:
  int read() const noexcept;
};

int AdvancedWorker::read() const noexcept
{
  return advanced::qualified_target(2);
}
`;

describe("namespace-qualified scanner facts", () => {
  it("does not index a namespace as a type definition", () => {
    const indexed = scanCallIndexFile(source);
    expect(
      indexed.definitions.filter(
        (definition) => definition.name === "advanced" && definition.kind === "type"
      )
    ).toHaveLength(0);
    expect(
      indexed.definitions.filter(
        (definition) =>
          definition.name === "AdvancedWorker" && definition.kind === "type"
      )
    ).toHaveLength(1);
  });

  it("records namespace-qualified calls with the namespace as owner", () => {
    const indexed = scanCallIndexFile(source);
    const call = indexed.calls.find(
      (entry) => entry.callee === "qualified_target" && entry.kind === "callable"
    );
    expect(call).toBeDefined();
    expect(call?.scope).toMatchObject({ kind: "member", owner: "advanced" });
  });
});
