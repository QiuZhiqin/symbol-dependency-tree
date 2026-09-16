import { describe, expect, it } from "vitest";
import { scanCallIndexFile } from "../../src/utils/callIndexScanner";

// Mirrors ap_manager.cpp: the class is declared in a header, the member is
// defined with a qualified name in the .cpp, and called unqualified from
// another member function. The call-site file itself has no declaration,
// so navigation must rely on the index binding, not the local scanner.
const memberCallSource = `
class ApManager {
public:
    void handle_1905_message(int cmdu);
    void handle_vbss_security_request(int cmdu);
};

void ApManager::handle_1905_message(int cmdu_rx) {
    handle_vbss_security_request(cmdu_rx);
}

void ApManager::handle_vbss_security_request(int cmdu_rx) {
    int x = 1;
}
`;

describe("same-file member call navigation", () => {
  it("records the unqualified member call with its implicit owner", () => {
    const indexed = scanCallIndexFile(memberCallSource);

    const call = indexed.calls.find(
      (entry) => entry.callee === "handle_vbss_security_request" && entry.kind === "callable"
    );
    expect(call).toBeDefined();
    expect((call as { implicitMemberOwner?: unknown }).implicitMemberOwner).toBe("ApManager");
  });

  it("records the qualified member definition with its owner", () => {
    const indexed = scanCallIndexFile(memberCallSource);

    const definition = indexed.definitions.find(
      (entry) => entry.name === "handle_vbss_security_request" && entry.kind === "function"
    );
    expect(definition).toBeDefined();
    expect(definition?.memberOwner).toBe("ApManager");
  });
});
