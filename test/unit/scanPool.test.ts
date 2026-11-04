import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanFileContent, type FileContent } from "../../src/services/fileContent";
import {
  inThreadScanner,
  ScanPool,
  type ScanInput,
  type ScanReply,
  type ScanWorker
} from "../../src/services/scanPool";

class FakeWorker extends EventEmitter implements ScanWorker {
  public readonly inputs: string[] = [];
  public terminated = false;

  public postMessage(input: ScanInput): void {
    this.inputs.push("text" in input ? input.text : input.path);
  }

  public async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  public reply(reply: ScanReply): void {
    this.emit("message", reply);
  }
}

function content(name: string): FileContent {
  return { definitions: [], calls: [], memberTypes: [{ owner: name, member: "member", typeName: "type" }] };
}

let workers: FakeWorker[];

function newPool(size: number, idleMs?: number): ScanPool {
  workers = [];
  return new ScanPool(size, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, idleMs);
}

function scanText(pool: ScanPool, text: string): Promise<FileContent> {
  return pool.scan({ text });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ScanPool", () => {
  it("starts up to `size` workers, queues up to eight files on each, and answers in order", async () => {
    const pool = newPool(2);
    const texts = Array.from({ length: 17 }, (_, number) => `file${number}`);
    const scans = texts.map((text) => scanText(pool, text));

    expect(workers.map((worker) => worker.inputs)).toEqual([
      texts.filter((_, number) => number % 2 === 0).slice(0, 8),
      texts.filter((_, number) => number % 2 === 1)
    ]);
    const first = content("file0");
    workers[0]!.reply({ content: first });
    await expect(scans[0]).resolves.toBe(first);
    expect(workers[0]!.inputs.at(-1)).toBe("file16");
    const third = content("file2");
    workers[0]!.reply({ content: third });
    await expect(scans[2]).resolves.toBe(third);
    pool.dispose();
    await Promise.allSettled(scans);
  });

  it("fails only the file whose scan threw", async () => {
    const pool = newPool(1);
    const failing = scanText(pool, "bad");
    const next = scanText(pool, "good");

    workers[0]!.reply({ error: "boom" });
    await expect(failing).rejects.toThrow("boom");
    const good = content("good");
    workers[0]!.reply({ content: good });
    await expect(next).resolves.toBe(good);
    pool.dispose();
  });

  it("fails the file a stopped worker was scanning and moves the one waiting behind it", async () => {
    const pool = newPool(1);
    const lost = scanText(pool, "x");
    const waiting = scanText(pool, "y");
    expect(workers[0]!.inputs).toEqual(["x", "y"]);

    workers[0]!.emit("error", new Error("crash"));
    workers[0]!.emit("exit", 1);
    await expect(lost).rejects.toThrow("crash");
    expect(workers).toHaveLength(2);
    expect(workers[1]!.inputs).toEqual(["y"]);
    const y = content("y");
    workers[1]!.reply({ content: y });
    await expect(waiting).resolves.toBe(y);
    pool.dispose();
  });

  it("stops idle workers after the idle time and starts new ones for later files", async () => {
    vi.useFakeTimers();
    const pool = newPool(2, 1000);
    const scan = scanText(pool, "a");
    workers[0]!.reply({ content: content("a") });
    await scan;

    vi.advanceTimersByTime(999);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(workers[0]!.terminated).toBe(true);
    workers[0]!.emit("exit", 0);

    const later = scanText(pool, "b");
    expect(workers).toHaveLength(2);
    expect(workers[1]!.inputs).toEqual(["b"]);
    pool.dispose();
    await expect(later).rejects.toThrow("disposed");
  });

  it("rejects queued and running scans when disposed and terminates its workers", async () => {
    const pool = newPool(1);
    const scans = ["a", "b", "c"].map((text) => scanText(pool, text));

    pool.dispose();
    await Promise.all(scans.map((scan) => expect(scan).rejects.toThrow("disposed")));
    await expect(scanText(pool, "d")).rejects.toThrow("disposed");
    expect(workers[0]!.terminated).toBe(true);
    workers[0]!.reply({ content: content("a") });
    expect(workers).toHaveLength(1);
  });
});

describe("inThreadScanner", () => {
  it("reads a local file the same way as text that was already read", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sdt-scan-"));
    try {
      const source = "int callee(void);\nint caller(void) { return callee(); }\n";
      const file = path.join(directory, "caller.c");
      writeFileSync(file, source);

      expect(await inThreadScanner.scan({ path: file })).toEqual(scanFileContent(source));
      expect(await inThreadScanner.scan({ text: source })).toEqual(scanFileContent(source));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
