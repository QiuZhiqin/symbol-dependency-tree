import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { scanFileContent, type FileContent } from "./fileContent";

/** A local file to read, or source text that was already read. */
export type ScanInput = { readonly path: string } | { readonly text: string };

/** Scans files into what the index stores for them. */
export interface FileScanner {
  scan(input: ScanInput): Promise<FileContent>;
  dispose(): void;
}

/** Scans on the calling thread, as unit tests and callers without workers do. */
export const inThreadScanner: FileScanner = {
  scan: async (input) =>
    scanFileContent("path" in input ? (await readFile(input.path)).toString("utf8") : input.text),
  dispose: () => undefined
};

export type ScanReply = { readonly content: FileContent } | { readonly error: string };

/** The part of a worker thread that the pool uses. */
export interface ScanWorker {
  postMessage(input: ScanInput): void;
  on(event: "message", listener: (reply: ScanReply) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

interface ScanTask {
  readonly input: ScanInput;
  resolve(content: FileContent): void;
  reject(error: Error): void;
}

/**
 * Files sent to each worker ahead of time: while the extension host's thread
 * writes and cannot hand out more work, a worker keeps scanning the files
 * already waiting in its queue. Eight kept two workers busy; more gained nothing.
 */
const tasksPerWorker = 8;

/**
 * Scans on up to `size` worker threads, so a rebuild scans in parallel and off
 * the extension host's thread. Workers start when files are queued and stop
 * after `idleMs` without work.
 */
export class ScanPool implements FileScanner {
  private readonly queue: ScanTask[] = [];
  /** Each worker with the tasks it was sent, in the order it answers them. */
  private readonly workers = new Map<ScanWorker, ScanTask[]>();
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  public constructor(
    private readonly size: number,
    private readonly createWorker: () => ScanWorker,
    private readonly idleMs = 30_000
  ) {}

  public scan(input: ScanInput): Promise<FileContent> {
    if (this.disposed) {
      return Promise.reject(new Error("The scan pool is disposed."));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.dispatch();
    });
  }

  public dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    const error = new Error("The scan pool is disposed.");
    for (const task of [...this.queue.splice(0), ...[...this.workers.values()].flat()]) {
      task.reject(error);
    }
    for (const worker of this.workers.keys()) {
      void worker.terminate();
    }
    this.workers.clear();
  }

  /** An idle worker, else a new one while below `size`, else the least busy one with room. */
  private nextWorker(): ScanWorker | undefined {
    let chosen: ScanWorker | undefined;
    let load = Number.POSITIVE_INFINITY;
    for (const [worker, tasks] of this.workers) {
      if (tasks.length < load) {
        chosen = worker;
        load = tasks.length;
      }
    }
    if (load === 0) {
      return chosen;
    }
    if (this.workers.size < this.size) {
      return this.start();
    }
    return load < tasksPerWorker ? chosen : undefined;
  }

  private dispatch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    while (this.queue.length > 0) {
      const worker = this.nextWorker();
      if (worker === undefined) {
        break;
      }
      const task = this.queue.shift()!;
      this.workers.get(worker)!.push(task);
      worker.postMessage(task.input);
    }
    if (this.workers.size > 0 && [...this.workers.values()].every((tasks) => tasks.length === 0)) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        for (const worker of this.workers.keys()) {
          void worker.terminate();
        }
        this.workers.clear();
      }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  private start(): ScanWorker {
    const worker = this.createWorker();
    this.workers.set(worker, []);
    worker.on("message", (reply) => {
      const task = this.workers.get(worker)?.shift();
      if (this.disposed || task === undefined) {
        return;
      }
      if ("content" in reply) {
        task.resolve(reply.content);
      } else {
        task.reject(new Error(reply.error));
      }
      this.dispatch();
    });
    // A worker that throws or exits on its own fails only the file it was
    // scanning; the files waiting behind it go to another worker.
    const lost = (error: Error): void => {
      const tasks = this.workers.get(worker);
      this.workers.delete(worker);
      if (this.disposed || tasks === undefined) {
        return;
      }
      const [scanning, ...waiting] = tasks;
      this.queue.unshift(...waiting);
      scanning?.reject(error);
      this.dispatch();
    };
    worker.on("error", lost);
    worker.on("exit", (code) => lost(new Error(`The scan worker stopped with exit code ${code}.`)));
    return worker;
  }
}

/**
 * A pool of `scanWorker.js` threads, leaving one core for the extension host.
 * Two workers roughly keep pace with the one thread that writes the index;
 * more cost memory for little time.
 */
export function createScanPool(): ScanPool {
  const script = path.join(__dirname, "scanWorker.js");
  return new ScanPool(
    Math.min(2, Math.max(1, availableParallelism() - 1)),
    () => new Worker(script)
  );
}
