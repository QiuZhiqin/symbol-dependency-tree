import { describe, expect, it } from "vitest";
import {
  decodeCompressedOrPlainJson,
  encodeCompressedJson,
  isGzip
} from "../../src/utils/compressedJson";

describe("compressed JSON persistence", () => {
  it("round-trips repetitive index data through gzip", async () => {
    const value = {
      version: 9,
      files: Array.from({ length: 100 }, (_, index) => ({
        uri: `file:///workspace/source-${index}.c`,
        calls: Array.from({ length: 50 }, () => ({
          callee: "repeated_callback_name",
          kind: "callable",
          scope: { kind: "member", owner: "repeated_event_ops" }
        }))
      }))
    };
    const plain = Buffer.from(JSON.stringify(value), "utf8");
    const compressed = await encodeCompressedJson(value);

    expect(isGzip(compressed.bytes)).toBe(true);
    expect(compressed.uncompressedBytes).toBe(plain.byteLength);
    expect(compressed.bytes.byteLength).toBeLessThan(plain.byteLength / 10);
    await expect(
      decodeCompressedOrPlainJson(compressed.bytes)
    ).resolves.toEqual(value);
  });

  it("continues to read legacy uncompressed JSON", async () => {
    const value = { version: 9, files: [] };
    const plain = Buffer.from(JSON.stringify(value), "utf8");

    expect(isGzip(plain)).toBe(false);
    await expect(decodeCompressedOrPlainJson(plain)).resolves.toEqual(value);
  });
});
