import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { scanFileContent } from "./fileContent";
import type { ScanInput, ScanReply } from "./scanPool";

// Entry point of a ScanPool worker thread: reads and scans one file per message.
parentPort?.on("message", (input: ScanInput) => {
  let reply: ScanReply;
  try {
    const source = "path" in input ? readFileSync(input.path).toString("utf8") : input.text;
    reply = { content: scanFileContent(source) };
  } catch (error) {
    reply = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  parentPort?.postMessage(reply);
});
