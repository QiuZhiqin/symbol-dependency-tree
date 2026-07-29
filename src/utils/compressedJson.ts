import { constants, gzip, gunzip } from "node:zlib";

export interface CompressedJson {
  readonly bytes: Uint8Array;
  readonly uncompressedBytes: number;
}

function gzipBytes(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(
      bytes,
      { level: constants.Z_BEST_COMPRESSION },
      (error, result) => {
        if (error === null) {
          resolve(result);
        } else {
          reject(error);
        }
      }
    );
  });
}

function gunzipBytes(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, (error, result) => {
      if (error === null) {
        resolve(result);
      } else {
        reject(error);
      }
    });
  });
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function encodeCompressedJson(
  value: unknown
): Promise<CompressedJson> {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  return {
    bytes: await gzipBytes(plain),
    uncompressedBytes: plain.byteLength
  };
}

export async function decodeCompressedOrPlainJson<T>(
  bytes: Uint8Array
): Promise<T> {
  const plain = isGzip(bytes) ? await gunzipBytes(bytes) : Buffer.from(bytes);
  return JSON.parse(plain.toString("utf8")) as T;
}
