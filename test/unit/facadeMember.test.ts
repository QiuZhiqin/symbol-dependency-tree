import { describe, expect, it } from "vitest";
import { scanCallIndexFile } from "../../src/utils/callIndexScanner";

const facadeSource = `
typedef int (*vbss_if_get_sta_assoc_func_t)(const char *mac, int ctx);

typedef struct {
    vbss_if_get_sta_assoc_func_t vbss_if_get_sta_assoc;
    int plain_member;
} vbss_operations_t;

static vbss_operations_t g_vbss_ops = {0};

int vbss_if_get_sta_assoc(const char *mac, int ctx) {
    if (!g_vbss_ops.vbss_if_get_sta_assoc) {
        return -1;
    }
    return g_vbss_ops.vbss_if_get_sta_assoc(mac, ctx);
}
`;

describe("facade member/function disambiguation", () => {
  it("indexes the typedef-named struct and its function-pointer member", () => {
    const indexed = scanCallIndexFile(facadeSource);

    expect(indexed.definitions.map((definition) => definition.name)).toContain(
      "vbss_if_get_sta_assoc"
    );
    expect(
      indexed.definitions.filter((definition) => definition.kind === "type").map(
        (definition) => definition.name
      )
    ).toContain("vbss_operations_t");
    expect(
      indexed.declarations.find(
        (declaration) =>
          declaration.name === "vbss_if_get_sta_assoc" &&
          declaration.scope.kind === "member" &&
          declaration.scope.owner === "vbss_operations_t"
      )
    ).toMatchObject({ typeName: "vbss_if_get_sta_assoc_func_t" });
  });

  it("keeps member usages scoped to the struct owner while the facade stays global", () => {
    const indexed = scanCallIndexFile(facadeSource);

    const memberUsages = indexed.calls.filter(
      (call) =>
        call.callee === "vbss_if_get_sta_assoc" &&
        call.scope?.kind === "member"
    );
    expect(memberUsages.length).toBeGreaterThanOrEqual(2);
    for (const usage of memberUsages) {
      expect(usage.scope).toMatchObject({ owner: "vbss_operations_t" });
    }
    expect(
      indexed.calls.find(
        (call) =>
          call.callee === "vbss_if_get_sta_assoc" && call.scope === undefined
      )
    ).toBeUndefined();
  });
});
