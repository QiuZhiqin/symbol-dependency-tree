import { describe, expect, it } from "vitest";
import { indexStatusPresentation } from "../../src/utils/indexStatusPresentation";

describe("indexStatusPresentation", () => {
  it("shows build progress in the native status bar text", () => {
    expect(
      indexStatusPresentation({
        phase: "building",
        stats: { files: 12, functions: 80, calls: 160 },
        processedFiles: 12,
        totalFiles: 48
      })
    ).toEqual({
      text: "$(sync~spin) C/C++ index: 25%",
      label: "Building index",
      busy: true,
      progress: { processed: 12, total: 48, percent: 25 }
    });
  });

  it("keeps rebuild available for ready and failed indexes", () => {
    expect(
      indexStatusPresentation({
        phase: "ready",
        stats: { files: 4, functions: 20, calls: 40 }
      }).busy
    ).toBe(false);
    expect(
      indexStatusPresentation({
        phase: "error",
        stats: { files: 4, functions: 20, calls: 40 },
        detail: "disk error"
      }).busy
    ).toBe(false);
  });
});
