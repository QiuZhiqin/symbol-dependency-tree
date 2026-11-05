import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { scanFileContent } from "./fileContent";
import type { ScanInput, ScanReply } from "./scanPool";

// Entry point of a ScanPool worker thread: reads and scans one file per message.
parentPort?.on("message", (input: ScanInput) => {
  let reply: ScanReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const source = "path" in input ? readFileSync(input.path).toString("utf8") : input.text;
    const content = scanFileContent(source);
    reply = { content };
    // The references' integers move to the extension host's thread uncopied.
    transfer = [content.calls.rows.buffer];
  } catch (error) {
    reply = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  parentPort?.postMessage(reply, transfer);
});
